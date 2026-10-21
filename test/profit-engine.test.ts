import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Alerts } from "../src/alerts.js";
import { CatfolioEngine } from "../src/catfolio-engine.js";
import { BEES, loadConfig, type BeeId, type Config } from "../src/config.js";
import { Db } from "../src/db.js";
import type { DecisionAsk, DecisionProvider, DecisionResult } from "../src/decision.js";
import { EventBus } from "../src/events.js";
import { SimExecutor, type Executor, type OrderResult } from "../src/exec/executor.js";
import { applyFill } from "../src/ledger.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function answer(ask: DecisionAsk, choice = "HOLD", probability = 1): DecisionResult {
  const selected = ask.menu[choice] ? choice : Object.keys(ask.menu)[0]!;
  const labels = Object.keys(ask.menu);
  return {
    ok: true, choice: selected,
    probabilities: Object.fromEntries(labels.map(label => [label,
      label === selected ? probability : (1 - probability) / (labels.length - 1)])),
    confidence: probability, conviction: 0, convictionRaw: 0,
    scoreProbabilities: { "0": 1, "1": 0, "2": 0, "3": 0 }, scoreConfidence: 1,
    inputTokens: 100, latencyMs: 5, model: "mock-profit-review", source: "model",
  };
}

function config(): Config {
  const cfg = loadConfig({ COACH_ENABLED: "false" });
  // Isolate held-position management from new entries and unrelated protective rules.
  for (const id of BEES) {
    cfg.cats[id].minVolumeUsd = 1e10;
    cfg.cats[id].minActionProbability = 0.9;
    cfg.cats[id].minConviction = 3;
    cfg.exits[id].breakevenAtR = 0;
    cfg.exits[id].trailActivationR = 0;
    cfg.exits[id].profitLockAtR = 0;
    cfg.exits[id].partialTakeProfitEnabled = false;
    cfg.exits[id].reviewMinR = 0.5;
    cfg.exits[id].minActionProbability = 0.4;
  }
  return cfg;
}

async function harness(opts: {
  cfg?: Config; db?: Db; at?: number;
  decide?: DecisionProvider["decide"];
  executor?: (sim: SimExecutor) => Executor;
} = {}) {
  let clock = opts.at ?? NOW;
  const cfg = opts.cfg ?? config();
  const db = opts.db ?? new Db(":memory:");
  const s = coin("BTC", { ret1hPct: 1, macdHistPct: 0.2, trend: trend({ score: 9, longOn: 9 }) });
  const v = view([s]);
  const feed = {
    lastRefreshAt: clock, view: () => v,
    refresh: async () => { feed.lastRefreshAt = clock; },
    refreshTickers: async () => { v.tickers.get(s.instId)!.ts = clock; },
  };
  const decide = vi.fn(opts.decide ?? (async ask => answer(ask)));
  const provider: DecisionProvider = {
    decide,
    status: () => ({ provider: "mock", model: "mock-profit-review", requests: 0, failures: 0,
      latencyMs: null, connected: true, error: null }),
  };
  const sim = new SimExecutor(() => v, cfg.risk.takerFeeRate, () => clock, cfg.paperSlippageBps);
  const engine = new CatfolioEngine({ cfg, db, feed: feed as unknown as MarketFeed,
    provider, exec: opts.executor?.(sim) ?? sim, bus: new EventBus(db),
    alerts: { send: () => {} } as unknown as Alerts, now: () => clock });
  await engine.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await engine.stop();
    db.close();
  };
  cleanup.push(close);
  const price = (mid: number) => {
    const bid = mid * 0.99995, ask = mid * 1.00005;
    Object.assign(s, { mid, last: mid, bid, ask, refreshedAt: clock });
    Object.assign(v.tickers.get(s.instId)!, { mid, last: mid, bid, ask, ts: clock });
  };
  const seed = (id: BeeId = "tiger", contracts = 100) => {
    const bee = engine.bees[id];
    applyFill(bee, { instId: s.instId, coin: "BTC", side: "buy", contracts, px: 100,
      feeUsd: contracts * 0.0005, ctVal: 0.01, ts: clock - 10 * 60000 });
    Object.assign(bee.position!, { stopPx: 99, initialStopPx: 99, riskUsd: contracts * 0.01 });
    db.saveBee(bee, clock);
  };
  return { cfg, db, engine, s, v, decide, close, seed, price, now: () => clock,
    advance(ms: number) { clock += ms; feed.lastRefreshAt = v.ts = clock; s.refreshedAt = clock;
      v.tickers.get(s.instId)!.ts = clock; } };
}

