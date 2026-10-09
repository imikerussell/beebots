import { breezy, breezySizeFrac, strongerCoin } from "./bees/breezy.js";
import { bizzy } from "./bees/bizzy.js";
import { r2 } from "./bees/common.js";
import type { BeeBrain, BeeContext, Menu } from "./bees/types.js";
import type { BeeId, Config } from "./config.js";
import { CONVICTION } from "./decision.js";
import type { CoinStats } from "./market/types.js";

const DAY = 86_400_000;
const fresh = (s: CoinStats, ctx: BeeContext) => {
  const age = ctx.now - (s.refreshedAt ?? ctx.view.ts);
  return age >= 0 && age <= 3 * ctx.cfg.dataRefreshMs;
};

/** Active adaptations of the upstream brains. Only these two identities are scheduled. */
export function catBrain(id: BeeId, cfg: Config): BeeBrain {
  const limits = cfg.cats[id], profile = cfg.slots[id];
  const tiger = id === "tiger";
  const candidates = (ctx: BeeContext) => [...ctx.view.stats.values()].filter((s) =>
    profile.coins.includes(s.coin) && fresh(s, ctx) &&
    s.vol24hUsd >= limits.minVolumeUsd && s.spreadBp <= limits.spreadGateBps &&
    ctx.view.gated.includes(s.instId));
  const mochiSize = (s: CoinStats | undefined, ctx: BeeContext) => {
    if (!s?.trend || !(s.trend.score > 0) || !Number.isFinite(s.trend.rv90Pct) || !(s.trend.rv90Pct! > 0)) return 0;
    return breezySizeFrac(s, ctx, { volTargetPct: cfg.strategies.mochi.volTargetPct, sizeFloorFrac: 0 });
  };
  return {
    id: profile.style,
    strategy: `${profile.name}: ${tiger
      ? "Bizzy-derived daily volatility breakout: buy only a confirmed 15m close above today's UTC open + k times the complete previous day's range, with positive 1h momentum and a supportive 4h trend. Avoid extended moves and expensive funding. Initial stop is the day's open; code exits at 23:59 UTC."
      : "Breezy-derived calculated trend: nine Donchian horizons on confirmed 4h closes, score = long minus short slices. Prefer the strongest BTC/ETH trend, tie-break at a 10-day high. Size by score and realised volatility, use a 2-ATR 4h initial stop and ratcheting channel midpoint. Hold winners; optionally trim once when score deteriorates; code exits when the trend is lost."} ${profile.rules} One long position maximum. Never add, average down or force entry. WAIT keeps cash; CLOSE reduces risk. Scores describe signal evidence, not profit probability.`,
    convictionLabels: CONVICTION,
    neverForce: true,
    forcedEntry: () => null,
    sizeFrac: (intent, _conviction, ctx) => tiger ? 1 : mochiSize(ctx.view.stats.get(intent.instId), ctx),
    openGate: { minConviction: limits.minConviction, minProb: () => limits.minActionProbability },
    universe: (ctx) => candidates(ctx).map((s) => s.instId),
    snapshotCoins: (ctx) => [...new Set([...candidates(ctx).map((s) => s.instId), ...(ctx.bee.position ? [ctx.bee.position.instId] : [])])],
    coinSnapshot: (s, ctx) => ({
      mid: s.mid, spread_bps: r2(s.spreadBp), volume_usd: s.vol24hUsd,
      momentum_1h_pct: r2(s.ret1hPct), confirmed_15m_close: s.confirmed15m?.close ?? null,
      day_open: s.breakout?.dayOpen ?? null, previous_day_range: s.breakout?.prevRange ?? null,
      breakout_trigger: s.breakout?.trigger ?? null,
      minutes_to_day_exit: r2(((Math.floor(ctx.now / DAY) + 1) * DAY - 60000 - ctx.now) / 60000),
      trend_score: s.trend?.score ?? null, trend_slices: s.trend?.slicesAvailable ?? null,
      long_slices: s.trend?.longOn ?? null, short_slices: s.trend?.shortOn ?? null,
      atr_4h_pct: s.trend?.atr4hPct ?? null, realised_vol_90x4h_pct: s.trend?.rv90Pct ?? null,
      channel_trail_stop: s.trend?.trailStop ?? null, ten_day_extreme: s.trend?.tenDayExtreme ?? null,
      target_notional_fraction: tiger ? 1 : mochiSize(s, ctx), funding_pct: r2(s.fundingPct, 4),
    }),
    menu(ctx) {
      const p = ctx.bee.position;
      if (p) {
        const menu: Menu = {
          HOLD: { desc: "Keep existing position; deterministic exits remain active", intent: { kind: "hold" } },
          CLOSE: { desc: "Reduce exposure to zero", intent: { kind: "close", reason: "model_exit" } },
        };
        const s = ctx.view.stats.get(p.instId);
        if (!tiger && !p.trendTrimmed && p.entryScore !== undefined && s && fresh(s, ctx) &&
          s.trend && s.trend.score > 0 && s.trend.score <= p.entryScore - cfg.strategies.mochi.trimScoreDrop)
          menu.TRIM_HALF = { desc: `Trend score fell from ${p.entryScore} to ${s.trend.score}; halve exposure once`, intent: { kind: "trim", fraction: 0.5 } };
        return menu;
      }
      const menu: Menu = { WAIT: { desc: "Keep cash; no entry required", intent: { kind: "hold" } } };
      const eligible = candidates(ctx).filter((s) => {
        const t = s.trend;
        if (!t || t.slicesAvailable !== 9 || !Number.isFinite(t.score) || t.score < limits.minTrendScore) return false;
        if (!tiger) return t.shortOn === 0 && mochiSize(s, ctx) > 0 && Number.isFinite(t.atr4hPct) && t.atr4hPct! > 0;
        const b = s.breakout, c = s.confirmed15m, rules = cfg.strategies.tiger;
        const dayStart = Math.floor(ctx.now / DAY) * DAY;
        const remaining = (dayStart + DAY - 60000 - ctx.now) / 60000;
        return ctx.bee.tradesToday < limits.maxTradesPerDay && remaining >= rules.minMinutesToClose &&
          !!b && b.dayStart === dayStart && [b.trigger, b.dayOpen, b.prevRange].every(Number.isFinite) && b.prevRange > 0 && b.dayOpen > 0 &&
          !!c && c.ts >= dayStart && ctx.now - c.ts >= 15 * 60000 && ctx.now - c.ts <= 31 * 60000 &&
          c.close >= b.trigger && s.mid >= b.trigger && s.mid <= b.trigger + rules.maxChaseRangeFrac * b.prevRange &&
          (s.ret1hPct ?? 0) > 0 && Number.isFinite(s.fundingPct) && s.fundingPct! <= rules.maxFundingPct;
      });
      // Preserve Breezy's stronger-coin selection instead of letting weak alternatives dilute the menu.
      const best = tiger ? eligible : [strongerCoin(eligible)].filter((s): s is CoinStats => !!s);
      for (const s of best) menu[`LONG_${s.coin}`] = {
        desc: tiger ? "Confirmed daily breakout within chase, trend and funding limits" : "Strongest eligible nine-channel trend, volatility-sized",
        intent: { kind: "open", instId: s.instId, side: "long", sizeFrac: tiger ? 1 : mochiSize(s, ctx), setup: "strict" },
      };
      return menu;
    },
    stopFor: tiger ? bizzy.stopFor : breezy.stopFor,
    timeStopMinutes: tiger ? bizzy.timeStopMinutes : undefined,
    trail: tiger ? undefined : (ctx) => {
      const s = ctx.bee.position && ctx.view.stats.get(ctx.bee.position.instId);
      return s && fresh(s, ctx) ? breezy.trail!(ctx) : null;
    },
    protectiveExit: tiger ? undefined : (ctx) => {
      const s = ctx.bee.position && ctx.view.stats.get(ctx.bee.position.instId);
      return s && fresh(s, ctx) && s.trend?.slicesAvailable === 9 && s.trend.score <= 0 ? "trend_lost" : null;
    },
  };
}

