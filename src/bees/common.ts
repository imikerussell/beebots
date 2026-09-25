import type { CoinStats } from "../market/types.js";
import type { BeeContext, Position, Side } from "./types.js";

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

/** Max notional before the live ramp: min(MAX_LEVERAGE x equity, MAX_NOTIONAL_USD_PER_BEE). */
export function maxNotionalUsd(ctx: BeeContext): number {
  return Math.max(0, Math.min(ctx.cfg.risk.maxLeverage * ctx.bee.equityUsd, ctx.cfg.risk.maxNotionalUsdPerBee));
}

/** ATR-multiple stop from the 15m ATR%. */
export function atrStop(s: CoinStats | undefined, side: Side, entryPx: number, mult: number): number | null {
  if (!s || s.atr14Pct === null) return null;
  const dist = entryPx * (s.atr14Pct / 100) * mult;
  return side === "long" ? entryPx - dist : entryPx + dist;
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
        held_min: r2(minutesSince(p.openedAt, now), 0),
      }
    : { pos: "flat", flat_min: r2(minutesSince(bee.flatSince, now), 0) };
  line.trades = `${bee.tradesToday}/${knobs.maxTradesPerDay}`;
  line.fee_left = r2(knobs.feeBudgetUsdDay - bee.feesTodayUsd);
  return line;
}
