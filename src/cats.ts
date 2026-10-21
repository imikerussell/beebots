import { trendEntryBlockers } from "./bees/active-breezy.js";
import { entriesUsed, roundTripCostPct } from "./bees/common.js";
import { activeEntryBlockers, activeSide, momentumThreshold } from "./bees/active-bizzy.js";
// Cat identity is an adapter. Trading behavior lives in the strategy brains.
import { brainsFor } from "./bees/index.js";
import { customBrain } from "./bees/custom.js";
import type { BeeBrain, BeeContext } from "./bees/types.js";
import type { BeeId, Config } from "./config.js";
import type { CoinStats } from "./market/types.js";

export function catBrain(id: BeeId, cfg: Config): BeeBrain {
  const profile = cfg.slots[id];
  return customBrain(brainsFor(cfg)[profile.style], { rules: profile.rules, coins: profile.coins });
}

export function strategyFacts(id: BeeId, cfg: Config): string[] {
  const l = cfg.cats[id];
  if (cfg.strategyEngine === "upstream") return [
    id === "tiger"
      ? "Upstream Argon Breakout: strict RSI/Bollinger fades long or short on 8 liquid majors, plus confirmed daily volatility breakouts on BTC, ETH, SOL and HYPE. Bank at the middle band or +1R; four-hour time stop. No forced entries."
      : "Upstream Argon Trend: BTC/ETH, nine Donchian channels on four-hour candles. Enter at |score| >= 3; weak trends require agreeing 24-hour momentum. Size by score under a 40% volatility target; ride winners, trim on score deterioration and exit an exhausted trend.",
    `Profit locks and trailing stops follow upstream. Protective checks run every ${Math.min(cfg.tickMs, 2000)/1000}s independently of model requests. The prior Catfolio discretionary profit-review settings apply only with STRATEGY_ENGINE=catfolio.`,
    `${l.maxTradesPerDay} entries per UTC day, ${l.cooldownMinutes}-minute cooldown, $${l.feeBudgetUsdDay} daily fee budget. Catfolio retains the owner-configured ${l.stopRiskPct}% stop-risk budget, ${l.dailyLossStopPct}% daily loss stop and ${cfg.risk.maxLeverage}x leverage ceiling.`,
    "Gemini chooses among the menu options. When Gemini is unavailable or its budget is exhausted, upstream's code chooser can trade by fixed priorities; it does not read free-text rules. Coin restrictions and deterministic risk checks still apply.",
  ];
  const t = cfg.strategies.tiger;
  const e = cfg.exits[id];
  return [
    id === "tiger"
      ? `${t.signalMode} on ${cfg.slots[id].coins.join(" / ")}, long and short. ${t.signalMode === "trend_breakout"
        ? `Completed 15-minute close must break the prior ${t.entryBars}-bar high/low, aligned with hourly close and EMA ${t.fastHours}/${t.slowHours}. Exit on the prior ${t.exitBars}-bar opposite channel or opposite hourly regime.`
        : `One-hour movement must exceed max(${t.minMomentumPct}%, ${t.momentumAtrMult} x 15-minute ATR%) in its direction, with MACD confirming.${t.signalMode === "trend_momentum" ? ` Hourly close and EMA ${t.fastHours}/${t.slowHours} must agree.` : ""} Exit when both return and MACD oppose the position.`}`
      : "BTC / ETH, long and short. Nine Donchian channels (5, 10, 20, 30, 60, 90, 150, 250, 360) on completed 4-hour candles. Code exits when the signed trend score reaches zero or reverses. Adds require a winner above +1R before any trim; score-deterioration and optional profit trims can each occur once per position.",
    id === "tiger"
      ? `Entry size respects the stop-risk budget. Initial stop ${l.stopAtrMult} x 15-minute ATR from entry. Maximum hold ${t.maxHoldMinutes} minutes. No forced entries or immediate model flips.`
      : `Size by absolute score / 9, capped at ${cfg.strategies.mochi.volTargetPct}% annualized volatility and the stop-risk budget. Enter only with absolute trend score >= ${cfg.strategies.mochi.minTrendScore}; WAIT is valid. Trim once after a ${cfg.strategies.mochi.trimScoreDrop}-point decline; no automatic buyback. Maximum hold ${cfg.strategies.mochi.maxHoldMinutes} minutes.`,
    `At most one entry evaluation per completed ${id === "tiger" ? "15-minute" : "4-hour"} signal bar, persisted across restart. Offer the top ${l.maxEntryCandidates} eligible candidate(s) plus WAIT. Stop distance must cover ${l.minStopCostRatio} x estimated round-trip costs; adverse entry chase <= ${l.maxEntryChaseAtr} ATR. These filters do not establish an expected profit.`,
    `Profit protection is independent of Jev. ${e.breakevenAtR > 0 ? `After peak net profit reaches ${e.breakevenAtR}R, ratchet the stop to estimated cost-covering breakeven plus ${e.breakevenBufferBps} basis points.` : "Cost-covering breakeven protection is disabled."} ${e.trailActivationR > 0 && e.trailAtrMult > 0 ? `Independently trail at ${e.trailAtrMult} x ${id === "tiger" ? "15-minute" : "4-hour"} ATR after ${e.trailActivationR}R.` : "Independent ATR profit trailing is disabled."} ${id === "mochi" ? "Retain the tighter Donchian channel stop. " : ""}${e.profitLockAtR > 0 && e.maxGivebackPct < 100 ? `After ${e.profitLockAtR}R, protect ${100-e.maxGivebackPct}% of peak net profit.` : "Peak-profit giveback protection is disabled."} Stops only tighten; gaps and execution costs can still exceed the estimate.`,
    `${e.reviewMinR > 0 && e.reviewIntervalSeconds > 0 ? `When estimated net profit reaches ${e.reviewMinR}R, Jev may review HOLD against CLOSE_PROFIT at most once every ${e.reviewIntervalSeconds} seconds between signal bars.` : "Discretionary profit reviews are disabled."} ${e.partialTakeProfitEnabled ? `During a profit review, TAKE_PROFIT can reduce ${e.partialTakeProfitFraction*100}% once after ${e.partialTakeProfitAtR}R if both the sold and remaining size meet exchange minimums.` : "Optional partial profit-taking is disabled."} Selected discretionary exits require menu probability >= ${e.minActionProbability}; they do not require entry conviction or certainty. A HOLD or model outage cannot veto a protective stop. Exit controls are owner-configured, not trainer-tunable.`,
    `Maximum leverage ${cfg.risk.maxLeverage}x, with 3% margin headroom and a $${cfg.risk.maxNotionalUsdPerBee} absolute notional ceiling. Explicit per-cat notional cap: ${l.maxNotionalPct}% of equity.`,
    `Entry conviction >= ${l.minConviction} on a continuous 0..3 scale; chosen-action probability >= ${l.minActionProbability}. Estimated stop loss plus costs <= ${l.stopRiskPct}% of equity.`,
    `${l.maxTradesPerDay} new positions per UTC day, $${l.feeBudgetUsdDay} daily fee budget, ${l.cooldownMinutes}-minute discretionary opening cooldown, ${l.dailyLossStopPct}% daily loss stop. Stop decisions are deterministic and run within the trading tick.`,
  ];
}

