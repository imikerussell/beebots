// Catfolio's active successor to the preserved daily Bizzy breakout brain.
import type { CoinStats } from "../market/types.js";
import { BIZZY_BREAKOUT_COINS } from "./bizzy.js";
import { atrStop, currentSignalBar, decisionBarKey, r2, roundTripCostPct } from "./common.js";
import { profitReviewKey, profitReviewMenu } from "./profit-management.js";
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

export function activeSide(s: CoinStats, ctx: BeeContext): Side | null {
  const mode = ctx.cfg.strategies.tiger.signalMode;
  if (mode === "trend_breakout") return s.trendBreakout?.side ?? null;
  const side = momentumSide(s,ctx);
  return mode === "momentum" || s.trendBreakout?.regime === side ? side : null;
}

function exitReason(ctx: BeeContext): string | null {
  const p = ctx.bee.position, s = p ? ctx.view.stats.get(p.instId) : undefined;
  if (!p || !s || !currentSignalBar(s,ctx,15)) return null;
  const dir = p.side === "long" ? 1 : -1;
  if (ctx.cfg.strategies.tiger.signalMode === "trend_breakout") {
    const t=s.trendBreakout;
    return t && ((p.side === "long" ? t.close < t.exitLow : t.close > t.exitHigh) ||
      (t.regime !== null && t.regime !== p.side)) ? "channel_exit" : null;
  }
  return s.ret1hPct !== null && s.macdHistPct !== null && dir*s.ret1hPct < 0 && dir*s.macdHistPct < 0 ? "momentum_reversal" : null;
}

export function activeEntryBlockers(s: CoinStats, ctx: BeeContext): string[] {
  const age = ctx.now - (s.refreshedAt ?? ctx.view.ts);
  if (age < 0 || age > 3 * ctx.cfg.dataRefreshMs) return ["stale_indicators"];
  const reasons: string[] = [];
  if (!currentSignalBar(s,ctx,15)) reasons.push("missing_confirmed_entry_close");
  if (!ctx.cfg.slots[ctx.bee.id].coins.includes(s.coin)) reasons.push("coin_not_allowed");
  if (!ctx.view.gated.includes(s.instId)) reasons.push("market_universe_gate");
  if (!(s.spreadBp <= ctx.knobs.spreadGateBps)) reasons.push("spread_gate");
  if (!(s.vol24hUsd >= ctx.cfg.cats[ctx.bee.id].minVolumeUsd)) reasons.push("liquidity_gate");
  if (!Number.isFinite(s.mid) || s.mid <= 0 || momentumThreshold(s, ctx) === null || s.atr14Pct! * ctx.knobs.stopAtrMult >= 100) reasons.push("missing_atr_stop");
  const settings=ctx.cfg.strategies.tiger, limits=ctx.cfg.cats[ctx.bee.id];
  if (settings.signalMode !== "trend_breakout") {
    if (s.ret1hPct === null || s.macdHistPct === null || !Number.isFinite(s.ret1hPct) || !Number.isFinite(s.macdHistPct)) reasons.push("missing_momentum_data");
    else if (!momentumSide(s, ctx)) reasons.push("momentum_not_confirmed");
  }
  if (settings.signalMode !== "momentum") {
    if (!s.trendBreakout) reasons.push("missing_regime_data");
    else if (settings.signalMode === "trend_breakout" ? !s.trendBreakout.side : !activeSide(s,ctx)) reasons.push(settings.signalMode === "trend_breakout" ? "channel_breakout_not_confirmed" : "regime_not_aligned");
  }
  if (s.atr14Pct !== null && s.atr14Pct*ctx.knobs.stopAtrMult < limits.minStopCostRatio*roundTripCostPct(s,ctx)) reasons.push("move_too_small_after_costs");
  const side=activeSide(s,ctx), close=s.confirmed15m?.close;
  if (side && close && s.atr14Pct && (side === "long" ? 1 : -1)*(s.mid-close)/close*100 > limits.maxEntryChaseAtr*s.atr14Pct) reasons.push("price_extended");
  if (settings.signalMode === "trend_breakout" && side && s.trendBreakout &&
    (side === "long" ? s.mid < s.trendBreakout.entryHigh : s.mid > s.trendBreakout.entryLow)) reasons.push("breakout_retraced");
  return reasons;
}

