import { r2 } from "./bees/common.js";
import type { BeeBrain, BeeContext, Menu } from "./bees/types.js";
import type { BeeId, Config } from "./config.js";
import { CONVICTION } from "./decision.js";
import type { CoinStats } from "./market/types.js";

const fresh = (s: CoinStats, ctx: BeeContext) => {
  const age = ctx.now - (s.refreshedAt ?? ctx.view.ts);
  return age >= 0 && age <= 3 * ctx.cfg.dataRefreshMs;
};
const entryMinutes = (id: BeeId) => id === "tiger" ? 5 : 15;
const trendMinutes = (id: BeeId) => id === "tiger" ? 15 : 60;
const roundTripCostPct = (s: CoinStats, ctx: BeeContext) =>
  200 * ctx.cfg.risk.takerFeeRate + (s.spreadBp + 2 * ctx.cfg.paperSlippageBps) / 100;
const sizeFraction = (id: BeeId, s: CoinStats | undefined, ctx: BeeContext) => {
  if (id === "tiger") return 1;
  const t = s?.intraday?.mochi.trend;
  if (!t || !(t.score > 0) || !Number.isFinite(t.rv90Pct) || !(t.rv90Pct! > 0)) return 0;
  return Math.min(1, t.score / 9, ctx.cfg.strategies.mochi.volTargetPct / t.rv90Pct! / (ctx.cfg.cats.mochi.maxNotionalPct / 100));
};

/** Active intraday strategies; historical components remain available for replay research. */
export function catBrain(id: BeeId, cfg: Config): BeeBrain {
  const limits = cfg.cats[id], profile = cfg.slots[id];
  const tiger = id === "tiger";
  return {
    id: profile.style,
    strategy: `${profile.name}: ${strategyFacts(id, cfg).join(" ")} ${profile.rules} One long position maximum. Never add, average down or force entry. WAIT keeps cash; CLOSE reduces risk. Scores describe signal evidence, not profit probability.`,
    convictionLabels: CONVICTION,
    neverForce: true,
    forcedEntry: () => null,
    sizeFrac: (intent, _conviction, ctx) => sizeFraction(id, ctx.view.stats.get(intent.instId), ctx),
    openGate: { minConviction: limits.minConviction, minProb: () => limits.minActionProbability },
    universe: ctx => [...ctx.view.stats.values()].filter(s => entryBlockers(id, s, ctx).length === 0).map(s => s.instId),
    snapshotCoins: ctx => [...ctx.view.stats.values()].filter(s => profile.coins.includes(s.coin) || ctx.bee.position?.instId === s.instId).map(s => s.instId),
    coinSnapshot: (s, ctx) => {
      const signal = s.intraday?.[id], t = signal?.trend;
      return {
        mid: s.mid, spread_bps: r2(s.spreadBp), volume_usd: s.vol24hUsd,
        entry_bar_minutes: entryMinutes(id), trend_bar_minutes: trendMinutes(id),
        confirmed_entry_close: signal?.confirmed.close ?? null,
        momentum_pct: r2(signal?.momentumPct ?? null),
        breakout_trigger: tiger ? signal?.breakout?.trigger ?? null : null,
        trend_score: t?.score ?? null, trend_slices: t?.slicesAvailable ?? null,
        long_slices: t?.longOn ?? null, short_slices: t?.shortOn ?? null,
        entry_atr_pct: signal?.atrPct ?? null, trend_atr_pct: t?.atrPct ?? null,
        realised_vol_90_bars_pct: t?.rv90Pct ?? null,
        channel_trail_stop: t?.trailStop ?? null, recent_extreme: t?.recentExtreme ?? null,
        target_notional_fraction: sizeFraction(id, s, ctx), funding_pct: r2(s.fundingPct, 4),
      };
    },
    menu(ctx) {
      const p = ctx.bee.position;
      if (p) {
        const menu: Menu = {
          HOLD: { desc: "Keep existing position; deterministic exits remain active", intent: { kind: "hold" } },
          CLOSE: { desc: "Reduce exposure to zero", intent: { kind: "close", reason: "model_exit" } },
        };
        const s = ctx.view.stats.get(p.instId), t = s?.intraday?.[id].trend;
        if (!tiger && !p.trendTrimmed && p.entryScore !== undefined && s && fresh(s, ctx) && t &&
          t.score > 0 && t.score <= p.entryScore - cfg.strategies.mochi.trimScoreDrop)
          menu.TRIM_HALF = { desc: `Trend score fell from ${p.entryScore} to ${t.score}; halve exposure once`, intent: { kind: "trim", fraction: 0.5 } };
        return menu;
      }
      const menu: Menu = { WAIT: { desc: "Keep cash; no entry required", intent: { kind: "hold" } } };
      const eligible = [...ctx.view.stats.values()].filter(s => entryBlockers(id, s, ctx).length === 0);
      const best = tiger ? eligible : eligible.sort((a, b) => {
        const ta = a.intraday!.mochi.trend, tb = b.intraday!.mochi.trend;
        return tb.score - ta.score || tb.recentExtreme - ta.recentExtreme;
      }).slice(0, 1);
      for (const s of best) menu[`LONG_${s.coin}`] = {
        desc: tiger ? "Confirmed 5m breakout above the preceding hour, supportive 15m trend" : "Strongest eligible hourly trend with positive 15m momentum",
        intent: { kind: "open", instId: s.instId, side: "long", sizeFrac: sizeFraction(id, s, ctx), setup: "strict" },
      };
      return menu;
    },
    stopFor: (instId, side, entryPx, ctx) => {
      const s = ctx.view.stats.get(instId), signal = s?.intraday?.[id];
      const a = tiger ? signal?.atrPct : signal?.trend.atrPct;
      return side === "long" && s && fresh(s, ctx) && Number.isFinite(a) && a! > 0
        ? entryPx * (1 - limits.stopAtrMult * a! / 100) : null;
    },
    timeStopMinutes: () => cfg.strategies[id].maxHoldMinutes,
    trail: ctx => {
      const s = ctx.bee.position && ctx.view.stats.get(ctx.bee.position.instId);
      const t = s && s.intraday?.[id].trend;
      return s && fresh(s, ctx) && t && t.score > 0 ? t.trailStop : null;
    },
    protectiveExit: ctx => {
      const s = ctx.bee.position && ctx.view.stats.get(ctx.bee.position.instId);
      const t = s && s.intraday?.[id].trend;
      return s && fresh(s, ctx) && t?.slicesAvailable === 9 && t.score <= 0 ? "trend_lost" : null;
    },
  };
}

