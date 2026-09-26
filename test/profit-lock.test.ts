// 26 Sep 2026: boozy's profit lock (+2.5% keeps half the best move, +5% keeps 65%) and "an add can't make a loser".
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { BOOZY_PROFIT_LOCK } from "../src/bees/boozy.js";
import { profitLockStop } from "../src/bees/common.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

describe("profitLockStop", () => {
  it("nothing below +2.5%", () => {
    expect(profitLockStop("long", 100, 102.4, BOOZY_PROFIT_LOCK)).toBeNull();
    expect(profitLockStop("long", 100, 99, BOOZY_PROFIT_LOCK)).toBeNull();
  });
  it("+2.5% keeps half the best move, +5% keeps 65%", () => {
    expect(profitLockStop("long", 100, 103, BOOZY_PROFIT_LOCK)).toBeCloseTo(101.5, 10);
    expect(profitLockStop("long", 100, 105, BOOZY_PROFIT_LOCK)).toBeCloseTo(103.25, 10);
    expect(profitLockStop("long", 100, 110, BOOZY_PROFIT_LOCK)).toBeCloseTo(106.5, 10);
  });
  it("mirrors for a short", () => {
    expect(profitLockStop("short", 100, 94, BOOZY_PROFIT_LOCK)).toBeCloseTo(96.1, 10);
  });
  it("26 Sep ENA: best 0.2853 on an average entry of 0.27018 locks about 0.2800", () => {
    expect(profitLockStop("long", 0.27018, 0.2853, BOOZY_PROFIT_LOCK)).toBeCloseTo(0.2800, 4);
  });
});

async function harness(px: number, answer = "NOT_ON_MENU") {
  const cfg = testConfig({ DRY_RUN: "true" });
  let v = view([coin("ENA", { ret24hPct: 25, ret7dPct: 43 }, px), coin("SUI", { ret24hPct: 12, ret7dPct: 40 }), coin("BTC", { ret24hPct: 1, ret7dPct: 2 }, 80000)]);
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
  const client: SystemOne = {
    async systemOne() {
      return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: answer, confidence: 0.9, probabilities: { [answer]: 0.9, RIDE: 0.1 } }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
  const db = new Db(":memory:");
  const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
  await engine.start();
  engine.stop();
  const setPx = (p: number) => {
    v = view([coin("ENA", { ret24hPct: 25, ret7dPct: 43 }, p), coin("SUI", { ret24hPct: 12, ret7dPct: 40 }), coin("BTC", { ret24hPct: 1, ret7dPct: 2 }, 80000)]);
  };
  return { engine, setPx, instId: v.stats.get([...v.stats.keys()].find((k) => k.startsWith("ENA"))!)!.instId };
}

describe("engine: boozy's profit lock", () => {
  it("a +6% run locks 65% of it; the lock holds as the price fades, then the stop sells", async () => {
    const h = await harness(106);
    h.engine.bees.bee3.position = { instId: h.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    h.engine.bees.bee3.flatSince = null;
    await h.engine.tick();
    const p = h.engine.bees.bee3.position!;
    expect(p.peakPx).toBe(106);
    expect(p.stopPx!).toBeCloseTo(103.9, 6);
    h.setPx(104.5); // fades, still above the lock
    await h.engine.tick();
    expect(h.engine.bees.bee3.position?.stopPx).toBeCloseTo(103.9, 6);
    h.setPx(103.5); // through the lock: code sells, still in profit
    await h.engine.tick();
    expect(h.engine.bees.bee3.position).toBeNull();
  });

  it("does nothing below +2.5%", async () => {
    const h = await harness(102);
    h.engine.bees.bee3.position = { instId: h.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    h.engine.bees.bee3.flatSince = null;
    await h.engine.tick();
    expect(h.engine.bees.bee3.position!.stopPx!).toBeLessThan(100);
  });
});

describe("engine: an add can't turn a winner into a loser", () => {
  it("after DOUBLE_DOWN the stop is at least the new average entry", async () => {
    const h = await harness(100, "DOUBLE_DOWN");
    h.engine.bees.bee3.position = { instId: h.instId, coin: "ENA", side: "long", contracts: 3, entryPx: 98.9, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    h.engine.bees.bee3.flatSince = null;
    await h.engine.tick();
    const p = h.engine.bees.bee3.position!;
    expect(p.contracts).toBeGreaterThan(3); // the add filled
    expect(p.entryPx).toBeGreaterThan(98.9);
    expect(p.stopPx!).toBeGreaterThanOrEqual(p.entryPx - 1e-9);
  });
});