function candidates(ctx: BeeContext): CoinStats[] {
  return [...ctx.view.stats.values()]
    .filter(s => (BIZZY_BREAKOUT_COINS as readonly string[]).includes(s.coin) && activeEntryBlockers(s, ctx).length === 0)
    .sort((a, b) => Math.abs(b.ret1hPct!) / b.atr14Pct! - Math.abs(a.ret1hPct!) / a.atr14Pct!);
}

export const activeBizzy: BeeBrain = {
  id: "bizzy",
  strategy: "Evaluate the offered LONG or SHORT candidate against WAIT once per completed 15-minute signal bar. Code ranks and filters candidates under the configured momentum, trend-aligned momentum or trend-breakout mode. Prefer persistent directional evidence; an observed past move is not expected future profit. WAIT if the offered trade is unconvincing after costs. While invested, profit reviews can occur between signal bars. Compare HOLD with CLOSE_PROFIT or optional TAKE_PROFIT when offered: hold when directional evidence persists, take some or all profit when momentum weakens or estimated net profit gives back from its peak. Use the supplied profit estimates after costs; never assume a green gross return is a net gain. Code independently enforces signal invalidation, cost-covering stops, trailing stops, peak-profit protection and maximum holding time, even if you HOLD or inference is unavailable. Do not churn on price noise. Choice probabilities are relative menu weights, not calibrated win probabilities; exits use their configured probability threshold without the entry conviction gate, and do not require certainty.",
  convictionLabels: ["meh", "decent", "strong", "very strong"],
  neverForce: true,
  decisionKey: ctx => decisionBarKey(ctx,15),
  profitProtection: true,
  managementKey: profitReviewKey,
  exitGate: ctx => ({ minProb: ctx.cfg.exits[ctx.bee.id].minActionProbability }),
  protectiveExit: exitReason,
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
      regime: s.trendBreakout?.regime ?? null, cost_pct:r2(roundTripCostPct(s,ctx),3),
    };
  },
  menu(ctx) {
    const menu: Menu = {}, p = ctx.bee.position;
    if (!p) {
      for (const s of candidates(ctx).slice(0,ctx.cfg.cats[ctx.bee.id].maxEntryCandidates)) {
        const side = activeSide(s, ctx)!;
        const desc = ctx.cfg.strategies.tiger.signalMode === "trend_breakout"
          ? `confirmed ${ctx.cfg.strategies.tiger.entryBars}-bar breakout with hourly ${side} regime`
          : `${s.ret1hPct!.toFixed(2)}% in 1h, MACD confirms`;
        menu[`${side.toUpperCase()}_${s.coin}`] = { desc, intent: { kind: "open", instId: s.instId, side, sizeFrac: 1, setup: "strict" } };
      }
      if (Object.keys(menu).length) menu.WAIT = { desc: "no convincing opportunity", intent: { kind: "hold" } };
      return menu;
    }
    menu.HOLD = { desc: "momentum still supports the position", intent: { kind: "hold" } };
    const exit = exitReason(ctx);
    if (exit) {
      menu.CLOSE = { desc: "completed-bar signal invalidated", intent: { kind: "close", reason: exit } };
      return menu;
    }
    Object.assign(menu, profitReviewMenu(ctx));
    return menu;
  },
  forcedEntry: () => null,
  sizeFrac: intent => intent.sizeFrac,
  stopFor: (id, side, px, ctx) => atrStop(ctx.view.stats.get(id), side, px, ctx.knobs.stopAtrMult),
  idleStatus: ctx => `waiting for a qualified ${ctx.cfg.strategies.tiger.signalMode.replaceAll("_", " ")} entry`,
};
