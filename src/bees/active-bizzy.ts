// Catfolio's active successor to the preserved daily Bizzy breakout brain.
import type { CoinStats } from "../market/types.js";
import { BIZZY_BREAKOUT_COINS } from "./bizzy.js";
import { atrStop, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Menu, Side } from "./types.js";

export const ACTIVE_MOMENTUM_ATR = 0.25;
export const ACTIVE_MIN_MOMENTUM_PCT = 0.1;
export const ACTIVE_MAX_HOLD_MINUTES = 120;

export function momentumThreshold(s: CoinStats, ctx?: BeeContext): number | null {
  return s.atr14Pct !== null && Number.isFinite(s.atr14Pct) && s.atr14Pct > 0
    ? Math.max(ctx?.cfg.strategies.tiger.minMomentumPct ?? ACTIVE_MIN_MOMENTUM_PCT,
      (ctx?.cfg.strategies.tiger.momentumAtrMult ?? ACTIVE_MOMENTUM_ATR) * s.atr14Pct) : null;
}

/** Symmetric signals from completed 15m candles: one-hour move plus MACD direction. */
export function momentumSide(s: CoinStats, ctx?: BeeContext): Side | null {
  const threshold = momentumThreshold(s, ctx), move = s.ret1hPct, macd = s.macdHistPct;
  if (threshold === null || move === null || macd === null || !Number.isFinite(move) || !Number.isFinite(macd)) return null;
  if (move >= threshold && macd >= 0) return "long";
  if (move <= -threshold && macd <= 0) return "short";
  return null;
}

export function activeEntryBlockers(s: CoinStats, ctx: BeeContext): string[] {
  const age = ctx.now - (s.refreshedAt ?? ctx.view.ts);
  if (age < 0 || age > 3 * ctx.cfg.dataRefreshMs) return ["stale_indicators"];
  const reasons: string[] = [];
  if (!ctx.cfg.slots[ctx.bee.id].coins.includes(s.coin)) reasons.push("coin_not_allowed");
  if (!ctx.view.gated.includes(s.instId)) reasons.push("market_universe_gate");
  if (!(s.spreadBp <= ctx.knobs.spreadGateBps)) reasons.push("spread_gate");
  if (!(s.vol24hUsd >= ctx.cfg.cats[ctx.bee.id].minVolumeUsd)) reasons.push("liquidity_gate");
  if (!Number.isFinite(s.mid) || s.mid <= 0 || momentumThreshold(s, ctx) === null || s.atr14Pct! * ctx.knobs.stopAtrMult >= 100) reasons.push("missing_atr_stop");
  if (s.ret1hPct === null || s.macdHistPct === null || !Number.isFinite(s.ret1hPct) || !Number.isFinite(s.macdHistPct)) reasons.push("missing_momentum_data");
  else if (!momentumSide(s, ctx)) reasons.push("momentum_not_confirmed");
  return reasons;
}

function candidates(ctx: BeeContext): CoinStats[] {
  return [...ctx.view.stats.values()]
    .filter(s => (BIZZY_BREAKOUT_COINS as readonly string[]).includes(s.coin) && activeEntryBlockers(s, ctx).length === 0)
    .sort((a, b) => Math.abs(b.ret1hPct!) / b.atr14Pct! - Math.abs(a.ret1hPct!) / a.atr14Pct!);
}

export const activeBizzy: BeeBrain = {
  id: "bizzy",
  strategy: "You are Dark Wall-E, an active intraday long/short momentum trader. Evaluate the offered LONG and SHORT opportunities across the allowed coins. Signals use one-hour momentum and MACD from completed 15-minute candles, not a daily breakout. Prefer the clearest move with supportive volume and open interest; avoid chasing an exhausted move. Take a feasible trade when the configured conviction and probability gates are met. WAIT if no offered trade is convincing. While invested, HOLD a continuing move, CLOSE a weakening or exhausted trade, or FLIP when the opposite signal is convincing. Code controls ATR stops, trailing stops, the configured maximum holding time and daily limits.",
  convictionLabels: ["meh", "decent", "strong", "very strong"],
  neverForce: true,
  entryGate: ctx => ({ minConviction: ctx.cfg.cats[ctx.bee.id].minConviction, minProb: ctx.cfg.cats[ctx.bee.id].minActionProbability }),
  timeStopMinutes: ctx => ctx.cfg.strategies.tiger.maxHoldMinutes,
  universe: ctx => candidates(ctx).map(s => s.instId),
  snapshotCoins(ctx) {
    const ids = new Set(this.universe(ctx));
    if (ctx.bee.position) ids.add(ctx.bee.position.instId);
    return [...ids];
  },
  coinSnapshot(s, ctx) {
    return {
      r1h_pct: r2(s.ret1hPct), macd_pct: r2(s.macdHistPct, 4),
      min_move_pct: r2(momentumThreshold(s, ctx), 3), atr15m_pct: r2(s.atr14Pct, 3),
      rsi14: r2(s.rsi14, 1), r24h_pct: r2(s.ret24hPct),
      fund_z: r2(s.fundingZ, 1), oi1h_pct: r2(s.oiChg1hPct, 1),
      volume_z: r2(s.volZ, 1), spread_bp: r2(s.spreadBp, 1),
    };
  },
  menu(ctx) {
    const menu: Menu = {}, p = ctx.bee.position;
    if (!p) {
      for (const s of candidates(ctx)) {
        const side = momentumSide(s, ctx)!;
        menu[`${side.toUpperCase()}_${s.coin}`] = { desc: `${s.ret1hPct!.toFixed(2)}% in 1h, MACD confirms`, intent: { kind: "open", instId: s.instId, side, sizeFrac: 1, setup: "strict" } };
      }
      if (Object.keys(menu).length) menu.WAIT = { desc: "no convincing opportunity", intent: { kind: "hold" } };
      return menu;
    }
    menu.HOLD = { desc: "momentum still supports the position", intent: { kind: "hold" } };
    menu.CLOSE = { desc: "take profit or cut a weakening trade", intent: { kind: "close", reason: "momentum_exit" } };
    const s = candidates(ctx).find(s => s.instId === p.instId);
    const side = s ? momentumSide(s, ctx) : null;
    if (side && side !== p.side) menu[`FLIP_${side.toUpperCase()}`] = { desc: `reverse ${p.coin} to ${side}`, intent: { kind: "switch", instId: p.instId, side, sizeFrac: 1, setup: "strict" } };
    return menu;
  },
  forcedEntry: () => null,
  sizeFrac: intent => intent.sizeFrac,
  stopFor: (id, side, px, ctx) => atrStop(ctx.view.stats.get(id), side, px, ctx.knobs.stopAtrMult),
  trail(ctx) {
    const p = ctx.bee.position, s = p ? ctx.view.stats.get(p.instId) : undefined;
    if (!p || !s || (ctx.uplR ?? 0) < 1) return null;
    const age = ctx.now - (s.refreshedAt ?? ctx.view.ts);
    if (age < 0 || age > 3 * ctx.cfg.dataRefreshMs || momentumThreshold(s, ctx) === null) return null;
    return atrStop(s, p.side, s.mid, ctx.knobs.stopAtrMult);
  },
  idleStatus: () => "waiting for confirmed long or short intraday momentum",
};
