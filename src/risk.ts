// Pure deterministic checks. Exits bypass entry counters, fees, spread and model availability.
import { minutesSince } from "./bees/common.js";
import type {
  Action,
  BeeBrain,
  BeeContext,
  CapReason,
  Intent,
} from "./bees/types.js";
import { contractsFor } from "./exec/sizing.js";
export type { Action } from "./bees/types.js";
export interface Proposal {
  label: string;
  intent: Intent;
  prob: number;
  conviction: number;
}
export type ModelStatus = "ok" | "unreachable" | "no_options";
export interface RiskInput {
  ctx: BeeContext;
  brain: BeeBrain;
  proposal: Proposal | null;
  modelStatus: ModelStatus;
  sizeMult: number;
  dataAgeMs: number;
  maxDataAgeMs: number;
}
export interface RiskResult {
  action: Action;
  vetoedBy: string | null;
  forcedBy: string | null;
  cap: CapReason | null;
  capTripped: CapReason | null;
  status: string;
}
export function evaluateCaps(ctx: BeeContext): {
  cap: CapReason | null;
  tripped: CapReason | null;
} {
  const { bee, cfg, knobs } = ctx,
    limits = cfg.cats[bee.id];
  let cap = bee.cap;
  if (
    bee.equityUsd <= (limits.startEquityUsd * cfg.risk.retireAtPct) / 100 ||
    cap === "retired"
  )
    cap = "retired";
  else if (
    bee.equityUsd <=
      bee.dayStartEquityUsd * (1 - limits.dailyLossStopPct / 100) ||
    cap === "loss_stop"
  )
    cap = "loss_stop";
  else if (bee.tradesToday >= knobs.maxTradesPerDay) cap = "trade_cap";
  else if (bee.feesTodayUsd >= knobs.feeBudgetUsdDay) cap = "fee_budget";
  return { cap, tripped: cap !== bee.cap ? cap : null };
}
export function freshTicker(ctx: BeeContext, instId: string): boolean {
  const t = ctx.view.tickers.get(instId);
  return (
    !!t &&
    [t.mid, t.bid, t.ask, t.ts].every(Number.isFinite) &&
    t.bid > 0 &&
    t.ask >= t.bid &&
    t.mid > 0 &&
    ctx.now - t.ts >= -1000 &&
    ctx.now - t.ts <= ctx.cfg.maxTickerAgeMs
  );
}
export function applyRisk(input: RiskInput): RiskResult {
  const { ctx, brain, proposal } = input,
    { bee, cfg, view, now } = ctx,
    p = bee.position;
  const limits = cfg.cats[bee.id];
  const { cap, tripped } = evaluateCaps(ctx);
  const out = (
    action: Action,
    status: string,
    vetoedBy: string | null = null,
    forcedBy: string | null = null,
  ): RiskResult => ({
    action,
    status,
    vetoedBy,
    forcedBy,
    cap,
    capTripped: tripped,
  });
  const veto = (why: string) => out({ kind: "none" }, why, why);
  if (p && !freshTicker(ctx, p.instId)) return veto("stale_exit_market_data");
  if (cap === "loss_stop" || cap === "retired")
    return p ? out({ kind: "close", reason: cap }, cap, null, cap) : veto(cap);
  if (p) {
    const mid = view.tickers.get(p.instId)!.mid;
    if (p.stopPx === null || !Number.isFinite(p.stopPx))
      return out(
        { kind: "close", reason: "missing_stop" },
        "missing_stop",
        null,
        "missing_stop",
      );
    if (p.side === "long" ? mid <= p.stopPx : mid >= p.stopPx)
      return out({ kind: "close", reason: "stop" }, "stop", null, "stop");
    const time = brain.timeStopMinutes?.(ctx);
    if (time !== undefined && minutesSince(p.openedAt, now) >= time)
      return out(
        { kind: "close", reason: "time_stop" },
        "time_stop",
        null,
        "time_stop",
      );
  }
  if (p) {
    const reason = brain.protectiveExit?.(ctx);
    if (reason) return out({ kind: "close", reason }, reason, null, reason);
  }
  if (input.modelStatus === "unreachable")
    return veto("model_unavailable");
  if (!proposal || proposal.intent.kind === "hold")
    return out(
      { kind: "none" },
      proposal?.label ?? "protective check: no stop triggered",
    );
  const intent = proposal.intent;
  if (intent.kind === "close")
    return p
      ? out({ kind: "close", reason: intent.reason }, proposal.label)
      : veto("invalid_while_flat");
  if (intent.kind === "trim")
    return p && intent.fraction > 0 && intent.fraction <= 1
      ? out({ kind: "trim", fraction: intent.fraction }, proposal.label)
      : veto("invalid_trim");
  if (intent.kind !== "open") return veto("adds_and_switches_disabled");
  if (p) return veto("one_position_limit");
  if (cap) return veto(cap);
  if (
    !Number.isFinite(proposal.prob) ||
    !Number.isFinite(proposal.conviction) ||
    proposal.prob < limits.minActionProbability ||
    proposal.prob > 1 ||
    proposal.conviction < limits.minConviction ||
    proposal.conviction > 3
  )
    return veto("weak_or_invalid_conviction");
  if (input.dataAgeMs > input.maxDataAgeMs || !freshTicker(ctx, intent.instId))
    return veto("stale_market_data");
  if (
    minutesSince(bee.lastEntryAt ?? bee.lastOrderAt, now) <
      limits.cooldownMinutes &&
    (bee.lastEntryAt ?? bee.lastOrderAt) !== null
  )
    return veto("entry_cooldown");
  const s = view.stats.get(intent.instId),
    inst = view.instruments.get(intent.instId),
    t = view.tickers.get(intent.instId);
  if (
    !s ||
    !inst ||
    !t ||
    inst.kind !== "crypto" ||
    inst.state !== "live" ||
    !cfg.slots[bee.id].coins.includes(inst.coin)
  )
    return veto("instrument_not_allowed");
  if (limits.longOnly && intent.side !== "long") return veto("long_only");
  if (!Number.isFinite(t.spreadBp) || t.spreadBp > limits.spreadGateBps)
    return veto("spread_gate");
  if (!Number.isFinite(t.vol24hUsd) || t.vol24hUsd < limits.minVolumeUsd)
    return veto("liquidity_gate");
  if (s.refreshedAt !== undefined && now - s.refreshedAt > input.maxDataAgeMs)
    return veto("stale_indicators");
  const currentMenu = brain.menu(ctx);
  const stillValid = Object.values(currentMenu).some(
    (o) =>
      o.intent.kind === "open" &&
      o.intent.instId === intent.instId &&
      o.intent.side === intent.side,
  );
  if (!stillValid) return veto("setup_no_longer_valid");
  const slip = cfg.paperSlippageBps / 10000;
  const px = intent.side === "long" ? t.ask * (1 + slip) : t.bid * (1 - slip);
  const stop = brain.stopFor(intent.instId, intent.side, px, ctx);
  if (
    stop === null ||
    !Number.isFinite(stop) ||
    stop <= 0 ||
    (intent.side === "long" ? stop >= px : stop <= px)
  )
    return veto("invalid_initial_stop");
  // Reserve both entry and estimated exit fees as well as stop loss in the risk budget.
  const perUnitRisk = Math.abs(px - stop) + (px + stop) * cfg.risk.takerFeeRate;
  const equity = Math.min(bee.equityUsd, bee.cashUsd);
  const strategyFrac = brain.sizeFrac(intent, proposal.conviction, ctx);
  if (!Number.isFinite(strategyFrac) || strategyFrac <= 0 || strategyFrac > 1 ||
      !Number.isFinite(input.sizeMult) || input.sizeMult <= 0 || input.sizeMult > 1)
    return veto("invalid_strategy_size");
  const notionalCap = ((equity * limits.maxNotionalPct) / 100) * input.sizeMult * strategyFrac;
  const riskCap =
    ((((equity * limits.stopRiskPct) / 100) * input.sizeMult) / perUnitRisk) *
    px;
  const capitalCap =
    Math.max(0, bee.cashUsd) /
    (1 / cfg.risk.maxLeverage + 2 * cfg.risk.takerFeeRate);
  const notional = Math.min(notionalCap, riskCap, capitalCap);
  const contracts = contractsFor(notional, inst, px);
  if (!(contracts > 0)) return veto("below_exchange_minimum");
  return out(
    {
      kind: "open",
      instId: intent.instId,
      side: intent.side,
      notionalUsd: contracts * inst.ctVal * px,
    },
    proposal.label,
  );
}
