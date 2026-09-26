// 26 Sep 2026 repairs: R re-sized on adds, switches only on a confirmed outrank, no Jev call for a rules-only hold.
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { boozy, rankCandidates, switchTarget } from "../src/bees/boozy.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { applyFill, freshBee, sizedRiskUsd } from "../src/ledger.js";
import type { MarketFeed } from "../src/market/data.js";
import { bee, coin, ctx, NOW, position, testConfig, view } from "./fixtures.js";

describe("R grows with the position", () => {
  const f = (side: "buy" | "sell", contracts: number, px: number) => ({ instId: "ENA-USD_UM_XPERP-310613", coin: "ENA", side, contracts, px, feeUsd: 0, ctVal: 100, ts: NOW });

  it("an add re-sizes 1R from the average entry to the initial stop; a trim scales it down", () => {
    const b = freshBee("bee3", 333, NOW);
    applyFill(b, f("buy", 3, 0.27));
    const p = b.position!;
    p.stopPx = 0.256;
    p.initialStopPx = 0.256;
    p.riskUsd = sizedRiskUsd(3, 100, 0.27, 0.256);
    expect(p.riskUsd).toBeCloseTo(4.2, 6);
    applyFill(b, f("buy", 18, 0.2702));
    expect(p.contracts).toBe(21);
    expect(p.riskUsd).toBeCloseTo(21 * 100 * (p.entryPx - 0.256), 6); // ~$29.8, not the first fill's $4.20
    applyFill(b, f("sell", 7, 0.28));
    expect(p.riskUsd).toBeCloseTo((14 / 21) * 21 * 100 * (p.entryPx - 0.256), 6);
  });

  it("a trailed stop does not shrink R: it is measured against the initial stop", () => {
    const b = freshBee("bee3", 333, NOW);
    applyFill(b, f("buy", 10, 1));
    const p = b.position!;
    p.initialStopPx = 0.9;
    p.stopPx = 0.99; // trailed up
    applyFill(b, f("buy", 10, 1.1));
    expect(p.riskUsd).toBeCloseTo(20 * 100 * (1.05 - 0.9), 6);
  });
});

describe("boozy: a switch needs a confirmed outrank", () => {
  // ENA held; SUI has stronger momentum, so it ranks first.
  const ena = coin("ENA", { ret24hPct: 5, ret7dPct: 20 });
  const sui = coin("SUI", { ret24hPct: 12, ret7dPct: 40 });
  const unlocked = (top1: { coin: string | null; streak: number }, stats = [ena, sui]) => {
    const b = bee("boozy", { position: position(ena, { openedAt: NOW - 25 * 60 * 60_000 }), flatSince: null, top1: { ...top1, rankedAt: NOW } });
    return ctx("boozy", b, view(stats));
  };

  it("offered when the other coin leads now and led the last two hourly checks", () => {
    const c = unlocked({ coin: "SUI", streak: 2 });
    expect(rankCandidates(c.view, c.knobs.spreadGateBps)[0]!.s.coin).toBe("SUI");
    expect(boozy.menu(c).SWITCH_COIN?.intent).toMatchObject({ kind: "switch", instId: sui.instId });
  });

  it("not offered on a single check", () => {
    expect(boozy.menu(unlocked({ coin: "SUI", streak: 1 })).SWITCH_COIN).toBeUndefined();
  });

  it("not offered while the held coin is still #1, whatever the hourly history says", () => {
    const strongEna = coin("ENA", { ret24hPct: 25, ret7dPct: 43 });
    expect(boozy.menu(unlocked({ coin: "SUI", streak: 3 }, [strongEna, sui])).SWITCH_COIN).toBeUndefined();
  });

  it("not offered when the held coin is out of the ranking (spread gate), since there is no fair comparison", () => {
    const wide = coin("ENA", { ret24hPct: 5, ret7dPct: 20, spreadBp: 27 });
    const c = unlocked({ coin: "SUI", streak: 2 }, [wide, sui]);
    expect(switchTarget(c, rankCandidates(c.view, c.knobs.spreadGateBps))).toBeNull();
    expect(boozy.menu(c).SWITCH_COIN).toBeUndefined();
    expect(boozy.menu(c).BAIL).toBeDefined(); // bailing stays Jev's call
  });

  it("the streak belongs to one challenger: a different leader starts from zero", () => {
    expect(boozy.menu(unlocked({ coin: "DOGE", streak: 5 })).SWITCH_COIN).toBeUndefined();
  });
});

