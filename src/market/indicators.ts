// Hand-rolled indicators on X-Perp candles (the kit's indicator tools are only documented for SWAP/SPOT ids).
// All inputs are oldest-first. Each function returns null when there is not enough data.

import type { Candle, TrendStats } from "./types.js";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

/** Wilder RSI. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** MACD(12,26,9). Returns the latest line, signal and histogram. */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): { line: number; signal: number; hist: number } | null {
  if (closes.length < slow + signal) return null;
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => f[i]! - s[i]!);
  const sig = ema(line.slice(slow - 1), signal);
  const l = line[line.length - 1]!;
  const sg = sig[sig.length - 1]!;
  return { line: l, signal: sg, hist: l - sg };
}

/** Wilder ATR, in price units. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const pc = candles[i - 1]!.c;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]!) / period;
  return a;
}

/** Bollinger(20, 2σ) on typical price (as in BbandRsi). %B is 0 at the lower band and 1 at the upper band. */
export function bollinger(candles: Candle[], period = 20, k = 2): { mid: number; upper: number; lower: number; pctB: number; widthPct: number } | null {
  if (candles.length < period) return null;
  const tp = candles.slice(-period).map((c) => (c.h + c.l + c.c) / 3);
  const mid = tp.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(tp.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const close = candles[candles.length - 1]!.c;
  const pctB = upper === lower ? 0.5 : (close - lower) / (upper - lower);
  return { mid, upper, lower, pctB, widthPct: mid ? ((upper - lower) / mid) * 100 : 0 };
}

export function pctChange(from: number | undefined, to: number | undefined): number | null {
  if (from === undefined || to === undefined || !(from > 0)) return null;
  return ((to - from) / from) * 100;
}

export function zScore(latest: number, history: number[]): number | null {
  if (history.length < 5) return null;
  const m = history.reduce((a, b) => a + b, 0) / history.length;
  const sd = Math.sqrt(history.reduce((a, b) => a + (b - m) ** 2, 0) / history.length);
  if (sd === 0) return 0;
  return (latest - m) / sd;
}

/** Annualised realised vol of log returns, in %. `barsPerYear` = 6*365 for 4h bars. */
export function realisedVolPct(closes: number[], lookback: number, barsPerYear: number): number | null {
  if (closes.length < lookback + 1) return null;
  const xs = closes.slice(-(lookback + 1));
  const r: number[] = [];
  for (let i = 1; i < xs.length; i++) r.push(Math.log(xs[i]! / xs[i - 1]!));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * barsPerYear) * 100;
}

export const DONCHIAN_LOOKBACKS = [5, 10, 20, 30, 60, 90, 150, 250, 360] as const;

/**
 * Ensemble Donchian (Zarattini, Pagani & Barbon 2025), mirrored for shorts.
 * Each slice is replayed over the whole history: a close above the highest close of the prior L bars
 * turns it long; below the lowest close turns it short. While on, its trailing stop ratchets to the
 * better of the prior stop and the channel midpoint; a close through the stop turns it off.
 * Slices whose lookback exceeds the available history are left out of `slicesAvailable`.
 */
export function donchianEnsemble(closes: number[], lookbacks: readonly number[] = DONCHIAN_LOOKBACKS): Pick<TrendStats, "score" | "longOn" | "shortOn" | "slicesAvailable" | "trailStop"> {
  let longOn = 0;
  let shortOn = 0;
  let slicesAvailable = 0;
  const longStops: number[] = [];
  const shortStops: number[] = [];
  for (const L of lookbacks) {
    if (closes.length < L + 1) continue;
    slicesAvailable++;
    let state: "off" | "long" | "short" = "off";
    let stop = 0;
    for (let i = L; i < closes.length; i++) {
      const window = closes.slice(i - L, i);
      const hi = Math.max(...window);
      const lo = Math.min(...window);
      const mid = (hi + lo) / 2;
      const c = closes[i]!;
      if (state === "long") {
        stop = Math.max(stop, mid);
        if (c < stop) state = "off";
      } else if (state === "short") {
        stop = Math.min(stop, mid);
        if (c > stop) state = "off";
      }
      if (state !== "long" && c > hi) {
        state = "long";
        stop = mid;
      } else if (state !== "short" && c < lo) {
        state = "short";
        stop = mid;
      }
    }
    if (state === "long") {
      longOn++;
      longStops.push(stop);
    } else if (state === "short") {
      shortOn++;
      shortStops.push(stop);
    }
  }
  const score = longOn - shortOn;
  const stops = score > 0 ? longStops : score < 0 ? shortStops : [];
  const trailStop = stops.length ? stops.reduce((a, b) => a + b, 0) / stops.length : null;
  return { score, longOn, shortOn, slicesAvailable, trailStop };
}

export function trendStats(c4h: Candle[]): TrendStats {
  const closes = c4h.map((c) => c.c);
  const d = donchianEnsemble(closes);
  const last = closes[closes.length - 1];
  const a = atr(c4h, 14);
  let tenDayExtreme: -1 | 0 | 1 = 0;
  if (closes.length >= 60 && last !== undefined) {
    const w = closes.slice(-60);
    if (last >= Math.max(...w)) tenDayExtreme = 1;
    else if (last <= Math.min(...w)) tenDayExtreme = -1;
  }
  return {
    ...d,
    atr4hPct: a !== null && last ? (a / last) * 100 : null,
    rv90Pct: realisedVolPct(closes, 90, 6 * 365),
    tenDayExtreme,
  };
}
