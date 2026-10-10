import { describe, expect, it } from "vitest";
import { intradaySignal } from "../src/market/data.js";
import { intradayTrend } from "../src/market/indicators.js";
import type { Candle } from "../src/market/types.js";
import { riskFixture } from "./risk-fixture.js";
import { NOW, position } from "./fixtures.js";
const bars = (minutes: number): Candle[] => Array.from({length: 200}, (_, i) => ({
  ts: NOW - (200 - i) * minutes * 60000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, confirmed: true, volUsd: 1000,
}));
describe("intraday data and protective rules", () => {
  it("excludes the entry candle from its breakout and ignores unfinished/future spikes", () => {
    const entries = bars(5), trends = bars(15);
    entries.at(-1)!.c = entries.at(-1)!.h = 400;
    const expected = intradaySignal(entries, trends, 5, 15, NOW);
    expect(expected.breakout!.trigger).toBe(299);
    expect(expected.confirmed.close).toBe(400);
    const spike = {...entries.at(-1)!, ts: NOW, c: 99999, h: 99999, confirmed: false};
    expect(intradaySignal([...entries, spike], [...trends, spike], 5, 15, NOW)).toEqual(expected);
    expect(intradaySignal([...entries, {...spike, confirmed: true}], trends, 5, 15, NOW)).toEqual(expected);
  });
  it("rejects gaps, duplicates, stale history and insufficient warmup", () => {
    const entries = bars(5), trends = bars(15);
    for (const invalid of [entries.slice(-80), entries.filter((_, i) => i !== 180), [...entries.slice(0, -1), entries.at(-2)!]])
      expect(() => intradaySignal(invalid, trends, 5, 15, NOW)).toThrow();
    expect(() => intradaySignal(entries, trends, 5, 15, NOW + 20 * 60000)).toThrow(/stale/);
  });
  it("uses nine short horizons and annualizes volatility for the actual candle duration", () => {
    const candles = bars(15);
    expect(intradayTrend(candles, 96)).toMatchObject({score: 9, slicesAvailable: 9});
    expect(intradayTrend(candles, 96).rv90Pct).toBeCloseTo(intradayTrend(candles, 24).rv90Pct! * 2);
  });
  it("does not use the historical four-hour signal or daily breakout as an entry gate", () => {
    for (const id of ["tiger", "mochi"] as const) {
      const h = riskFixture(id); h.s.trend!.score = -9; h.s.breakout = null;
      expect(h.brain.menu(h.ctx).LONG_BTC).toBeDefined();
      h.s.intraday = undefined;
      expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT"]);
    }
  });
  it("blocks movements too small for estimated fees, spread and slippage", () => {
    const h = riskFixture(); h.s.intraday!.tiger.atrPct = 0.01;
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeUndefined();
    h.s.intraday!.tiger.atrPct = 0.5;
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeDefined();
  });
  it.each(["tiger", "mochi"] as const)("%s exits at the holding limit without model access or entry budget", id => {
    const h = riskFixture(id); h.b.position = position(h.s, {stopPx: 90, openedAt: NOW});
    h.b.tradesToday = 100; h.b.feesTodayUsd = 100;
    h.ctx.now = NOW + h.cfg.strategies[id].maxHoldMinutes * 60000;
    h.v.tickers.get(h.s.instId)!.ts = h.ctx.now;
    expect(h.run(null, false).action).toMatchObject({kind: "close", reason: "time_stop"});
  });
});