export function strategyFacts(id: BeeId, cfg: Config): string[] {
  const l = cfg.cats[id], tiger = id === "tiger";
  return [
    tiger ? "Long-only BTC / ETH / SOL. A completed 5-minute close must break above the preceding twelve 5-minute highs (one hour), with positive 15-minute momentum."
      : "Long-only BTC / ETH. Follow the strongest hourly trend with a completed 15-minute entry candle and positive 45-minute momentum.",
    `Nine Donchian horizons (3, 5, 8, 12, 18, 24, 36, 48, 72) on completed ${trendMinutes(id)}-minute bars; require score ≥ ${l.minTrendScore}${tiger ? "." : " and no bearish channels."}`,
    tiger ? `Avoid chasing beyond ${cfg.strategies.tiger.maxChaseRangeFrac * 100}% of the preceding hour's range; funding ≤ ${cfg.strategies.tiger.maxFundingPct}%.`
      : `Size by score / 9 and a ${cfg.strategies.mochi.volTargetPct}% annualized volatility ceiling from 90 hourly returns; no minimum exposure.`,
    `Initial stop: ${l.stopAtrMult} × ${tiger ? "5-minute" : "hourly"} ATR. The stop distance must be at least twice estimated round-trip fees, spread and slippage; this is a movement filter, not a profit forecast.`,
    `At most ${l.maxNotionalPct}% of own equity in notional; ${l.stopRiskPct}% initial stop-distance risk including fees. Up to ${l.maxTradesPerDay} entries per UTC day with ${l.cooldownMinutes}-minute cooldown.`,
    `Ratchet the channel stop; exit if trend score reaches zero or after ${cfg.strategies[id].maxHoldMinutes} minutes, even without the model. ${tiger ? "" : `Offer one half-trim after a ${cfg.strategies.mochi.trimScoreDrop}-point score decline. `}WAIT is valid.`,
  ];
}

