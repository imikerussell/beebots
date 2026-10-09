import { describe, expect, it } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import { NOW, position, coin, trend, view } from "./fixtures.js";
import { breakoutLevels } from "../src/market/data.js";
import { donchianEnsemble } from "../src/market/indicators.js";
import { loadConfig } from "../src/config.js";
import type { Candle } from "../src/market/types.js";

const DAY = 86400000, dayStart = Math.floor(NOW / DAY) * DAY;
describe("restored Breezy / Mochi rules", () => {
  it("uses the 4h stop and channel trail, independently of 15m noise", () => {
    const h = riskFixture("mochi");
    h.s.atr14Pct = 99;
    expect(h.brain.stopFor(h.s.instId, "long", 100, h.ctx)).toBe(97);
    h.b.position = position(h.s);
    h.s.trend!.trailStop = 98;
    expect(h.brain.trail!(h.ctx)).toBe(98);
    h.s.refreshedAt = NOW - 4 * h.cfg.dataRefreshMs;
    expect(h.brain.trail!(h.ctx)).toBeNull();
  });
  it("sizes from score and measured volatility, without an exposure floor", () => {
    const h = riskFixture("mochi");
    h.cfg.cats.mochi.stopRiskPct = 10; // Make the notional cap binding to test the volatility constraint.
    h.s.trend!.score = 6;
    expect(h.brain.sizeFrac(h.proposal.intent as never, 3, h.ctx)).toBeCloseTo(6 / 9);
    const calm = h.run().action;
    h.s.trend!.rv90Pct = 200;
    expect(h.brain.sizeFrac(h.proposal.intent as never, 3, h.ctx)).toBe(0.25);
    const volatile = h.run().action;
    expect(calm.kind).toBe("open"); expect(volatile.kind).toBe("open");
    if (calm.kind === "open" && volatile.kind === "open") expect(volatile.notionalUsd).toBeLessThan(calm.notionalUsd);
    for (const rv of [null, NaN, Infinity, 0, -1]) {
      h.s.trend!.rv90Pct = rv;
      expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT"]);
    }
  });
  it("selects the strongest coin, then the 10-day high; short-term MACD cannot replace the trend", () => {
    const h = riskFixture("mochi");
    const eth = coin("ETH", { trend: trend({ score: 9, longOn: 9, tenDayExtreme: 1 }) });
    h.ctx.view = view([h.s, eth]);
    h.s.ret1hPct = -0.1; h.s.macdHistPct = -0.1;
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT", "LONG_ETH"]);
    eth.trend!.score = 7;
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT", "LONG_BTC"]);
    h.s.trend!.shortOn = 1; eth.trend!.slicesAvailable = 8;
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT"]);
  });
  it("offers one half-trim after deterioration and exits a lost trend without the model", () => {
    const h = riskFixture("mochi");
    h.b.position = position(h.s, { stopPx: 90, entryScore: 9 });
    h.s.trend!.score = 6;
    expect(h.brain.menu(h.ctx).TRIM_HALF).toBeDefined();
    h.b.position.trendTrimmed = true;
    expect(h.brain.menu(h.ctx).TRIM_HALF).toBeUndefined();
    h.s.trend!.score = 0;
    h.b.tradesToday = 100; h.b.feesTodayUsd = 100;
    expect(h.run(null, false)).toMatchObject({ action: { kind: "close", reason: "trend_lost" } });
    h.s.refreshedAt = NOW - 4 * h.cfg.dataRefreshMs;
    expect(h.run(null, false).action.kind).toBe("none");
  });
  it("replays nine channels on rising, falling and flat confirmed-close histories", () => {
    const rise = Array.from({ length: 450 }, (_, i) => 100 + i);
    expect(donchianEnsemble(rise)).toMatchObject({ score: 9, longOn: 9, shortOn: 0, slicesAvailable: 9 });
    expect(donchianEnsemble([...rise].reverse()).score).toBe(-9);
    expect(donchianEnsemble(Array(450).fill(100)).score).toBe(0);
    expect(donchianEnsemble(rise.slice(0, 300)).slicesAvailable).toBe(8);
  });
});

