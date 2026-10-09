import { describe, expect, it } from "vitest";
import { requireRecentCandles } from "../src/market/data.js";
import type { Candle } from "../src/market/types.js";
const now = Date.UTC(2026, 9, 9, 10, 1);
const bar: Candle = {
  ts: now - 16 * 60000,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  volUsd: 1000,
  confirmed: true,
};
describe("confirmed candle freshness", () => {
  it("accepts a recently completed bar and rejects old history returned by a successful request", () => {
    expect(() => requireRecentCandles([bar], 15 * 60000, now)).not.toThrow();
    expect(() =>
      requireRecentCandles([{ ...bar, ts: now - 3600000 }], 15 * 60000, now),
    ).toThrow(/stale/);
  });
  it("fails closed on missing, unconfirmed or future history", () => {
    for (const candles of [
      [],
      [{ ...bar, confirmed: false }],
      [{ ...bar, ts: now + 1 }],
    ]) {
      expect(() => requireRecentCandles(candles, 15 * 60000, now)).toThrow();
    }
  });
});