/** Diagnostics describe source requirements; they never impose extra entry conditions. */
export function entryBlockers(id: BeeId, s: CoinStats, ctx: BeeContext): string[] {
  if (ctx.cfg.strategyEngine === "upstream") {
    const reasons: string[] = [];
    if (s.spreadBp > ctx.knobs.spreadGateBps) reasons.push("spread_gate");
    if (!ctx.view.gated.includes(s.instId) || s.vol24hUsd < ctx.cfg.cats[id].minVolumeUsd) reasons.push("liquidity_gate");
    if (ctx.now-(s.refreshedAt ?? ctx.view.ts) > 3*ctx.cfg.dataRefreshMs) reasons.push("stale_indicators");
    const ticker = ctx.view.tickers.get(s.instId);
    if (!ticker || ctx.now < ticker.ts || ctx.now-ticker.ts > ctx.cfg.maxTickerAgeMs) reasons.push("stale_market_data");
    const menu = catBrain(id, ctx.cfg).menu({...ctx, bee: {...ctx.bee, position: null}});
    if (!Object.values(menu).some(o => o.intent.kind === "open" && o.intent.instId === s.instId)) reasons.push(id === "tiger" ? "no_strict_fade_or_breakout" : "minTrendScore");
    if (entriesUsed(ctx.bee) >= ctx.knobs.maxTradesPerDay) reasons.push("trade_cap");
    return reasons;
  }
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
  if (ctx.cfg.strategyEngine === "upstream") return ctx.cfg.slots[id].coins.map(coin => {
    const s = [...ctx.view.stats.values()].find(s => s.coin === coin);
    const limits = ctx.cfg.cats[id];
    const menu = catBrain(id,ctx.cfg).menu({...ctx,bee:{...ctx.bee,position:null}});
    const intent = Object.values(menu).find(o => o.intent.kind === "open" && o.intent.instId === s?.instId)?.intent;
    return {coin,blockers:s ? entryBlockers(id,s,ctx) : ["missing_market_data"],
      mid:s?.mid ?? null, spreadBps:s?.spreadBp ?? null, maxSpreadBps:limits.spreadGateBps,
      volumeUsd:s?.vol24hUsd ?? null,minVolumeUsd:limits.minVolumeUsd,
      indicatorsAgeMs:s ? ctx.now-(s.refreshedAt ?? ctx.view.ts) : null,maxIndicatorsAgeMs:3*ctx.cfg.dataRefreshMs,
      entryMinutes: id === "tiger" ? 15 : 240, minStopDistancePct: null, roundTripCostPct: s ? roundTripCostPct(s,ctx) : null,
      signalMode:id === "tiger" ? "band_fade_breakout" : "donchian",
      signalSide:intent?.kind === "open" ? intent.side : null,
      rsi14:s?.rsi14 ?? null,pctB:s?.pctB ?? null,breakoutTrigger:s?.breakout?.trigger ?? null,
      trendScore:s?.trend?.score ?? null,minTrendScore:id === "mochi" ? 3 : null,trendMinutes:240,
      tradesToday:ctx.bee.tradesToday,entriesUsed:entriesUsed(ctx.bee),maxTradesPerDay:limits.maxTradesPerDay};
  });
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
      signalSide: side,
      signalMode: ctx.cfg.strategyEngine === "upstream" ? (id === "tiger" ? "band_fade_breakout" : "donchian") : id === "tiger" ? ctx.cfg.strategies.tiger.signalMode : "donchian",
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
      breakoutTrigger: ctx.cfg.strategyEngine === "upstream" ? s?.breakout?.trigger ?? null : id === "tiger" ? null : s?.breakout?.trigger ?? null, trendScore: s?.trend?.score ?? null, minTrendScore: id === "mochi" ? ctx.cfg.strategyEngine === "upstream" ? 3 : ctx.cfg.strategies.mochi.minTrendScore : null, trendMinutes: 240,
      shortSlices: s?.trend?.shortOn ?? null, trendSlices: s?.trend?.slicesAvailable ?? null,
      trendStopPx: s?.trend?.trailStop ?? null,
      tradesToday: ctx.bee.tradesToday, entriesUsed: entriesUsed(ctx.bee), maxTradesPerDay: ctx.knobs.maxTradesPerDay };
  });
}
