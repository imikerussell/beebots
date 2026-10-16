import { trendEntryBlockers } from "./bees/active-breezy.js";
import { entriesUsed, roundTripCostPct } from "./bees/common.js";
import { activeEntryBlockers, activeSide, momentumThreshold } from "./bees/active-bizzy.js";
// Cat identity is an adapter. Trading behavior lives in the strategy brains.
import { BRAINS } from "./bees/index.js";
import { customBrain } from "./bees/custom.js";
import type { BeeBrain, BeeContext } from "./bees/types.js";
import type { BeeId, Config } from "./config.js";
import type { CoinStats } from "./market/types.js";

export function catBrain(id: BeeId, cfg: Config): BeeBrain {
  const profile = cfg.slots[id];
  return customBrain(BRAINS[profile.style], { rules: profile.rules, coins: profile.coins });
}

export function strategyFacts(id: BeeId, cfg: Config): string[] {
  const l = cfg.cats[id];
  const t = cfg.strategies.tiger;
  return [
    id === "tiger"
      ? `${t.signalMode} on ${cfg.slots[id].coins.join(" / ")}, long and short. ${t.signalMode === "trend_breakout"
        ? `Completed 15-minute close must break the prior ${t.entryBars}-bar high/low, aligned with hourly close and EMA ${t.fastHours}/${t.slowHours}. Exit on the prior ${t.exitBars}-bar opposite channel or opposite hourly regime.`
        : `One-hour movement must exceed max(${t.minMomentumPct}%, ${t.momentumAtrMult} x 15-minute ATR%) in its direction, with MACD confirming.${t.signalMode === "trend_momentum" ? ` Hourly close and EMA ${t.fastHours}/${t.slowHours} must agree.` : ""} Exit when both return and MACD oppose the position.`}`
      : "BTC / ETH, long and short. Nine Donchian channels (5, 10, 20, 30, 60, 90, 150, 250, 360) on completed 4-hour candles. Code exits when the signed trend score reaches zero or reverses. Adds require a winner above +1R; trims occur once per position.",
    id === "tiger"
      ? `Entry size respects the stop-risk budget. Initial stop ${l.stopAtrMult} x 15-minute ATR from entry, trailing after +1R. Maximum hold ${t.maxHoldMinutes} minutes. No forced entries or immediate model flips.`
      : `Size by absolute score / 9, capped at ${cfg.strategies.mochi.volTargetPct}% annualized volatility and the stop-risk budget. Enter only with absolute trend score >= ${cfg.strategies.mochi.minTrendScore}; WAIT is valid. Trim once after a ${cfg.strategies.mochi.trimScoreDrop}-point decline; no automatic buyback. Maximum hold ${cfg.strategies.mochi.maxHoldMinutes} minutes.`,
    `At most one model decision per completed ${id === "tiger" ? "15-minute" : "4-hour"} signal bar, persisted across restart. Offer the top ${l.maxEntryCandidates} eligible candidate(s) plus WAIT. Stop distance must cover ${l.minStopCostRatio} x estimated round-trip costs; adverse entry chase <= ${l.maxEntryChaseAtr} ATR. These filters do not establish an expected profit.`,
    `Maximum leverage ${cfg.risk.maxLeverage}x, with 3% margin headroom and a $${cfg.risk.maxNotionalUsdPerBee} absolute notional ceiling. Explicit per-cat notional cap: ${l.maxNotionalPct}% of equity.`,
    `Entry conviction >= ${l.minConviction} on a continuous 0..3 scale; chosen-action probability >= ${l.minActionProbability}. Estimated stop loss plus costs <= ${l.stopRiskPct}% of equity.`,
    `${l.maxTradesPerDay} new positions per UTC day, $${l.feeBudgetUsdDay} daily fee budget, ${l.cooldownMinutes}-minute discretionary opening cooldown, ${l.dailyLossStopPct}% daily loss stop. Stop decisions are deterministic and run within the trading tick.`,
  ];
}

