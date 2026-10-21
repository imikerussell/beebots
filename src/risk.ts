// The deterministic risk layer (hard rule 2: Jev chooses, code decides).
// Pure: no I/O, no clock, no randomness. Every veto, shrink and force says why.

import { entriesUsed, maxNotionalUsd, minutesSince, positionNotional } from "./bees/common.js";
import { profitReviewMenu } from "./bees/profit-management.js";
import type { Action, BeeBrain, BeeContext, CapReason, Intent } from "./bees/types.js";

export type { Action } from "./bees/types.js";

export interface Proposal {
  label: string;
  intent: Intent;
  /** Jev's probability for the chosen label. */
  prob: number;
  /** Expected rubric score in [0,3]; preserve fractional provider values. */
  conviction: number;
}

/** "no_options": the menu was empty, so Jev was not asked (forcing rules still apply). */
export type JevStatus = "ok" | "unreachable" | "daily_cap" | "no_options";

export interface RiskInput {
  ctx: BeeContext;
  brain: BeeBrain;
  /** null when Jev was not asked or did not answer. */
  proposal: Proposal | null;
  jev: JevStatus;
  /** 1, or LIVE_SIZE_MULTIPLIER during the live ramp. */
  sizeMult: number;
  /** Age of the last full market refresh. */
  dataAgeMs: number;
  maxDataAgeMs: number;
}

export interface RiskResult {
  action: Action;
  /** Why Jev's choice was not followed as-is. */
  vetoedBy: string | null;
  /** Code forced this action (stop, cap, max-flat...). */
  forcedBy: string | null;
  /** The bee's cap after this check. */
  cap: CapReason | null;
  /** Cap that tripped on this tick (fire an alert + banner). */
  capTripped: CapReason | null;
  /** One line for the dashboard. */
  status: string;
}

const nowInvalid = (now: number, ts: number, maxAge: number) => !Number.isFinite(ts) || now < ts || now - ts > maxAge;

const NONE: Action = { kind: "none" };
const isOpening = (i: Intent) => i.kind === "open" || i.kind === "switch" || i.kind === "add";

/** Cap state for a bee, and whether one newly tripped. Caps only escalate within a day. */
export function evaluateCaps(ctx: BeeContext): { cap: CapReason | null; tripped: CapReason | null } {
  const { bee, cfg, knobs } = ctx;
  let cap = bee.cap;
  const set = (c: CapReason) => {
    const tripped = cap === c ? null : c;
    cap = c;
    return tripped;
  };
  if (cap === "retired") return { cap, tripped: null };
  if (bee.equityUsd <= cfg.risk.startEquityUsd * (cfg.risk.retireAtPct / 100)) return { cap: "retired", tripped: set("retired") };
  if (cap === "loss_stop") return { cap, tripped: null };
  if (bee.equityUsd <= bee.dayStartEquityUsd * (1 - cfg.risk.dailyLossStopPct / 100)) return { cap: "loss_stop", tripped: set("loss_stop") };
  if (cap) return { cap, tripped: null };
  if (entriesUsed(bee) >= knobs.maxTradesPerDay) return { cap: "trade_cap", tripped: set("trade_cap") };
  if (bee.feesTodayUsd >= knobs.feeBudgetUsdDay) return { cap: "fee_budget", tripped: set("fee_budget") };
  return { cap: null, tripped: null };
}

/** Entry caps never prevent reductions or protective exits. */
const riding = (ctx: BeeContext) => (ctx.bee.position ? `managing its ${ctx.bee.position.coin}; exits remain active` : "back at 00:00 UTC");

export function capStatus(cap: CapReason, ctx: BeeContext): string {
  switch (cap) {
    case "retired":
      return "retired for good (equity below the retire line)";
    case "loss_stop":
      return "sent home: daily loss stop, flat until 00:00 UTC";
    case "trade_cap":
      return `benched: all ${ctx.knobs.maxTradesPerDay} trade${ctx.knobs.maxTradesPerDay === 1 ? "" : "s"} used today, ${riding(ctx)}`;
    case "fee_budget":
      return `benched: fee budget gone ($${ctx.bee.feesTodayUsd.toFixed(2)} of $${ctx.knobs.feeBudgetUsdDay.toFixed(2)}), ${riding(ctx)}`;
  }
}

