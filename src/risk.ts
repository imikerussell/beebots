// The deterministic risk layer (hard rule 2: Jev chooses, code decides).
// Pure: no I/O, no clock, no randomness. Every veto, shrink and force says why.

import { maxNotionalUsd, minutesSince, positionNotional } from "./bees/common.js";
import type { Action, BeeBrain, BeeContext, CapReason, Intent } from "./bees/types.js";

export type { Action } from "./bees/types.js";

export interface Proposal {
  label: string;
  intent: Intent;
  /** Jev's probability for the chosen label. */
  prob: number;
  /** Conviction level, rounded to 0..3. */
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
  if (bee.tradesToday >= knobs.maxTradesPerDay) return { cap: "trade_cap", tripped: set("trade_cap") };
  if (bee.feesTodayUsd >= knobs.feeBudgetUsdDay) return { cap: "fee_budget", tripped: set("fee_budget") };
  return { cap: null, tripped: null };
}

/** Benched bees ride: only a stop (or the loss stop) closes the position before the 00:00 UTC reset. */
const riding = (ctx: BeeContext) => (ctx.bee.position ? `riding its ${ctx.bee.position.coin} until the stop or 00:00 UTC` : "back at 00:00 UTC");

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

  if (intent.kind === "add") {
    const p = bee.position!;
    const s = view.stats.get(p.instId);
    const inst = view.instruments.get(p.instId);
    if (!s || !inst) return { ok: false, why: "no_market_data" };
    if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${p.coin} ${s.spreadBp.toFixed(1)}bp` };
    const room = max - positionNotional(p, s.mid, inst.ctVal);
    const n = Math.min(intent.sizeFrac * maxNotionalUsd(ctx) * sizeMult, room);
    const minUsd = inst.minSz * inst.ctVal * s.mid;
    if (n < minUsd) return { ok: false, why: "size_cap" };
    return { ok: true, notionalUsd: n };
  }
  if (intent.kind !== "open" && intent.kind !== "switch") return { ok: false, why: "not_opening" };

  const s = view.stats.get(intent.instId);
  const inst = view.instruments.get(intent.instId);
  if (!s || !inst) return { ok: false, why: "no_market_data" };
  if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${s.coin} ${s.spreadBp.toFixed(1)}bp` };
  if (intent.side === "long" && brain.fundingVetoLongZ !== undefined && s.fundingZ !== null && s.fundingZ > brain.fundingVetoLongZ) {
    return { ok: false, why: `funding_veto ${s.coin} z=${s.fundingZ.toFixed(1)}` };
  }
  const frac = Math.max(0, Math.min(1, brain.sizeFrac(intent, conviction, ctx)));
  const n = Math.min(frac * max, max);
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
      return { kind: "trim", fraction: intent.fraction };
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
    if (s && p.stopPx !== null) {
      const hit = p.side === "long" ? s.mid <= p.stopPx : s.mid >= p.stopPx;
      if (hit) return out({ kind: "close", reason: "stop" }, { forcedBy: "stop", vetoedBy: proposal ? "stop" : null, status: `stopped out of ${p.coin}` });
    }
    const ts = brain.timeStopMinutes?.(ctx);
    if (ts !== undefined && minutesSince(p.openedAt, now) >= ts) {
      return out({ kind: "close", reason: "time_stop" }, { forcedBy: "time_stop", vetoedBy: proposal ? "time_stop" : null, status: `time stop on ${p.coin}` });
    }
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

  // 5. Opening gates.
  if (proposal && isOpening(intent)) {
    const dataStale = input.dataAgeMs > input.maxDataAgeMs;
    const cooldownLeft = bee.lastOrderAt === null ? 0 : knobs.cooldownMinutes - minutesSince(bee.lastOrderAt, now);
    if (cap === "trade_cap" || cap === "fee_budget") veto(cap);
    else if (dataStale) veto("stale_market_data");
    else if (brain.openGate && intent.kind !== "add" && (proposal.prob < brain.openGate.minProb(ctx) || proposal.conviction < brain.openGate.minConviction)) {
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