describe("rules-only hold: Jev is not asked", () => {
  const ena = coin("ENA", { ret24hPct: 25, ret7dPct: 43 });
  const market = () => view([ena, coin("SUI", { ret24hPct: 12, ret7dPct: 40 }), coin("BTC", { ret24hPct: 1, ret7dPct: 2 }, 80000)]);

  async function harness() {
    const cfg = testConfig({ DRY_RUN: "true" });
    const v = market();
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const calls: string[] = [];
    const client: SystemOne = {
      async systemOne(req) {
        calls.push(JSON.stringify(req));
        return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const db = new Db(":memory:");
    const events: Array<{ type: string; bee?: string; required?: boolean; choice?: string | null; jevUsd?: number }> = [];
    const bus = new EventBus(db);
    bus.subscribe((_line, e) => events.push(e as never));
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus, alerts: new Alerts(undefined), now: () => NOW });
    await engine.start();
    engine.stop();
    return { engine, calls, events };
  }

  it("boozy inside his 24h lock (RIDE is the only move): no Jev call, the row says the rules decided", async () => {
    const h = await harness();
    h.engine.bees.bee3.position = { instId: ena.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    h.engine.bees.bee3.flatSince = null;
    h.calls.length = 0;
    await h.engine.tick();
    const asked = h.calls.map((c) => (JSON.parse(c) as { questions: { action: { instructions: string } } }).questions.action.instructions);
    expect(asked.some((i) => i.includes("You are boozy-bee"))).toBe(false);
    const row = h.events.find((e) => e.type === "decision" && e.bee === "bee3");
    expect(row).toMatchObject({ choice: "RIDE", required: true, jevUsd: 0 });
    expect(h.engine.bees.bee3.position?.contracts).toBe(21);
  });

  it("an old position (no initialStopPx) is re-sized once from its entry stop; one already trailed past entry is left alone", async () => {
    const h = await harness();
    const ctVal = market().instruments.get(ena.instId)!.ctVal;
    h.engine.bees.bee3.position = { instId: ena.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 1 };
    h.engine.bees.bee3.flatSince = null;
    h.engine.bees.bee2.position = null;
    await h.engine.tick();
    expect(h.engine.bees.bee3.position).toMatchObject({ initialStopPx: 90 });
    expect(h.engine.bees.bee3.position!.riskUsd).toBeCloseTo(21 * ctVal * 10, 6);

    const g = await harness();
    g.engine.bees.bee3.position = { instId: ena.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 95, openedAt: NOW - 60 * 60_000, stopPx: 96, riskUsd: 7 };
    g.engine.bees.bee3.flatSince = null;
    await g.engine.tick();
    expect(g.engine.bees.bee3.position).toMatchObject({ initialStopPx: null, riskUsd: 7 });
  });

  it("a stop still fires inside the lock", async () => {
    const h = await harness();
    h.engine.bees.bee3.position = { instId: ena.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 110, openedAt: NOW - 60 * 60_000, stopPx: 105, riskUsd: 10, initialStopPx: 105 };
    h.engine.bees.bee3.flatSince = null;
    await h.engine.tick();
    const row = h.events.find((e) => e.type === "decision" && e.bee === "bee3") as { forcedBy?: string; required?: boolean } | undefined;
    expect(row?.forcedBy).toBe("stop");
    expect(row?.required).toBeUndefined();
  });
});