/** User-visible facts from the same effective configuration that drives the strategy. */
export function strategyFacts(id: BeeId, cfg: Config): string[] {
  const l = cfg.cats[id];
  const size = `At most ${l.maxNotionalPct}% of own equity in notional; ${l.stopRiskPct}% initial stop-distance risk including estimated fees. Sizes round down to exchange lots.`;
  if (id === "tiger") {
    const t = cfg.strategies.tiger;
    return [
      `Bizzy-derived, long-only daily breakout on BTC / ETH / SOL. Trigger: UTC day open + ${t.breakoutK} × yesterday's full range.`,
      `Require a completed 15-minute close above the trigger, positive 1-hour momentum and a nine-channel 4-hour trend score of at least ${l.minTrendScore}.`,
      `Skip entries more than ${t.maxChaseRangeFrac * 100}% of yesterday's range past the trigger, within ${t.minMinutesToClose} minutes of the 23:59 UTC exit, or above ${t.maxFundingPct}% funding per settlement.`,
      size,
      `Stop at the entry day's open; close at 23:59 UTC. Up to ${l.maxTradesPerDay} entries per UTC day, ${l.cooldownMinutes}-minute minimum entry cooldown. WAIT is valid.`,
    ];
  }
  return [
    `Breezy-derived, long-only BTC / ETH trend following. Nine Donchian horizons: 5, 10, 20, 30, 60, 90, 150, 250 and 360 completed four-hour bars.`,
    `Require score ≥ ${l.minTrendScore} and no short slices. Prefer the stronger coin; a 10-day closing high breaks ties.`,
    `Target size uses score / 9 and a ${cfg.strategies.mochi.volTargetPct}% annualized volatility ceiling estimated from 90 four-hour returns. No minimum exposure.`,
    size,
    `Initial stop: ${l.stopAtrMult} × four-hour ATR. Ratchet along channel midpoints; close when trend score reaches zero or turns negative. Offer one half-trim after a ${cfg.strategies.mochi.trimScoreDrop}-point score drop. Never add. WAIT is valid.`,
  ];
}
