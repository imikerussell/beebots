import { describe, expect, it } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import { NOW, position, coin, view, trend } from "./fixtures.js";
import { breakoutLevels } from "../src/market/data.js";
import { donchianEnsemble } from "../src/market/indicators.js";
import { catBrain } from "../src/cats.js";
import { BRAINS } from "../src/bees/index.js";
import type { Candle } from "../src/market/types.js";
const DAY = 86400000, dayStart = Math.floor(NOW / DAY) * DAY;

describe("source strategy parity through the cat adapter", () => {
  it.each(["tiger", "mochi"] as const)("%s preserves menus, snapshots, stops and sizing", id => {
    const h = riskFixture(id), base = BRAINS[h.cfg.slots[id].style];
    const eth = coin("ETH", {trend:trend({score:-8,shortOn:8}),breakout:h.s.breakout});
    h.ctx.view = view([h.s,eth]);
    for (const held of [false,true]) for (const side of ["long","short"] as const) for (const score of [-9,0,6,9]) {
      h.s.trend!.score = score;
      h.b.position = held ? position(h.s,{side,entryScore:9,stopPx:90}) : null;
      h.ctx.uplR = 2;
      expect(h.brain.menu(h.ctx)).toEqual(base.menu(h.ctx));
      expect(h.brain.coinSnapshot(h.s,h.ctx)).toEqual(base.coinSnapshot(h.s,h.ctx));
      expect(h.brain.forcedEntry(h.ctx)).toEqual(base.forcedEntry(h.ctx));
      expect(h.brain.rebalance?.(h.ctx)).toEqual(base.rebalance?.(h.ctx));
      expect(h.brain.stopFor(h.s.instId,side,100,h.ctx)).toEqual(base.stopFor(h.s.instId,side,100,h.ctx));
      expect(h.brain.trail?.(h.ctx)).toEqual(base.trail?.(h.ctx));
      expect(h.brain.timeStopMinutes?.(h.ctx)).toEqual(base.timeStopMinutes?.(h.ctx));
    }
  });
  it("offers both directions and restores winner management, flips and switching", () => {
    const h = riskFixture("mochi");
    h.ctx.view = view([h.s,coin("ETH",{trend:trend({score:-7,shortOn:7})})]);
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["LONG_BTC","SHORT_BTC","LONG_ETH","SHORT_ETH"]);
    h.b.position = position(h.s,{entryScore:9,contracts:10,stopPx:90});
    h.s.trend!.score = 6; h.ctx.uplR = 2;
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["HOLD_WINNER","ADD_TO_WINNER","TRIM_HALF","SHORT_BTC","SWITCH"]);
    h.ctx.uplR = 1;
    expect(h.brain.menu(h.ctx).ADD_TO_WINNER).toBeUndefined();
    expect(h.brain.rebalance!(h.ctx)).not.toBeNull();
  });
  it("preserves the source sizing floor and 60% volatility cap", () => {
    const h = riskFixture("mochi");
    h.s.trend!.score = 1; h.s.trend!.rv90Pct = 20;
    const intent = h.brain.menu(h.ctx).LONG_BTC!.intent;
    expect(intent).toMatchObject({sizeFrac:0.5});
    h.s.trend!.rv90Pct = 200;
    expect(h.brain.menu(h.ctx).LONG_BTC!.intent).toMatchObject({sizeFrac:60/200/1.94});
  });
  it("restores the actual daily Bizzy breakout with no replacement-engine prefilters", () => {
    const h = riskFixture();
    h.s.intraday = undefined; h.s.trend = undefined; h.s.fundingPct = null; h.s.ret1hPct = -1;
    expect(h.brain.menu(h.ctx).BREAKOUT_BTC).toBeDefined();
    expect(h.brain.stopFor(h.s.instId,"long",100,h.ctx)).toBe(99);
    h.s.mid = 99.9;
    expect(h.brain.menu(h.ctx)).toEqual({});
    expect(h.brain.forcedEntry(h.ctx)).toBeNull();
    h.b.position = position(h.s,{stopPx:98,openedAt:NOW});
    expect(h.brain.timeStopMinutes!(h.ctx)).toBe(719);
  });
  it("coach coin filtering restricts new exposure while retaining held-coin exits", () => {
    const h = riskFixture("mochi");
    h.cfg.slots.mochi.coins = ["ETH"];
    h.ctx.view = view([h.s,coin("ETH",{trend:trend({score:7,longOn:7})})]);
    h.b.position = position(h.s,{entryScore:9,stopPx:90}); h.s.trend!.score = 5;
    const brain = catBrain("mochi",h.cfg), menu = brain.menu(h.ctx);
    expect(menu.SHORT_BTC).toBeUndefined();
    expect(menu.TRIM_HALF).toBeDefined();
    expect(menu.SWITCH).toBeDefined();
  });
  it("replays all nine upstream horizons in rising, falling and flat markets", () => {
    const rise=Array.from({length:450},(_,i)=>100+i);
    expect(donchianEnsemble(rise)).toMatchObject({score:9,longOn:9,shortOn:0,slicesAvailable:9});
    expect(donchianEnsemble([...rise].reverse()).score).toBe(-9);
    expect(donchianEnsemble(Array(450).fill(100)).score).toBe(0);
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