/** Used by entry menus and coach explanations; risk controls recheck before execution. */
export function entryBlockers(id: BeeId, s: CoinStats, ctx: BeeContext): string[] {
  const l = ctx.cfg.cats[id], signal = s.intraday?.[id], t = signal?.trend, reasons: string[] = [];
  // Old or missing candles cannot support conclusions about current market conditions.
  if (!fresh(s, ctx)) return ["stale_indicators"];
  const age = signal ? ctx.now - signal.confirmed.ts : Infinity, period = entryMinutes(id) * 60000;
  if (!signal || !Number.isFinite(age) || age < period || age > 2 * period + 60000)
    return ["missing_confirmed_entry_close"];
  if (!ctx.cfg.slots[id].coins.includes(s.coin)) reasons.push("coin_not_allowed");
  if (!(s.vol24hUsd >= l.minVolumeUsd)) reasons.push("liquidity_gate");
  if (!(s.spreadBp <= l.spreadGateBps)) reasons.push("spread_gate");
  if (!ctx.view.gated.includes(s.instId)) reasons.push("market_universe_gate");
  if (!t || t.slicesAvailable !== 9 || !Number.isFinite(t.score)) reasons.push("incomplete_trend_history");
  else if (t.score < l.minTrendScore) reasons.push("minTrendScore");
  if (!signal || !Number.isFinite(signal.momentumPct) || !(signal.momentumPct! > 0)) reasons.push("momentum_not_positive");
  const a = id === "tiger" ? signal?.atrPct : t?.atrPct;
  const costsPct = roundTripCostPct(s, ctx);
  if (!Number.isFinite(a) || !(a! > 0)) reasons.push("missing_atr_stop");
  else if (a! * l.stopAtrMult < 2 * costsPct) reasons.push("move_too_small_after_costs");
  if (ctx.bee.tradesToday >= l.maxTradesPerDay) reasons.push("trade_cap");
  if (id === "mochi") {
    if (t && t.shortOn !== 0) reasons.push("opposing_short_slices");
    if (!(sizeFraction(id, s, ctx) > 0)) reasons.push("invalid_volatility_size");
  } else {
    const b = signal?.breakout, rules = ctx.cfg.strategies.tiger;
    if (!b || ![b.trigger, b.range].every(Number.isFinite) || b.trigger <= 0 || b.range <= 0) reasons.push("missing_intraday_range");
    else {
      if (!(signal!.confirmed.close > b.trigger) || !(s.mid >= b.trigger)) reasons.push("breakout_not_confirmed");
      if (!(s.mid <= b.trigger + rules.maxChaseRangeFrac * b.range)) reasons.push("price_extended");
    }
    if (!Number.isFinite(s.fundingPct) || !(s.fundingPct! <= rules.maxFundingPct)) reasons.push("funding_gate");
  }
  return reasons;
}

export function entryDiagnostics(id: BeeId, ctx: BeeContext) {
  return ctx.cfg.slots[id].coins.map(coin => {
    const s = [...ctx.view.stats.values()].find(s => s.coin === coin), signal = s?.intraday?.[id];
    const instId = s?.instId ?? [...ctx.view.instruments.values()].find(i => i.coin === coin)?.instId;
    const feedError = ctx.view.refreshError ?? (instId ? ctx.view.dataErrors?.get(instId) : null);
    const l = ctx.cfg.cats[id], a = id === "tiger" ? signal?.atrPct : signal?.trend.atrPct;
    return { coin, blockers: s ? entryBlockers(id, s, ctx) : ["missing_market_data"],
      indicatorsAgeMs: s ? ctx.now - (s.refreshedAt ?? ctx.view.ts) : null,
      maxIndicatorsAgeMs: 3 * ctx.cfg.dataRefreshMs,
      feedError: feedError?.message ?? null, feedErrorAt: feedError?.at ?? null,
      confirmedAt: signal ? signal.confirmed.ts + entryMinutes(id) * 60000 : null,
      maxConfirmedAgeMs: entryMinutes(id) * 60000 + 60000,
      confirmedAgeMs: signal ? ctx.now - signal.confirmed.ts - entryMinutes(id) * 60000 : null,
      minTrendScore: l.minTrendScore, momentumPct: signal?.momentumPct ?? null,
      momentumMinutes: entryMinutes(id) * 3,
      stopDistancePct: a != null ? a * l.stopAtrMult : null,
      roundTripCostPct: s ? roundTripCostPct(s, ctx) : null,
      minStopDistancePct: s ? 2 * roundTripCostPct(s, ctx) : null,
      maxSpreadBps: l.spreadGateBps, minVolumeUsd: l.minVolumeUsd,
      fundingPct: s?.fundingPct ?? null, maxFundingPct: id === "tiger" ? ctx.cfg.strategies.tiger.maxFundingPct : null,
      maxEntryPrice: id === "tiger" && signal?.breakout ? signal.breakout.trigger + ctx.cfg.strategies.tiger.maxChaseRangeFrac * signal.breakout.range : null,
      shortSlices: signal?.trend.shortOn ?? null, trendSlices: signal?.trend.slicesAvailable ?? null,
      tradesToday: ctx.bee.tradesToday, maxTradesPerDay: l.maxTradesPerDay,
      trendMinutes: trendMinutes(id), entryMinutes: entryMinutes(id), trendScore: signal?.trend.score ?? null,
      spreadBps: s?.spreadBp ?? null, volumeUsd: s?.vol24hUsd ?? null, mid: s?.mid ?? null,
      breakoutTrigger: id === "tiger" ? signal?.breakout?.trigger ?? null : null,
      confirmedClose: signal?.confirmed.close ?? null };
  });
}