interface OpenCheck {
  ok: boolean;
  why?: string;
  notionalUsd?: number;
}

/** Spread gate, funding veto, min size and the size cap for an open/switch/add. */
function checkOpen(intent: Intent, input: RiskInput, conviction: number): OpenCheck {
  const { ctx, brain, sizeMult } = input;
  const { bee, view, knobs } = ctx;
  const max = maxNotionalUsd(ctx) * sizeMult;
  if (!(max > 0)) return { ok: false, why: "no_equity" };
  const marketVeto = (s: NonNullable<ReturnType<typeof view.stats.get>>) => {
    if (ctx.cfg.strategyEngine !== "upstream") return null;
    const t = view.tickers.get(s.instId), refreshed = s.refreshedAt ?? view.ts;
    if (!t || nowInvalid(ctx.now, t.ts, ctx.cfg.maxTickerAgeMs)) return "stale_market_data";
    if (nowInvalid(ctx.now, refreshed, 3 * ctx.cfg.dataRefreshMs)) return "stale_indicators";
    if (!view.gated.includes(s.instId) || !(s.vol24hUsd >= (ctx.cfg.cats[bee.id]?.minVolumeUsd ?? ctx.cfg.universe.min24hVolUsd))) return "liquidity_gate";
    return null;
  };

  // Current strategies budget the potential stop loss, including estimated round-trip costs.
  // The estimate is not a guaranteed loss ceiling: gaps/slippage can exceed it.
  const riskSize = (s: NonNullable<ReturnType<typeof view.stats.get>>, side: "long" | "short", existing = 0) => {
    const limits = ctx.cfg.cats[bee.id];
    if (!limits) return 0;
    const stop = intent.kind === "add" ? bee.position?.stopPx : brain.stopFor(s.instId, side, s.mid, ctx);
    if (stop == null || !Number.isFinite(stop) || !(stop > 0)) return 0;
    const lossFraction = Math.max(0, (side === "long" ? s.mid - stop : stop - s.mid) / s.mid);
    if (intent.kind !== "add" && !(lossFraction > 0)) return 0;
    const costs = 2 * ctx.cfg.risk.takerFeeRate + s.spreadBp / 10000 + 2 * ctx.cfg.paperSlippageBps / 10000;
    const budget = bee.equityUsd * limits.stopRiskPct / 100;
    return Math.max(0, budget - existing) / Math.max(1e-9, lossFraction + costs);
  };

  if (intent.kind === "add") {
    const p = bee.position!;
    if (p.profitTaken) return { ok: false, why: "profit_already_taken" };
    const s = view.stats.get(p.instId);
    const inst = view.instruments.get(p.instId);
    if (!s || !inst) return { ok: false, why: "no_market_data" };
    const veto = marketVeto(s);
    if (veto) return { ok: false, why: veto };
    if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${p.coin} ${s.spreadBp.toFixed(1)}bp` };
    const room = max - positionNotional(p, s.mid, inst.ctVal);
    const existingRisk = p.stopPx == null ? Infinity : Math.max(0, (p.side === "long" ? 1 : -1) * (p.entryPx - p.stopPx)) * p.contracts * inst.ctVal
      + positionNotional(p, s.mid, inst.ctVal) * ctx.cfg.risk.takerFeeRate;
    const n = Math.min(intent.sizeFrac * maxNotionalUsd(ctx) * sizeMult, room, riskSize(s, p.side, existingRisk));
    const minUsd = inst.minSz * inst.ctVal * s.mid;
    if (n < minUsd) return { ok: false, why: "size_cap" };
    return { ok: true, notionalUsd: n };
  }
  if (intent.kind !== "open" && intent.kind !== "switch") return { ok: false, why: "not_opening" };

  const s = view.stats.get(intent.instId);
  const inst = view.instruments.get(intent.instId);
  if (!s || !inst) return { ok: false, why: "no_market_data" };
  const veto = marketVeto(s);
  if (veto) return { ok: false, why: veto };
  if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${s.coin} ${s.spreadBp.toFixed(1)}bp` };
  if (intent.side === "long" && brain.fundingVetoLongZ !== undefined && s.fundingZ !== null && s.fundingZ > brain.fundingVetoLongZ) {
    return { ok: false, why: `funding_veto ${s.coin} z=${s.fundingZ.toFixed(1)}` };
  }
  const frac = Math.max(0, Math.min(1, brain.sizeFrac(intent, conviction, ctx)));
  const n = Math.min(frac * max, max, riskSize(s, intent.side));
  const minUsd = inst.minSz * inst.ctVal * s.mid;
  if (n < minUsd) return { ok: false, why: `below_min_size ${s.coin} $${n.toFixed(2)} < $${minUsd.toFixed(2)}` };
  return { ok: true, notionalUsd: n };
}

