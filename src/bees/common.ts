import type { CoinStats } from "../market/types.js";
import type { BeeContext, Position, Side } from "./types.js";

export const r2 = (x: number | null | undefined, d = 2): number | null =>
  x === null || x === undefined || !Number.isFinite(x)
    ? null
    : Number(x.toFixed(d));

export function positionNotional(
  p: Position,
  markPx: number,
  ctVal: number,
): number {
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
  const cat = ctx.cfg.cats[ctx.bee.id];
  return Math.max(
    0,
    Math.min(
      ctx.cfg.risk.maxLeverage * ctx.bee.equityUsd * MARGIN_HEADROOM,
      ctx.cfg.risk.maxNotionalUsdPerBee,
      cat ? ctx.bee.equityUsd * cat.maxNotionalPct / 100 : Infinity,
    ),
  );
}

/** ATR-multiple stop from the 15m ATR%. */
export function atrStop(
  s: CoinStats | undefined,
  side: Side,
  entryPx: number,
  mult: number,
): number | null {
  if (!s || s.atr14Pct === null) return null;
  const dist = entryPx * (s.atr14Pct / 100) * mult;
  return side === "long" ? entryPx - dist : entryPx + dist;
}

/**
 * Profit-lock stop candidate, or null below the first rung. `peakPx` is the best price since entry in the position's
 * favour; the stop keeps `keep` of the move from `entryPx` to it.
 */
export function profitLockStop(
  side: Side,
  entryPx: number,
  peakPx: number,
  rungs: ReadonlyArray<{ atPct: number; keep: number }>,
): number | null {
  const dir = side === "long" ? 1 : -1;
  const move = dir * (peakPx - entryPx);
  if (!(move > 0) || !(entryPx > 0)) return null;
  const gainPct = (move / entryPx) * 100;
  let keep = 0;
  for (const r of rungs) if (gainPct >= r.atPct) keep = Math.max(keep, r.keep);
  return keep > 0 ? entryPx + dir * keep * move : null;
}

/** Shared per-bee state line for every snapshot. */
export function beeLine(
  ctx: BeeContext,
): Record<string, number | string | null> {
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
        at_stop_usd:
          s && inst && p.stopPx !== null
            ? r2(
                (p.side === "long" ? 1 : -1) *
                  (p.stopPx - p.entryPx) *
                  p.contracts *
                  inst.ctVal,
                0,
              )
            : null,
        held_min: r2(minutesSince(p.openedAt, now), 0),
        entry_trend_score: p.entryScore ?? null,
        trend_trimmed: p.trendTrimmed ? "yes" : "no",
      }
    : { pos: "flat", flat_min: r2(minutesSince(bee.flatSince, now), 0) };
  line.trades = `${bee.tradesToday}/${knobs.maxTradesPerDay}`;
  line.fee_left = r2(knobs.feeBudgetUsdDay - bee.feesTodayUsd);
  return line;
}
