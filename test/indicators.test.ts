import { describe, expect, it } from "vitest";
import { atr, bollinger, donchianEnsemble, ema, macd, rsi, zScore } from "../src/market/indicators.js";
import type { Candle } from "../src/market/types.js";

const candles = (closes: number[]): Candle[] => closes.map((c, i) => ({ ts: i, o: c, h: c * 1.01, l: c * 0.99, c, volUsd: 1000, confirmed: true }));

describe("indicators", () => {
  it("RSI is 100 on a straight rise, 0 on a straight fall, ~50 on alternation", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up)).toBe(100);
    expect(rsi([...up].reverse())).toBeCloseTo(0, 5);
    const alt = Array.from({ length: 60 }, (_, i) => (i % 2 ? 101 : 100));
    expect(rsi(alt)!).toBeGreaterThan(45);
    expect(rsi(alt)!).toBeLessThan(55);
  });

  it("RSI matches the Wilder reference on a known series", () => {
    // Worked by hand: gains 3.34/14, losses 1.40/14 -> RSI = 100 - 100/(1 + 3.34/1.40) = 70.464
    const px = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(rsi(px)!).toBeCloseTo(70.464, 3);
  });

  it("returns null without enough data", () => {
    expect(rsi([1, 2, 3])).toBeNull();
    expect(atr(candles([1, 2]))).toBeNull();
    expect(bollinger(candles([1, 2, 3]))).toBeNull();
    expect(macd([1, 2, 3])).toBeNull();
  });

  it("EMA converges to a constant", () => {
    expect(ema(Array(50).fill(7), 10).at(-1)).toBeCloseTo(7);
  });

  it("MACD histogram is positive in an accelerating rise", () => {
    const xs = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.05);
    expect(macd(xs)!.hist).toBeGreaterThan(0);
  });

  it("ATR on constant 2% ranges is about 2% of price", () => {
    expect(atr(candles(Array(40).fill(100)))!).toBeCloseTo(2, 5);
  });

  it("%B is below 0 after a drop through the lower band", () => {
    const xs = [...Array(25).fill(100).map((x, i) => x + (i % 2 ? 0.5 : -0.5)), 95];
    expect(bollinger(candles(xs))!.pctB).toBeLessThan(0);
  });

  it("zScore", () => {
    expect(zScore(10, [1, 2, 3, 4, 5])!).toBeGreaterThan(3);
    expect(zScore(3, [1, 2, 3, 4, 5])).toBe(0);
    expect(zScore(3, [1, 2])).toBeNull();
  });
});

describe("ensemble Donchian", () => {
  it("scores +N on a clean uptrend, -N on a downtrend", () => {
    const up = Array.from({ length: 400 }, (_, i) => 100 + i);
    const d = donchianEnsemble(up);
    expect(d.slicesAvailable).toBe(9);
    expect(d.score).toBe(9);
    expect(d.trailStop).not.toBeNull();
    expect(d.trailStop!).toBeLessThan(up.at(-1)!);
    expect(donchianEnsemble([...up].reverse()).score).toBe(-9);
  });

  it("only counts slices that have enough history", () => {
    const d = donchianEnsemble(Array.from({ length: 100 }, (_, i) => 100 + i));
    expect(d.slicesAvailable).toBe(6); // 5,10,20,30,60,90
    expect(d.score).toBe(6);
  });

  it("a sharp reversal turns short slices on and fast long slices off", () => {
    const xs = [...Array.from({ length: 200 }, (_, i) => 100 + i), ...Array.from({ length: 15 }, (_, i) => 299 - i * 8)];
    const d = donchianEnsemble(xs);
    expect(d.shortOn).toBeGreaterThan(0);
    expect(d.score).toBeLessThan(6);
  });
});
