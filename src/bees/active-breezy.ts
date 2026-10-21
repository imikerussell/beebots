// Configurable Donchian strategy. breezy.ts preserves the historical source brain.
import { breezy } from "./breezy.js";
import { currentSignalBar, decisionBarKey, maxNotionalUsd, positionNotional, roundTripCostPct } from "./common.js";
import { profitReviewKey, profitReviewMenu } from "./profit-management.js";
import type { CoinStats } from "../market/types.js";
import type { BeeBrain, BeeContext, Intent, Menu } from "./types.js";

export function trendEntryBlockers(s: CoinStats, ctx: BeeContext): string[] {
  const age = ctx.now - (s.refreshedAt ?? ctx.view.ts), limits = ctx.cfg.cats[ctx.bee.id];
  if (age < 0 || age > 3 * ctx.cfg.dataRefreshMs) return ["stale_indicators"];
  const reasons: string[] = [];
  if (!currentSignalBar(s,ctx,240)) reasons.push("missing_confirmed_entry_close");
  if (!ctx.cfg.slots[ctx.bee.id].coins.includes(s.coin)) reasons.push("coin_not_allowed");
  if (!ctx.view.gated.includes(s.instId)) reasons.push("market_universe_gate");
  if (!(s.vol24hUsd >= limits.minVolumeUsd)) reasons.push("liquidity_gate");
  if (!(s.spreadBp <= limits.spreadGateBps)) reasons.push("spread_gate");
  if (!s.trend) return [...reasons, "missing_trend_data"];
  if (s.trend.slicesAvailable < 9) reasons.push("incomplete_trend_history");
  if (!Number.isFinite(s.trend.score) || Math.abs(s.trend.score) < ctx.cfg.strategies.mochi.minTrendScore) reasons.push("minTrendScore");
  if (!(s.trend.atr4hPct! > 0) || !Number.isFinite(s.trend.atr4hPct) || s.trend.atr4hPct! * limits.stopAtrMult >= 100) reasons.push("missing_atr_stop");
  if (!(s.trend.rv90Pct! > 0) || !Number.isFinite(s.trend.rv90Pct)) reasons.push("invalid_volatility_size");
  if (s.trend.trailStop !== null && (s.trend.score > 0 ? s.mid <= s.trend.trailStop : s.mid >= s.trend.trailStop))
    reasons.push("trend_stop_crossed");
  if (s.trend.atr4hPct! * limits.stopAtrMult < limits.minStopCostRatio*roundTripCostPct(s,ctx)) reasons.push("move_too_small_after_costs");
  const close=s.confirmed4h?.close;
  if (close && (s.trend.score > 0 ? 1 : -1)*(s.mid-close)/close*100 > limits.maxEntryChaseAtr*s.trend.atr4hPct!) reasons.push("price_extended");
  return reasons;
}

export function trendSizeFrac(s: CoinStats, ctx: BeeContext): number {
  const max = maxNotionalUsd(ctx), t = s.trend;
  if (!t || !(t.rv90Pct! > 0) || !Number.isFinite(t.rv90Pct) || !(max > 0)) return 0;
  return Math.max(0, Math.min(1, Math.abs(t.score) / 9,
    ctx.bee.equityUsd * ctx.cfg.strategies.mochi.volTargetPct / t.rv90Pct! / max));
}

