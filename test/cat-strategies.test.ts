import { describe, expect, it } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import { NOW, position, coin, view, trend } from "./fixtures.js";
import { breakoutLevels } from "../src/market/data.js";
import { donchianEnsemble } from "../src/market/indicators.js";
import { catBrain } from "../src/cats.js";
import { BRAINS } from "../src/bees/index.js";
import { profitStopCandidate } from "../src/bees/profit-management.js";
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
  it("ranks a single directional candidate and retains a continuing winner without switching", () => {
    const h = riskFixture("mochi");
    h.ctx.view = view([h.s,coin("ETH",{trend:trend({score:-7,shortOn:7})})]);
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["LONG_BTC","WAIT"]);
    h.cfg.cats.mochi.maxEntryCandidates=2;
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["LONG_BTC","SHORT_ETH","WAIT"]);
    h.b.position = position(h.s,{entryScore:9,contracts:10,stopPx:90});
    h.s.trend!.score = 6; h.ctx.uplR = 2;
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["HOLD_WINNER","TRIM_HALF"]);
    h.ctx.uplR = 1;
    expect(h.brain.menu(h.ctx).ADD_TO_WINNER).toBeUndefined();
    expect(h.brain.rebalance).toBeUndefined();
  });
  it("honors the configured trend and volatility target without a forced sizing floor", () => {
    const h = riskFixture("mochi");
    h.cfg.strategies.mochi.minTrendScore = 1; h.s.trend!.score = 1; h.s.trend!.rv90Pct = 20;
    const intent = h.brain.menu(h.ctx).LONG_BTC!.intent;
    expect(intent).toMatchObject({sizeFrac:1/9});
    h.s.trend!.rv90Pct = 200;
    const capped = h.brain.menu(h.ctx).LONG_BTC!.intent;
    expect(capped.kind === "open" && capped.sizeFrac).toBeCloseTo(25/200/1.94);
  });
  it("offers long and short momentum without requiring a daily breakout", () => {
    const h = riskFixture();
    h.s.breakout = null; h.s.intraday = undefined; h.s.trend = undefined;
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeDefined();
    expect(h.brain.stopFor(h.s.instId,"long",100,h.ctx)).toBe(99.25);
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2;
    expect(h.brain.menu(h.ctx).SHORT_BTC?.intent).toMatchObject({kind:"open",side:"short"});
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeUndefined();
    expect(h.brain.stopFor(h.s.instId,"short",100,h.ctx)).toBe(100.75);
    h.s.ret1hPct = 0;
    expect(h.brain.menu(h.ctx)).toEqual({});
    expect(h.brain.forcedEntry(h.ctx)).toBeNull();
    expect(h.brain.timeStopMinutes!(h.ctx)).toBe(120);
  });
  it("offers both directions across the expanded universe with a 12-entry daily budget", () => {
    const h = riskFixture();
    expect(h.cfg.slots.tiger.coins).toHaveLength(12);
    for (const name of h.cfg.slots.tiger.coins) {
      const s = coin(name, {ret1hPct:1,macdHistPct:0.2});
      h.ctx.view = view([s]);
      expect(h.brain.menu(h.ctx)[`LONG_${name}`]?.intent).toMatchObject({kind:"open",side:"long",instId:s.instId});
      s.ret1hPct = -1; s.macdHistPct = -0.2;
      expect(h.brain.menu(h.ctx)[`SHORT_${name}`]?.intent).toMatchObject({kind:"open",side:"short",instId:s.instId});
      expect(h.brain.forcedEntry(h.ctx)).toBeNull();
    }
    expect(h.cfg.cats.tiger.maxTradesPerDay).toBe(12);
    expect(h.cfg.cats.tiger.cooldownMinutes).toBe(5);
    expect(h.cfg.cats.tiger.longOnly).toBe(false);
  });
  it("rejects small/conflicting moves, missing ATR, stale data and illiquid or wide markets", () => {
    for (const patch of [{ret1hPct:0.1},{ret1hPct:-1},{macdHistPct:-0.2},{atr14Pct:null},{atr14Pct:NaN},{ret1hPct:NaN},{refreshedAt:NOW-240000},{vol24hUsd:100},{spreadBp:20}]) {
      const h = riskFixture(); Object.assign(h.s, patch);
      expect(h.brain.menu(h.ctx), JSON.stringify(patch)).toEqual({});
    }
  });
  it("holds profit or loss while the signal persists and exits deterministically on invalidation", () => {
    const h = riskFixture(); h.b.position = position(h.s,{stopPx:90});
    for (const profit of [-1,1]) {
      h.b.uplUsd = profit;
      expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["HOLD"]);
      expect(h.brain.protectiveExit!(h.ctx)).toBeNull();
    }
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2;
    expect(h.brain.menu(h.ctx).CLOSE?.intent).toMatchObject({kind:"close",reason:"momentum_reversal"});
    expect(h.brain.menu(h.ctx).FLIP_SHORT).toBeUndefined();
    expect(h.brain.protectiveExit!(h.ctx)).toBe("momentum_reversal");
    h.cfg.slots.tiger.coins = ["ETH"];
    const restricted = catBrain("tiger",h.cfg);
    expect(restricted.menu(h.ctx).CLOSE).toBeDefined();
    expect(restricted.menu(h.ctx).FLIP_SHORT).toBeUndefined();
  });
  it("trails a short after its configured net R threshold with an independent ATR distance", () => {
    const h = riskFixture(); h.b.position = position(h.s,{side:"short",stopPx:110,riskUsd:1});
    Object.assign(h.cfg.exits.tiger,{breakevenAtR:0,profitLockAtR:0,trailActivationR:0.75,trailAtrMult:1.2});
    const t = h.ctx.view.tickers.get(h.s.instId)!;
    Object.assign(t,{mid:99.6,bid:99.59,ask:99.61});
    expect(profitStopCandidate(h.ctx)?.stopPx).toBeNull();
    Object.assign(t,{mid:98.8,bid:98.79,ask:98.81});
    expect(profitStopCandidate(h.ctx)?.stopPx).toBeCloseTo(98.8*(1+0.005*1.2));
    expect(h.brain.stopFor(h.s.instId,"short",100,h.ctx)).toBe(100.75);
    h.s.refreshedAt = NOW - 240000; expect(profitStopCandidate(h.ctx)?.stopPx).toBeNull();
  });
  it("coach coin filtering restricts new exposure while retaining held-coin exits", () => {
    const h = riskFixture("mochi");
    h.cfg.slots.mochi.coins = ["ETH"];
    h.ctx.view = view([h.s,coin("ETH",{trend:trend({score:7,longOn:7})})]);
    h.b.position = position(h.s,{entryScore:9,stopPx:90}); h.s.trend!.score = 5;
    const brain = catBrain("mochi",h.cfg), menu = brain.menu(h.ctx);
    expect(menu.SHORT_BTC).toBeUndefined();
    expect(menu.TRIM_HALF).toBeDefined();
    expect(menu.SWITCH).toBeUndefined();
    h.s.trend!.score=0;
    expect(brain.menu(h.ctx).CLOSE).toBeDefined();
    expect(brain.protectiveExit!(h.ctx)).toBe("trend_reversal");
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