describe("profit management through the full engine", () => {
  it.each(["hold", "unreachable"] as const)("executes a cost-covering stop when Jev is %s", async response => {
    const cfg = config();
    cfg.exits.tiger.breakevenAtR = 0.5;
    const h = await harness({ cfg, decide: async ask => response === "hold" ? answer(ask) :
      { ok: false, reason: "timeout", latencyMs: 1 } });
    h.seed(); h.price(101);
    await h.engine.tick();
    const stop = h.engine.bees.tiger.position!.stopPx!;
    expect(stop).toBeGreaterThan(100.1);
    const calls = h.decide.mock.calls.length;
    h.advance(10000); h.price(stop * (1 - 1e-7));
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.engine.bees.tiger.cashUsd).toBeGreaterThan(cfg.cats.tiger.startEquityUsd);
    expect(h.db.raw.prepare("SELECT purpose FROM orders WHERE bee='tiger' AND reduce_only=1").get()).toMatchObject({ purpose: "stop" });
    expect(h.decide).toHaveBeenCalledTimes(calls);
  });

  it("ratchets the net peak-profit floor and closes on giveback without a new entry bar", async () => {
    const cfg = config();
    cfg.exits.tiger.profitLockAtR = 1;
    cfg.exits.tiger.maxGivebackPct = 35;
    const h = await harness({ cfg });
    h.seed(); h.price(102);
    await h.engine.tick();
    const p = h.engine.bees.tiger.position!;
    expect(p.exitPeakNetPerUnit).toBeGreaterThan(1.8);
    expect(p.stopPx).toBeGreaterThan(101.2);
    const firstStop = p.stopPx!;
    h.advance(10000); h.price(101.6);
    await h.engine.tick();
    expect(h.engine.bees.tiger.position!.stopPx).toBe(firstStop);
    h.advance(10000); h.price(firstStop * (1 - 1e-7));
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.engine.bees.tiger.cashUsd - cfg.cats.tiger.startEquityUsd).toBeGreaterThan(1.2);
  });

  it.each([0.44, 0.39])("uses the separate exit probability gate at p=%s with zero entry conviction", async probability => {
    const cfg = config(); cfg.exits.tiger.partialTakeProfitEnabled = true;
    const h = await harness({ cfg, decide: async ask => answer(ask, "CLOSE_PROFIT", probability) });
    h.seed(); h.price(102);
    await h.engine.tick();
    expect(h.decide.mock.calls.some(([ask]) => !!ask.menu.CLOSE_PROFIT)).toBe(true);
    if (probability >= 0.4) {
      expect(h.engine.bees.tiger.position).toBeNull();
      expect(h.db.raw.prepare("SELECT purpose FROM orders WHERE bee='tiger'").get()).toMatchObject({ purpose: "model_profit_take" });
    } else {
      expect(h.engine.bees.tiger.position).not.toBeNull();
      expect(h.db.raw.prepare("SELECT * FROM orders WHERE bee='tiger'").all()).toHaveLength(0);
    }
  });

  it.each(["tiger", "mochi"] as const)("reviews %s profit on its shorter clock while its entry bar stays unchanged", async id => {
    const h = await harness();
    h.seed(id); h.price(101);
    await h.engine.tick();
    const firstKey = h.engine.bees[id].profitDecisionKey;
    const signalKey = h.engine.bees[id].strategyDecisionKey;
    expect(firstKey).toBeTruthy();
    expect(h.db.loadBee(id)?.profitDecisionKey).toBe(firstKey);
    const firstCalls = h.decide.mock.calls.filter(([ask]) => !!ask.menu.CLOSE_PROFIT).length;
    h.advance(10000); await h.engine.tick();
    expect(h.decide.mock.calls.filter(([ask]) => !!ask.menu.CLOSE_PROFIT)).toHaveLength(firstCalls);
    h.advance(h.cfg.exits[id].reviewIntervalSeconds * 1000);
    await h.engine.tick();
    expect(h.engine.bees[id].profitDecisionKey).not.toBe(firstKey);
    expect(h.engine.bees[id].strategyDecisionKey).toBe(signalKey);
    expect(h.decide.mock.calls.filter(([ask]) => !!ask.menu.CLOSE_PROFIT)).toHaveLength(firstCalls + 1);
  });

  it("keeps Good's add choice on new signal bars while extra profit reviews only reduce or hold", async () => {
    const cfg = config();
    cfg.cats.mochi.minVolumeUsd = 1e6;
    cfg.exits.mochi.reviewMinR = 1;
    const h = await harness({ cfg });
    h.seed("mochi", 20); h.price(101.6);
    h.s.confirmed4h = { close: 101.6, ts: NOW - 4 * 3600000 };
    await h.engine.tick();
    const first = h.decide.mock.calls.find(([ask]) => !!ask.menu.CLOSE_PROFIT)?.[0];
    expect(first).toBeDefined();
    expect(first!.menu.ADD_TO_WINNER?.intent.kind).toBe("add");

    h.advance(300000); await h.engine.tick();
    const reviews = h.decide.mock.calls.filter(([ask]) => !!ask.menu.CLOSE_PROFIT);
    expect(reviews).toHaveLength(2);
    expect(reviews[1]![0].menu.ADD_TO_WINNER).toBeUndefined();
    expect(Object.values(reviews[1]![0].menu).every(option =>
      ["hold", "close", "trim"].includes(option.intent.kind))).toBe(true);

    h.advance(4 * 3600000 - 300000);
    h.s.confirmed4h = { close: 101.6, ts: NOW };
    await h.engine.tick();
    const last = h.decide.mock.calls.at(-1)![0];
    expect(last.menu.CLOSE_PROFIT).toBeDefined();
    expect(last.menu.ADD_TO_WINNER?.intent.kind).toBe("add");
    const records = h.db.raw.prepare("SELECT menu_json,audit_json FROM decisions WHERE bee='mochi' ORDER BY id").all() as
      Array<{ menu_json: string; audit_json: string }>;
    expect(records.map(row => JSON.parse(row.audit_json).decisionKind)).toEqual(["signal", "profit_review", "signal"]);
    expect(records.map(row => !!JSON.parse(row.menu_json).ADD_TO_WINNER)).toEqual([true, false, true]);
  });

  it.each(["trade_cap", "fee_budget"] as const)("allows reducing profit reviews after the %s entry cap", async cap => {
    const h = await harness({ decide: async ask => answer(ask, "CLOSE_PROFIT", 0.44) });
    h.seed(); h.price(101); h.engine.bees.tiger.cap = cap;
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT purpose FROM orders WHERE bee='tiger'").get()).toMatchObject({ purpose: "model_profit_take" });
  });

  it("does not sample a new entry on the same signal bar after Jev closes for profit", async () => {
    const cfg = config(); cfg.cats.tiger.minVolumeUsd = 1e6;
    const h = await harness({ cfg, decide: async ask => answer(ask, "CLOSE_PROFIT", 0.44) });
    h.seed(); h.price(101); await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    const calls = h.decide.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await h.engine.tick();
    expect(h.decide).toHaveBeenCalledTimes(calls);
  });

  it("persists a failed profit review before inference and keeps it consumed across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-profit-failure-"));
    cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
    const path = join(dir, "run.sqlite"), db = new Db(path);
    const first = await harness({ db, decide: async () => {
      expect(db.loadBee("tiger")?.profitDecisionKey).toBeTruthy();
      return { ok: false, reason: "timeout", latencyMs: 1 };
    } });
    first.seed(); first.price(101); await first.engine.tick();
    const consumed = first.engine.bees.tiger.profitDecisionKey;
    await first.close();
    const resumed = await harness({ db: new Db(path) });
    resumed.price(101); await resumed.engine.tick();
    expect(resumed.engine.bees.tiger.profitDecisionKey).toBe(consumed);
    expect(resumed.decide).not.toHaveBeenCalled();
    resumed.advance(60000); await resumed.engine.tick();
    expect(resumed.decide).toHaveBeenCalledTimes(1);
    await resumed.close();
  });

  it("persists a partial fill and its review key, then offers no second profit partial after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-profit-restart-"));
    cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
    const path = join(dir, "run.sqlite"), cfg = config();
    cfg.exits.tiger.partialTakeProfitEnabled = true;
    cfg.exits.tiger.partialTakeProfitAtR = 1.5;
    const first = await harness({ cfg, db: new Db(path), decide: async ask => {
      expect(first.db.loadBee("tiger")?.profitDecisionKey).toBeTruthy();
      return answer(ask, "TAKE_PROFIT", 0.44);
    } });
    first.seed("tiger", 101); first.price(102);
    await first.engine.tick();
    expect(first.engine.bees.tiger.position).toMatchObject({ contracts: 51, profitTaken: true });
    expect(first.db.raw.prepare("SELECT contracts,purpose FROM orders WHERE bee='tiger'").get()).toMatchObject({ contracts: 50, purpose: "profit_take" });
    const reviewKey = first.engine.bees.tiger.profitDecisionKey;
    await first.close();
    const resumed = await harness({ cfg, db: new Db(path) });
    resumed.price(102); await resumed.engine.tick();
    expect(resumed.engine.bees.tiger.profitDecisionKey).toBe(reviewKey);
    expect(resumed.decide).not.toHaveBeenCalled();
    resumed.advance(60000); await resumed.engine.tick();
    const review = resumed.decide.mock.calls.find(([ask]) => !!ask.menu.CLOSE_PROFIT)?.[0];
    expect(review).toBeDefined();
    expect(review!.menu.TAKE_PROFIT).toBeUndefined();
    expect(resumed.engine.bees.tiger.position?.contracts).toBe(51);
    await resumed.close();
  });

  it.each(["rejected", "zero"] as const)("does not consume partial profit-taking after a %s fill", async mode => {
    const cfg = config(); cfg.exits.tiger.partialTakeProfitEnabled = true;
    const h = await harness({ cfg, decide: async ask => answer(ask, "TAKE_PROFIT", 0.44),
      executor: sim => ({ kind: "sim", init: sim.init.bind(sim), positions: sim.positions.bind(sim),
        fundingBills: sim.fundingBills.bind(sim), feesFor: sim.feesFor.bind(sim),
        market: async (): Promise<OrderResult> => mode === "rejected"
          ? { ok: false, state: "rejected", error: { code: "TEST", message: "rejected" } }
          : { ok: true, ordId: null, contracts: 0, avgPx: 102, feeUsd: 0, ts: NOW } }) });
    h.seed(); h.price(102); await h.engine.tick();
    expect(h.engine.bees.tiger.position?.profitTaken).not.toBe(true);
    expect(h.engine.bees.tiger.position?.contracts).toBe(100);
    h.advance(60000); await h.engine.tick();
    expect(h.decide.mock.calls.filter(([ask]) => !!ask.menu.TAKE_PROFIT)).toHaveLength(2);
  });

  it.each(["unknown", "rejected"] as const)("reconciles a smaller exchange position after a %s profit partial", async resultState => {
    const cfg = config(); cfg.exits.tiger.partialTakeProfitEnabled = true;
    let exchangeContracts = 0, sawUnreconciledPosition = false;
    const instId = "BTC-USD_UM_XPERP-310404";
    const h = await harness({ cfg, decide: async ask => answer(ask, "TAKE_PROFIT", 0.44),
      executor: sim => ({ kind: "okx", init: sim.init.bind(sim),
        positions: async id => {
          if (id === "tiger" && exchangeContracts === 50 && resultState === "unknown" && !sawUnreconciledPosition) {
            expect(h.engine.bees.tiger.position?.contracts).toBe(100);
            expect(h.engine.bees.tiger.position?.profitTaken).not.toBe(true);
            sawUnreconciledPosition = true;
          }
          return id === "tiger" && exchangeContracts > 0 ? [{ instId, pos: exchangeContracts, avgPx: 100 }] : [];
        },
        fundingBills: async () => [], feesFor: async () => null,
        market: async (_id, req): Promise<OrderResult> => {
          if (resultState === "unknown") exchangeContracts -= req.contracts;
          return { ok: false, state: resultState, error: { code: "TEST", message: "reply unavailable" } };
        } }) });
    h.seed(); exchangeContracts = 100; h.price(102); await h.engine.tick();
    // Unknown results request immediate reconciliation at the end of this tick.
    expect(sawUnreconciledPosition).toBe(resultState === "unknown");
    expect(h.engine.bees.tiger.position?.contracts).toBe(resultState === "unknown" ? 50 : 100);
    expect(h.engine.bees.tiger.position?.profitTaken === true).toBe(resultState === "unknown");
    expect(h.db.raw.prepare("SELECT state,purpose FROM orders WHERE bee='tiger'").get()).toMatchObject({ state: resultState, purpose: "profit_take" });
    // A rejected order did not fill; this shrink represents an unrelated exchange-side reduction.
    exchangeContracts = 50;
    await h.engine.reconcile();
    expect(h.engine.bees.tiger.position?.contracts).toBe(50);
    expect(h.engine.bees.tiger.position?.profitTaken === true).toBe(resultState === "unknown");
    expect(h.engine.bees.tiger.position?.entryFeesUsd).toBeCloseTo(0.025);
    h.advance(60000); await h.engine.tick();
    const nextMenu = h.decide.mock.calls.at(-1)![0].menu;
    expect(!!nextMenu.TAKE_PROFIT).toBe(resultState !== "unknown");
  });

  it("allocates a delayed funding bill to the remaining fraction after a recorded partial", async () => {
    const cfg = config(); cfg.exits.tiger.partialTakeProfitEnabled = true;
    let exchangeContracts = 0, billAvailable = false;
    const instId = "BTC-USD_UM_XPERP-310404";
    const h = await harness({ cfg, decide: async ask => answer(ask, "TAKE_PROFIT", 0.44),
      executor: sim => ({ kind: "okx", init: sim.init.bind(sim),
        positions: async id => id === "tiger" && exchangeContracts > 0
          ? [{ instId, pos: exchangeContracts, avgPx: 100 }] : [],
        fundingBills: async id => id === "tiger" && billAvailable
          ? [{ billId: "delayed-settlement", instId, amountUsd: -1, ts: NOW - 5000 }] : [],
        feesFor: async () => null,
        market: async (id, req) => {
          const result = await sim.market(id, req);
          if (result.ok) exchangeContracts -= result.contracts;
          return result;
        } }) });
    h.db.setMeta("funding_since", String(NOW - 10 * 60000));
    h.seed(); exchangeContracts = 100; h.price(102); await h.engine.tick();
    expect(h.engine.bees.tiger.position?.contracts).toBe(50);
    const cashBefore = h.engine.bees.tiger.cashUsd;
    billAvailable = true;
    const funding = h.engine.core as unknown as { pollFunding(): Promise<void> };
    await funding.pollFunding();
    expect(h.engine.bees.tiger.cashUsd).toBeCloseTo(cashBefore - 1);
    expect(h.engine.bees.tiger.totals.fundingUsd).toBe(-1);
    expect(h.engine.bees.tiger.position?.fundingAccruedUsd).toBeCloseTo(-0.5);
    await funding.pollFunding();
    expect(h.engine.bees.tiger.cashUsd).toBeCloseTo(cashBefore - 1);
    expect(h.engine.bees.tiger.position?.fundingAccruedUsd).toBeCloseTo(-0.5);
  });

  it.each([100.05, 98.5])("rechecks the market after inference when the quote drops to %s", async finalPrice => {
    const h = await harness({ decide: async ask => {
      if (ask.menu.CLOSE_PROFIT) h.price(finalPrice);
      return answer(ask, "CLOSE_PROFIT", 0.44);
    } });
    h.seed(); h.price(101); await h.engine.tick();
    const requestMenu = h.decide.mock.calls.find(([ask]) => !!ask.menu.CLOSE_PROFIT)![0].menu;
    const recorded = h.db.raw.prepare("SELECT menu_json,audit_json FROM decisions WHERE bee='tiger' ORDER BY id DESC LIMIT 1").get() as
      { menu_json: string; audit_json: string };
    expect(JSON.parse(recorded.menu_json)).toEqual(requestMenu);
    expect(JSON.parse(recorded.audit_json).menu).toEqual(requestMenu);
    expect(JSON.parse(recorded.menu_json).CLOSE_PROFIT).toBeDefined();
    if (finalPrice < 99) {
      expect(h.engine.bees.tiger.position).toBeNull();
      expect(h.db.raw.prepare("SELECT purpose FROM orders WHERE bee='tiger'").get()).toMatchObject({ purpose: "stop" });
    } else {
      expect(h.engine.bees.tiger.position).not.toBeNull();
      expect(h.db.raw.prepare("SELECT * FROM orders WHERE bee='tiger'").all()).toHaveLength(0);
    }
  });
});