export const activeBreezy: BeeBrain = {
  ...breezy,
  strategy: "Follow the nine Donchian channels on completed four-hour BTC/ETH candles. Evaluate the qualified trend-direction candidate against WAIT once per signal bar. While invested, profit reviews can occur between signal bars. Compare HOLD_WINNER with CLOSE_PROFIT or optional TAKE_PROFIT when offered: hold persistent trends, reduce or close a winner when trend evidence weakens or estimated net profit gives back from its peak. Judge net profit after estimated costs, not gross returns alone. ADD_TO_WINNER only above +1R within the target and risk budget, before any profit-taking or score-deterioration trim. TRIM_HALF reduces exposure once after the configured score deterioration; do not buy it back. Code independently enforces trend invalidation, cost-covering stops, channel and ATR trailing stops, peak-profit protection and maximum holding time, even if you HOLD or inference is unavailable. Choice probabilities are relative menu weights, not calibrated win probabilities; exits use their configured probability threshold without the entry conviction gate, and do not require certainty.",
  openGate: undefined,
  entryGate: ctx => ({ minConviction: ctx.cfg.cats[ctx.bee.id].minConviction, minProb: ctx.cfg.cats[ctx.bee.id].minActionProbability }),
  neverForce: true,
  decisionKey: ctx => decisionBarKey(ctx,240),
  profitProtection: true,
  managementKey: profitReviewKey,
  exitGate: ctx => ({ minProb: ctx.cfg.exits[ctx.bee.id].minActionProbability }),
  forcedEntry: () => null,
  rebalance: undefined,
  timeStopMinutes: ctx => ctx.cfg.strategies.mochi.maxHoldMinutes,
  universe: ctx => [...ctx.view.stats.values()].filter(s => trendEntryBlockers(s, ctx).length === 0).map(s => s.instId),
  menu(ctx) {
    const m: Menu = {}, p = ctx.bee.position;
    const eligible = [...ctx.view.stats.values()].filter(s => trendEntryBlockers(s, ctx).length === 0);
    const entry = (s: CoinStats): Intent => ({ kind:"open", instId: s.instId,
      side: s.trend!.score > 0 ? "long" : "short", sizeFrac: trendSizeFrac(s, ctx), setup: "strict" });
    if (!p) {
      for (const s of eligible.sort((a,b)=>Math.abs(b.trend!.score)-Math.abs(a.trend!.score)).slice(0,ctx.cfg.cats[ctx.bee.id].maxEntryCandidates))
        m[`${s.trend!.score > 0 ? "LONG" : "SHORT"}_${s.coin}`] = { desc: null, intent: entry(s) };
      if (eligible.length) m.WAIT = { desc: "no convincing entry after costs", intent: { kind: "hold" } };
      return m;
    }
    m.HOLD_WINNER = { desc: "keep position", intent: { kind: "hold" } };
    const cur = ctx.view.stats.get(p.instId), inst = ctx.view.instruments.get(p.instId);
    const fresh = cur && currentSignalBar(cur,ctx,240);
    const failedTrend = fresh && cur.trend && (p.side === "long" ? 1 : -1)*cur.trend.score <= 0;
    if (failedTrend) {
      m.CLOSE = {desc:"completed-bar trend lost its direction",intent:{kind:"close",reason:"trend_exit"}};
      return m;
    }
    Object.assign(m, profitReviewMenu(ctx));
    if (fresh && cur.trend && p.entryScore !== undefined && !p.trendTrimmed) {
      const dir = p.side === "long" ? 1 : -1;
      if (dir * cur.trend.score <= dir * p.entryScore - ctx.cfg.strategies.mochi.trimScoreDrop)
        m.TRIM_HALF = { desc: "one score-deterioration trim per position", intent: { kind: "trim", fraction: 0.5 } };
    }
    if (!p.trendTrimmed && !p.profitTaken && !m.TRIM_HALF && !m.TAKE_PROFIT && (ctx.uplR ?? 0) > 1 && cur && inst && eligible.includes(cur) &&
      (p.side === "long" ? cur.trend!.score > 0 : cur.trend!.score < 0)) {
      const max = maxNotionalUsd(ctx), gap = trendSizeFrac(cur, ctx) * max - positionNotional(p, cur.mid, inst.ctVal);
      if (gap >= inst.minSz * inst.ctVal * cur.mid)
        m.ADD_TO_WINNER = { desc: "add toward trend/volatility target", intent: { kind: "add", sizeFrac: Math.min(1 / 9, gap / max) } };
    }
    return m;
  },
  sizeFrac: intent => intent.sizeFrac,
  protectiveExit(ctx) {
    const p = ctx.bee.position, s = p ? ctx.view.stats.get(p.instId) : undefined;
    const age = s ? ctx.now - (s.refreshedAt ?? ctx.view.ts) : Infinity;
    if (!p || !s?.trend || age < 0 || age > 3 * ctx.cfg.dataRefreshMs || !currentSignalBar(s,ctx,240)) return null;
    return (p.side === "long" ? 1 : -1) * s.trend.score <= 0 ? "trend_reversal" : null;
  },
};