describe("adapted Bizzy / Tiger rules", () => {
  it("requires an actual confirmed breakout, not just generic momentum", () => {
    const h = riskFixture();
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeDefined();
    h.s.confirmed15m!.close = 99.9;
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeUndefined();
    h.s.confirmed15m!.close = 100;
    h.s.breakout = null;
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT"]);
  });
  it("rejects late, stretched, stale-day, crowded-funding and already-used setups", () => {
    const scenarios: Array<(h: ReturnType<typeof riskFixture>) => void> = [
      h => { h.s.mid = 100.51; },
      h => { h.s.breakout!.dayStart! -= DAY; },
      h => { h.s.confirmed15m!.ts = NOW - 60000; },
      h => { h.s.confirmed15m!.ts = NOW - 32 * 60000; },
      h => { h.s.fundingPct = 0.04; },
      h => { h.s.fundingPct = null; },
      h => { h.b.tradesToday = 1; },
      h => { h.ctx.now = dayStart + DAY - 30 * 60000; h.s.refreshedAt = h.ctx.now; h.s.confirmed15m!.ts = h.ctx.now - 900000; },
    ];
    for (const mutate of scenarios) { const h = riskFixture(); mutate(h); expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT"]); }
  });
  it("uses the day-open stop, never shorts, and exits at 23:59 despite entry caps/model failure", () => {
    const h = riskFixture();
    expect(h.brain.stopFor(h.s.instId, "long", 100, h.ctx)).toBe(99);
    expect(h.brain.stopFor(h.s.instId, "short", 100, h.ctx)).toBeNull();
    h.b.position = position(h.s, { stopPx: 99, openedAt: NOW });
    h.ctx.now = dayStart + DAY - 60000;
    h.v.tickers.get(h.s.instId)!.ts = h.ctx.now;
    h.b.tradesToday = 100; h.b.feesTodayUsd = 100;
    expect(h.run(null, false)).toMatchObject({ action: { kind: "close", reason: "time_stop" } });
  });
  it("validates the editable strategy parameters", () => {
    for (const env of [{ TIGER_BREAKOUT_K: "0" }, { MOCHI_VOL_TARGET_PCT: "NaN" }, { MOCHI_TRIM_SCORE_DROP: "1.5" }, { TIGER_MAX_CHASE_RANGE_FRAC: "-1" }])
      expect(() => loadConfig(env)).toThrow();
  });
});

describe("daily breakout market inputs", () => {
  const candles: Candle[] = Array.from({ length: 25 }, (_, i) => ({
    ts: dayStart - DAY + i * 3600000, o: 100, h: 104, l: 96, c: 101, volUsd: 1e6, confirmed: i < 24,
  }));
  it("uses all 24 completed prior hours and the actual midnight open, with configurable k", () => {
    expect(breakoutLevels(candles, NOW, 0.5)).toEqual({ dayOpen: 100, prevRange: 8, trigger: 104, dayStart });
    expect(breakoutLevels(candles, NOW, 0.25)?.trigger).toBe(102);
    const future = { ...candles[24]!, ts: dayStart + DAY, o: 9999 };
    expect(breakoutLevels([...candles, future], NOW, 0.5)?.trigger).toBe(104);
  });
  it("rejects missing/duplicate/unconfirmed hours, zero range and missing midnight open", () => {
    expect(breakoutLevels(candles.slice(1), NOW, 0.5)).toBeNull();
    expect(breakoutLevels([...candles.slice(1), candles[1]!], NOW, 0.5)).toBeNull();
    expect(breakoutLevels(candles.map((c, i) => i === 0 ? { ...c, confirmed: false } : c), NOW, 0.5)).toBeNull();
    expect(breakoutLevels(candles.map(c => ({ ...c, h: 100, l: 100 })), NOW, 0.5)).toBeNull();
    expect(breakoutLevels(candles.map((c, i) => i === 24 ? { ...c, ts: dayStart + 3600000 } : c), NOW, 0.5)).toBeNull();
  });
});
