import type { CoinStats } from "../market/types.js";
import type { BeeContext, BeeState, Position, Side } from "./types.js";

/** Keep actual daily entries intact while an owner can renew the entry allowance. */
export const entriesUsed = (bee: BeeState): number => Math.max(0, bee.tradesToday - (bee.entryLimitBaseline ?? 0));

export const roundTripCostPct = (s: CoinStats, ctx: BeeContext): number =>
  200 * ctx.cfg.risk.takerFeeRate + (s.spreadBp + 2*ctx.cfg.paperSlippageBps)/100;

export function currentSignalBar(s: CoinStats, ctx: BeeContext, minutes: 15 | 240): boolean {
  const period = minutes*60000, candle = minutes === 15 ? s.confirmed15m : s.confirmed4h;
  const age = ctx.now - (s.refreshedAt ?? ctx.view.ts);
  return !!candle && Number.isFinite(candle.close) && candle.close > 0 &&
    candle.ts === Math.floor(ctx.now/period)*period-period && age >= 0 && age <= 3*ctx.cfg.dataRefreshMs;
}
/** One canonical bar key; late coins are excluded until the next bar, never a second model draw. */
export function decisionBarKey(ctx: BeeContext, minutes: 15 | 240): string | null {
  const relevant = [...ctx.view.stats.values()].filter(s => ctx.bee.position ? s.instId === ctx.bee.position.instId
    : ctx.cfg.slots[ctx.bee.id].coins.includes(s.coin) && ctx.view.gated.includes(s.instId));
  return relevant.some(s => currentSignalBar(s,ctx,minutes)) ? `${minutes}:${Math.floor(ctx.now/(minutes*60000))-1}` : null;
}

export const r2 = (x: number | null | undefined, d = 2): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

export function positionNotional(p: Position, markPx: number, ctVal: number): number {
  return p.contracts * ctVal * markPx;
}

export function uplUsd(p: Position, markPx: number, ctVal: number): number {
  const dir = p.side === "long" ? 1 : -1;
  return dir * (markPx - p.entryPx) * p.contracts * ctVal;
}

export function minutesSince(ts: number | null, now: number): number {
  return ts === null ? 0 : Math.max(0, (now - ts) / 60_000);
}

/**
 * Share of full leverage an order may use. At exactly MAX_LEVERAGE x equity, isolated margin needs every cent of the
 * balance plus the fee, and OKX rejects it (51008 insufficient margin: bizzy's 2x breakout, 27 Sep 02:06Z).
 */
export const MARGIN_HEADROOM = 0.97;

/** Max notional before the live ramp: min(MAX_LEVERAGE x equity x MARGIN_HEADROOM, MAX_NOTIONAL_USD_PER_BEE). */
export function maxNotionalUsd(ctx: BeeContext): number {
  return Math.max(0, Math.min(ctx.cfg.risk.maxLeverage * ctx.bee.equityUsd * MARGIN_HEADROOM, ctx.cfg.risk.maxNotionalUsdPerBee, ctx.bee.equityUsd * (ctx.cfg.cats[ctx.bee.id]?.maxNotionalPct ?? Infinity) / 100));
}

/** ATR-multiple stop from the 15m ATR%. */
export function atrStop(s: CoinStats | undefined, side: Side, entryPx: number, mult: number): number | null {
  if (!s || s.atr14Pct === null) return null;
  const dist = entryPx * (s.atr14Pct / 100) * mult;
  return side === "long" ? entryPx - dist : entryPx + dist;
}

/**
 * Profit-lock stop candidate, or null below the first rung. `peakPx` is the best price since entry in the position's
 * favour; the stop keeps `keep` of the move from `entryPx` to it.
 */
export function profitLockStop(side: Side, entryPx: number, peakPx: number, rungs: ReadonlyArray<{ atPct: number; keep: number }>): number | null {
  const dir = side === "long" ? 1 : -1;
  const move = dir * (peakPx - entryPx);
  if (!(move > 0) || !(entryPx > 0)) return null;
  const gainPct = (move / entryPx) * 100;
  let keep = 0;
  for (const r of rungs) if (gainPct >= r.atPct) keep = Math.max(keep, r.keep);
  return keep > 0 ? entryPx + dir * keep * move : null;
}

/** Shared per-bee state line for every snapshot. */
export function beeLine(ctx: BeeContext): Record<string, number | string | null> {
  const { bee, knobs, now } = ctx;
  const p = bee.position;
  const s = p ? ctx.view.stats.get(p.instId) : undefined;
  const inst = p ? ctx.view.instruments.get(p.instId) : undefined;
  const line: Record<string, number | string | null> = p
    ? {
        pos: `${p.side} ${p.coin}`,
        usd: s && inst ? r2(positionNotional(p, s.mid, inst.ctVal), 0) : null,
        upl_r: r2(ctx.uplR, 1),
        // P&L if the stop were hit right now (the stop trails, so this can be above zero).
        at_stop_usd: s && inst && p.stopPx !== null ? r2((p.side === "long" ? 1 : -1) * (p.stopPx - p.entryPx) * p.contracts * inst.ctVal, 0) : null,
        held_min: r2(minutesSince(p.openedAt, now), 0),
      }
    : { pos: "flat", flat_min: r2(minutesSince(bee.flatSince, now), 0) };
  line.trades = `${entriesUsed(bee)}/${knobs.maxTradesPerDay}`;
  line.fee_left = r2(knobs.feeBudgetUsdDay - bee.feesTodayUsd);
  return line;
}
