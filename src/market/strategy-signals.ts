import { atr, ema } from "./indicators.js";
import type { Candle } from "./types.js";

export interface TrendBreakoutOptions { entryBars: number; exitBars: number; fastHours: number; slowHours: number }
export interface TrendBreakoutSignal {
  barTs: number; close: number; atrPct: number;
  regime: "long" | "short" | null; side: "long" | "short" | null;
  entryHigh: number; entryLow: number; exitHigh: number; exitLow: number;
  fastEma: number; slowEma: number;
}
const MINUTE = 60000;

/** Causal, contiguous, completed candles; a gap or stale latest close invalidates the signal. */
function complete(candles: Candle[], minutes: number, now: number, count: number): Candle[] | null {
  const period = minutes * MINUTE;
  const bars = candles.filter(c => c.confirmed && c.ts + period <= now).slice(-count);
  if (bars.length < count || bars.at(-1)!.ts !== Math.floor(now/period)*period-period) return null;
  if (bars.some((c,i) => ![c.ts,c.o,c.h,c.l,c.c].every(Number.isFinite) || c.l <= 0 || c.h < c.l ||
    c.o < c.l || c.o > c.h || c.c < c.l || c.c > c.h || (i > 0 && c.ts - bars[i-1]!.ts !== period))) return null;
  return bars;
}

/** Shared by production and historical research. The confirming bar is never in its own channel. */
export function trendBreakoutSignal(c15: Candle[], c1h: Candle[], now: number,
  opts: TrendBreakoutOptions = {entryBars:20,exitBars:10,fastHours:20,slowHours:50}): TrendBreakoutSignal | null {
  if (![opts.entryBars,opts.exitBars,opts.fastHours,opts.slowHours].every(n => Number.isInteger(n) && n >= 2) ||
    opts.fastHours >= opts.slowHours) return null;
  const bars = complete(c15,15,now,Math.max(60,opts.entryBars+1,opts.exitBars+1));
  const hourly = complete(c1h,60,now,3*opts.slowHours);
  if (!bars || !hourly) return null;
  const close = bars.at(-1)!.c, hourlyClose = hourly.at(-1)!.c;
  const fastEma = ema(hourly.map(c=>c.c),opts.fastHours).at(-1)!;
  const slowEma = ema(hourly.map(c=>c.c),opts.slowHours).at(-1)!;
  const regime = hourlyClose > fastEma && fastEma > slowEma ? "long"
    : hourlyClose < fastEma && fastEma < slowEma ? "short" : null;
  const entry = bars.slice(-(opts.entryBars+1),-1), exit = bars.slice(-(opts.exitBars+1),-1);
  const entryHigh = Math.max(...entry.map(c=>c.h)), entryLow = Math.min(...entry.map(c=>c.l));
  const exitHigh = Math.max(...exit.map(c=>c.h)), exitLow = Math.min(...exit.map(c=>c.l));
  const a = atr(bars);
  if (!(a! > 0) || !Number.isFinite(a)) return null;
  return {barTs:bars.at(-1)!.ts,close,atrPct:a!/close*100,regime,
    side:regime === "long" && close > entryHigh ? "long" : regime === "short" && close < entryLow ? "short" : null,
    entryHigh,entryLow,exitHigh,exitLow,fastEma,slowEma};
}