/** Diagnostics describe source requirements; they never impose extra entry conditions. */
export function entryBlockers(id: BeeId, s: CoinStats, ctx: BeeContext): string[] {
  const reasons: string[] = [], l = ctx.cfg.cats[id];
  if (id === "tiger") {
    const blockers = activeEntryBlockers(s, ctx);
    if (entriesUsed(ctx.bee) >= l.maxTradesPerDay) blockers.push("trade_cap");
    return blockers;
  }
  reasons.push(...trendEntryBlockers(s, ctx));
  if (entriesUsed(ctx.bee) >= l.maxTradesPerDay) reasons.push("trade_cap");
  return reasons;
}

export function entryDiagnostics(id: BeeId, ctx: BeeContext) {
  return ctx.cfg.slots[id].coins.map(coin => {
    const s = [...ctx.view.stats.values()].find(s => s.coin === coin);
    const instId = s?.instId ?? [...ctx.view.instruments.values()].find(i => i.coin === coin)?.instId;
    const error = ctx.view.refreshError ?? (instId ? ctx.view.dataErrors?.get(instId) : null);
    const limits = ctx.cfg.cats[id], entryMinutes = id === "tiger" ? 15 : 240;
    const confirmed = id === "tiger" ? s?.confirmed15m : s?.confirmed4h;
    const atrPct = (id === "tiger" ? s?.atr14Pct : s?.trend?.atr4hPct) ?? null;
    const costs = s ? roundTripCostPct(s,ctx) : null;
    const side = s ? id === "tiger" ? activeSide(s,ctx) : s.trend?.score ? s.trend.score > 0 ? "long" : "short" : null : null;
    return { coin, blockers: s ? entryBlockers(id, s, ctx) : ["missing_market_data"],
      indicatorsAgeMs: s ? ctx.now - (s.refreshedAt ?? ctx.view.ts) : null,
      maxIndicatorsAgeMs: 3 * ctx.cfg.dataRefreshMs,
      feedError: error?.message ?? null, feedErrorAt: error?.at ?? null,
      mid: s?.mid ?? null, spreadBps: s?.spreadBp ?? null, maxSpreadBps: ctx.knobs.spreadGateBps,
      momentumPct: s?.ret1hPct ?? null, momentumMinutes: 60,
      minMomentumPct: s && id === "tiger" ? momentumThreshold(s, ctx) : null, macdHistPct: s?.macdHistPct ?? null,
      signalSide: side, signalMode: id === "tiger" ? ctx.cfg.strategies.tiger.signalMode : "donchian",
      regime: s?.trendBreakout?.regime ?? null,
      entryHigh: s?.trendBreakout?.entryHigh ?? null, entryLow:s?.trendBreakout?.entryLow ?? null,
      volumeUsd: s?.vol24hUsd ?? null, minVolumeUsd: ctx.cfg.cats[id].minVolumeUsd,
      atrPct, entryMinutes, confirmedClose: confirmed?.close ?? null,
      confirmedAgeMs: confirmed ? ctx.now - confirmed.ts - entryMinutes*60000 : null,
      maxConfirmedAgeMs: entryMinutes*60000,
      stopDistancePct: atrPct === null ? null : atrPct*limits.stopAtrMult,
      roundTripCostPct: costs, minStopCostRatio:limits.minStopCostRatio,
      minStopDistancePct: costs === null ? null : costs*limits.minStopCostRatio,
      maxEntryChaseAtr:limits.maxEntryChaseAtr,
      maxEntryPrice: confirmed && atrPct !== null && side ? confirmed.close*(1+(side === "long" ? 1 : -1)*limits.maxEntryChaseAtr*atrPct/100) : null,
      breakoutTrigger: id === "tiger" ? null : s?.breakout?.trigger ?? null, trendScore: s?.trend?.score ?? null, minTrendScore: id === "mochi" ? ctx.cfg.strategies.mochi.minTrendScore : null, trendMinutes: 240,
      shortSlices: s?.trend?.shortOn ?? null, trendSlices: s?.trend?.slicesAvailable ?? null,
      trendStopPx: s?.trend?.trailStop ?? null,
      tradesToday: ctx.bee.tradesToday, entriesUsed: entriesUsed(ctx.bee), maxTradesPerDay: ctx.knobs.maxTradesPerDay };
  });
}
