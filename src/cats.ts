import { trendEntryBlockers } from "./bees/active-breezy.js";
import { activeEntryBlockers, momentumSide, momentumThreshold } from "./bees/active-bizzy.js";
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
  return [
    id === "tiger"
      ? `Active momentum on ${cfg.slots[id].coins.join(" / ")}, long and short. One-hour movement must exceed max(${cfg.strategies.tiger.minMomentumPct}%, ${cfg.strategies.tiger.momentumAtrMult} x 15-minute ATR%) in its direction, with MACD confirming. Signals use completed 15-minute candles; no daily breakout required.`
      : "BTC / ETH, long and short. Nine Donchian channels (5, 10, 20, 30, 60, 90, 150, 250, 360) on 4-hour candles. Jev can open, flip, switch coins, add above +1R, or trim after a three-point directional score decline.",
    id === "tiger"
      ? `Entry size respects the stop-risk budget. Configured model gates apply. Initial stop ${l.stopAtrMult} x 15-minute ATR from entry, trailing after +1R. The model may close or reverse; code exits after ${cfg.strategies.tiger.maxHoldMinutes} minutes. No forced entries.`
      : `Size by absolute score / 9, capped at ${cfg.strategies.mochi.volTargetPct}% annualized volatility and the stop-risk budget. Enter only with absolute trend score >= ${cfg.strategies.mochi.minTrendScore}; WAIT is valid. Trim once after a ${cfg.strategies.mochi.trimScoreDrop}-point decline; no automatic buyback. Exit after ${cfg.strategies.mochi.maxHoldMinutes} minutes or a qualified trend reversal.`,
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
    if (ctx.bee.tradesToday >= l.maxTradesPerDay) blockers.push("trade_cap");
    return blockers;
  }
  reasons.push(...trendEntryBlockers(s, ctx));
  if (ctx.bee.tradesToday >= l.maxTradesPerDay) reasons.push("trade_cap");
  return reasons;
}

export function entryDiagnostics(id: BeeId, ctx: BeeContext) {
  return ctx.cfg.slots[id].coins.map(coin => {
    const s = [...ctx.view.stats.values()].find(s => s.coin === coin);
    const instId = s?.instId ?? [...ctx.view.instruments.values()].find(i => i.coin === coin)?.instId;
    const error = ctx.view.refreshError ?? (instId ? ctx.view.dataErrors?.get(instId) : null);
    return { coin, blockers: s ? entryBlockers(id, s, ctx) : ["missing_market_data"],
      indicatorsAgeMs: s ? ctx.now - (s.refreshedAt ?? ctx.view.ts) : null,
      maxIndicatorsAgeMs: 3 * ctx.cfg.dataRefreshMs,
      feedError: error?.message ?? null, feedErrorAt: error?.at ?? null,
      mid: s?.mid ?? null, spreadBps: s?.spreadBp ?? null, maxSpreadBps: ctx.knobs.spreadGateBps,
      momentumPct: s?.ret1hPct ?? null, momentumMinutes: 60,
      minMomentumPct: s && id === "tiger" ? momentumThreshold(s, ctx) : null, macdHistPct: s?.macdHistPct ?? null,
      signalSide: s && id === "tiger" ? momentumSide(s, ctx) : null,
      volumeUsd: s?.vol24hUsd ?? null, minVolumeUsd: ctx.cfg.cats[id].minVolumeUsd,
      atrPct: s?.atr14Pct ?? null,
      breakoutTrigger: id === "tiger" ? null : s?.breakout?.trigger ?? null, trendScore: s?.trend?.score ?? null, minTrendScore: id === "mochi" ? ctx.cfg.strategies.mochi.minTrendScore : null, trendMinutes: 240,
      shortSlices: s?.trend?.shortOn ?? null, trendSlices: s?.trend?.slicesAvailable ?? null,
      tradesToday: ctx.bee.tradesToday, maxTradesPerDay: ctx.knobs.maxTradesPerDay };
  });
}