function toAction(intent: Intent, notionalUsd?: number): Action {
  switch (intent.kind) {
    case "hold":
      return NONE;
    case "close":
      return { kind: "close", reason: intent.reason };
    case "trim":
      return { kind: "trim", fraction: intent.fraction, ...(intent.reason ? { reason: intent.reason } : {}) };
    case "add":
      return { kind: "add", notionalUsd: notionalUsd! };
    case "open":
      return { kind: "open", instId: intent.instId, side: intent.side, notionalUsd: notionalUsd! };
    case "switch":
      return { kind: "switch", instId: intent.instId, side: intent.side, notionalUsd: notionalUsd! };
  }
}

export function applyRisk(input: RiskInput): RiskResult {
  const { ctx, brain, proposal, jev } = input;
  const { bee, view, knobs, now } = ctx;
  const p = bee.position;
  const { cap, tripped } = evaluateCaps(ctx);
  const out = (action: Action, extra: Partial<RiskResult> & { status: string }): RiskResult => ({
    action,
    vetoedBy: null,
    forcedBy: null,
    cap,
    capTripped: tripped,
    ...extra,
  });

  // 1. Retired / daily loss stop: go flat and stay flat. Forcing is suspended.
  if (cap === "retired" || cap === "loss_stop") {
    const status = capStatus(cap, ctx);
    if (p) return out({ kind: "close", reason: cap }, { forcedBy: cap, vetoedBy: proposal ? cap : null, status });
    return out(NONE, { vetoedBy: proposal ? cap : null, status });
  }

  // 2. Code stops fire whatever Jev says, and even when Jev is down.
  if (p) {
    const s = view.stats.get(p.instId);
    const t = view.tickers.get(p.instId);
    const stopMid = (brain.profitProtection || ctx.cfg.strategyEngine === "upstream")
      ? t && Number.isFinite(t.mid) && t.mid > 0 && now >= t.ts && now - t.ts <= ctx.cfg.maxTickerAgeMs ? t.mid : null
      : s?.mid;
    if (stopMid != null && p.stopPx !== null) {
      const hit = p.side === "long" ? stopMid <= p.stopPx : stopMid >= p.stopPx;
      if (hit) return out({ kind: "close", reason: "stop" }, { forcedBy: "stop", vetoedBy: proposal ? "stop" : null, status: `stopped out of ${p.coin}` });
    }
    const ts = brain.timeStopMinutes?.(ctx);
    if (ts !== undefined && minutesSince(p.openedAt, now) >= ts) {
      return out({ kind: "close", reason: "time_stop" }, { forcedBy: "time_stop", vetoedBy: proposal ? "time_stop" : null, status: `time stop on ${p.coin}` });
    }
    const exit = brain.protectiveExit?.(ctx);
    if (exit) return out({ kind: "close", reason: exit }, { forcedBy: exit, status: exit });
  }

  // 3. Jev fail-closed: hold whatever we have, open nothing.
  if (jev === "daily_cap") return out(NONE, { vetoedBy: "jev_daily_cap", status: "Jev daily cap hit: all bees hold" });
  if (jev === "unreachable" || (jev === "ok" && !proposal)) return out(NONE, { vetoedBy: "jev_unreachable", status: "Jev unreachable: holding" });

  let intent: Intent = proposal?.intent ?? { kind: "hold" };
  let vetoedBy: string | null = null;
  let notionalUsd: number | undefined;
  const veto = (why: string) => {
    vetoedBy = why;
    intent = { kind: "hold" };
  };

  // 4. Menu sanity: the intent must fit the position we actually have.
  if (!p && intent.kind !== "open" && intent.kind !== "hold") veto("invalid_while_flat");
  if (p && intent.kind === "open") veto("invalid_while_positioned");
  if (p && intent.kind === "switch" && intent.instId === p.instId && intent.side === p.side) veto("switch_to_same");

  // Reducing choices have their own label threshold. Entry conviction is not an exit veto.
  if (proposal && (intent.kind === "close" || intent.kind === "trim")) {
    const gate = brain.exitGate?.(ctx);
    if (gate && (!Number.isFinite(proposal.prob) || proposal.prob < gate.minProb))
      veto(`weak_exit_probability p=${proposal.prob.toFixed(2)}`);
    else if ((intent.kind === "close" && intent.reason === "model_profit_take") ||
      (intent.kind === "trim" && intent.reason === "profit_take")) {
      const current = profitReviewMenu(ctx)[proposal.label]?.intent;
      if (!current || JSON.stringify(current) !== JSON.stringify(intent)) veto("profit_exit_no_longer_eligible");
    }
  }

  // 5. Opening gates.
  if (proposal && isOpening(intent)) {
    const gate = brain.entryGate?.(ctx) ?? (brain.openGate ? { minConviction: brain.openGate.minConviction, minProb: brain.openGate.minProb(ctx) } : null);
    const dataStale = input.dataAgeMs > input.maxDataAgeMs;
    const cooldownLeft = bee.lastOrderAt === null ? 0 : knobs.cooldownMinutes - minutesSince(bee.lastOrderAt, now);
    if (cap === "trade_cap" || cap === "fee_budget") veto(cap);
    else if (dataStale) veto("stale_market_data");
    else if (gate && intent.kind !== "add" && (proposal.prob < gate.minProb || proposal.conviction < gate.minConviction)) {
      veto(`weak_conviction p=${proposal.prob.toFixed(2)} c=${proposal.conviction}`);
    } else if (brain.requiresStrictSetup && (intent.kind === "open" || intent.kind === "switch") && intent.setup === "loose") veto("no_setup_yet");
    else if (cooldownLeft > 0) veto(`cooldown ${Math.ceil(cooldownLeft)}m`);
    else {
      const c = checkOpen(intent, input, proposal.conviction);
      if (c.ok) notionalUsd = c.notionalUsd;
      else veto(c.why!);
    }
  }

  let action = toAction(intent, notionalUsd);
  let forcedBy: string | null = null;
  let status = !proposal ? (brain.idleStatus?.(ctx) ?? "no valid options") : vetoedBy ? `wanted ${proposal.label}, code said no: ${vetoedBy}` : proposal.label;

  // 6. Never flat for long (drama rule 2). Suspended while any cap is active or data is stale.
  if (!p && action.kind === "none") {
    const flatMin = minutesSince(bee.flatSince, now);
    if (cap) status = capStatus(cap, ctx);
    else if (input.dataAgeMs > input.maxDataAgeMs) status = "stale market data: waiting";
    else if (brain.neverForce) {
      /* waits for its own setup; status already says what it is waiting for */
    } else if (flatMin >= knobs.maxFlatMinutes) {
      const f = brain.forcedEntry(ctx);
      const c = f ? checkOpen(f, input, 0) : { ok: false, why: "no_candidate" };
      if (f && c.ok) {
        action = toAction(f, c.notionalUsd);
        forcedBy = "max_flat";
        status = `forced in after ${flatMin.toFixed(0)} min flat`;
      } else status = `flat, cannot force: ${c.why}`;
    } else status = `${status} (flat ${flatMin.toFixed(0)}/${knobs.maxFlatMinutes} min)`;
  }
  if (p && action.kind === "none" && cap) status = capStatus(cap, ctx);

  // 7. Sizing is code's job: when Jev holds an undersized position, bring it back to target (not while capped or stale).
  if (p && action.kind === "none" && !cap && brain.rebalance && input.dataAgeMs <= input.maxDataAgeMs) {
    const add = brain.rebalance(ctx);
    const c = add ? checkOpen(add, input, 0) : null;
    if (add && c?.ok) {
      action = toAction(add, c.notionalUsd);
      forcedBy = "rebalance";
      status = `sized up to target (+$${c.notionalUsd!.toFixed(0)})`;
    }
  }

  return { action, vetoedBy, forcedBy, cap, capTripped: tripped, status };
}
