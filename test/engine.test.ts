import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BEES, loadConfig, type Config } from "../src/config.js";
import type {
  DecisionAsk,
  DecisionProvider,
  DecisionResult,
} from "../src/decision.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import type { Alerts } from "../src/alerts.js";
import type { MarketFeed } from "../src/market/data.js";
import { SimExecutor, type Executor } from "../src/exec/executor.js";
import { freshBee } from "../src/ledger.js";
import { morningReport } from "../src/report.js";
import { lockRun } from "../src/run-lock.js";
import { coin, NOW, position, trend, view } from "./fixtures.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.useRealTimers();
});
function answer(ask: DecisionAsk, choice = "WAIT"): DecisionResult {
  return {
    ok: true,
    choice,
    probabilities: Object.fromEntries(
      Object.keys(ask.menu).map((k) => [k, k === choice ? 1 : 0]),
    ),
    confidence: 1,
    conviction: 3,
    convictionRaw: 3,
    scoreProbabilities: { "0": 0, "1": 0, "2": 0, "3": 1 },
    scoreConfidence: 1,
    inputTokens: 100,
    latencyMs: 30,
    model: "mock-nimble",
    source: "model",
  };
}
async function harness(
  decide: DecisionProvider["decide"] = async (ask) => answer(ask),
  opts: {
    cfg?: Config;
    db?: Db;
    executor?: (sim: SimExecutor) => Executor;
    clock?: () => number;
    closeRequested?: () => boolean;
    coachFetch?: typeof fetch;
  } = {},
) {
  let clock = NOW;
  const now = opts.clock ?? (() => clock);
  const cfg = opts.cfg ?? loadConfig({}),
    db = opts.db ?? new Db(":memory:");
  const s = coin("BTC", {
      breakout: { dayOpen: 99, prevRange: 2, trigger: 100, dayStart: Math.floor(NOW / 86400000) * 86400000 },
      confirmed15m: { close: 100, ts: NOW - 900000 },
      ret1hPct: 1,
      macdHistPct: 0.2,
      trend: trend({ score: 9, longOn: 9 }),
    }),
    v = view([s]);
  const feed = {
    lastRefreshAt: now(),
    view: () => v,
    refresh: async () => {
      feed.lastRefreshAt = now();
    },
    refreshTickers: async () => {
      v.tickers.get(s.instId)!.ts = now();
    },
  } as unknown as MarketFeed;
  const provider: DecisionProvider = {
    decide,
    status: () => ({
      provider: "mock local",
      model: "mock-nimble",
      requests: 0,
      failures: 0,
      latencyMs: null,
      connected: true,
      error: null,
    }),
  };
  const sim = new SimExecutor(
    () => v,
    cfg.risk.takerFeeRate,
    now,
    cfg.paperSlippageBps,
  );
  const engine = new Engine({
    cfg,
    db,
    feed,
    provider,
    exec: opts.executor?.(sim) ?? sim,
    bus: new EventBus(db),
    alerts: { send: () => {} } as unknown as Alerts,
    now,
    closeRequested: opts.closeRequested,
    coachFetch: opts.coachFetch,
  });
  await engine.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await engine.stop();
    db.close();
  };
  cleanup.push(close);
  return {
    cfg,
    db,
    engine,
    s,
    v,
    feed,
    close,
    advance: (ms: number) => {
      clock += ms;
      v.tickers.get(s.instId)!.ts = clock;
    },
  };
}
describe("Catfolio engine, protection and recovery", () => {
  it("funds exactly two isolated accounts, and WAIT never trades", async () => {
    const h = await harness();
    await h.engine.tick();
    expect(Object.keys(h.engine.bees)).toEqual(BEES);
    expect(h.engine.bees.tiger.cashUsd + h.engine.bees.mochi.cashUsd).toBe(200);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
    const streamed = h.db.recentEvents(10, "decision").map(line => JSON.parse(line));
    expect(streamed).toHaveLength(2);
    expect(streamed[0]).toMatchObject({
      decisionId: expect.any(Number), choice: "WAIT", probabilities: { WAIT: 1 },
      confidence: 1, source: "model", latencyMs: 30, pnlUsd: 0,
      action: { kind: "none" }, entryDiagnostics: expect.any(Array),
    });
    h.engine.bees.tiger.cashUsd = 5;
    await h.engine.protectiveTick();
    expect(h.engine.bees.mochi.cashUsd).toBe(100);
    expect(h.engine.bees.tiger.cashUsd).toBe(5);
  });
  it("records replayable decisions, fills, fees, slippage and per-cat report", async () => {
    const h = await harness(async (ask) => answer(ask, "LONG_BTC"));
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).not.toBeNull();
    expect(h.engine.bees.mochi.position).not.toBeNull();
    expect(h.engine.bees.mochi.position!.contracts).toBeLessThan(
      h.engine.bees.tiger.position!.contracts,
    );
    const row = h.db.raw
      .prepare("SELECT audit_json AS audit FROM decisions WHERE bee=?")
      .get("tiger") as { audit: string };
    const audit = JSON.parse(row.audit);
    expect(audit).toMatchObject({
      strategyVersion: "catfolio-3-intraday",
      rubricVersion: "signal-strength-1",
      config: { model: "", slippageBps: 2 },
      response: { model: "mock-nimble" },
    });
    expect(audit.market.tickers).toHaveLength(1);
    expect(audit.config).not.toHaveProperty("token");
    expect(h.db.raw.prepare("SELECT * FROM fills").all()).toHaveLength(2);
    const report = morningReport(h.db);
    expect(report.cats).toHaveLength(2);
    expect(report.cats[0]!.entries).toBe(1);
    expect(report.cats[0]!.feesUsd).toBeGreaterThan(0);
    expect(report.cats[0]!.simulatedSlippageUsd).toBeGreaterThan(0);
    expect(report.cats[0]!.inferenceLatencyMs.p95).toBe(30);
  });
  it("records provider identity and API estimates separately from each cat's trading capital", async () => {
    const cfg = loadConfig({
      DECISION_PROVIDER: "jev",
      TYPESAFE_API_KEY: "never-record-this-key",
    });
    const h = await harness(
      async (ask) => ({ ...answer(ask), costUsd: 0.001 }),
      { cfg },
    );
    await h.engine.tick();
    expect(h.engine.bees.tiger.cashUsd).toBe(100);
    expect(h.engine.bees.mochi.cashUsd).toBe(100);
    const report = morningReport(h.db);
    expect(report.backends).toEqual([
      { provider: "jev", requestedModel: "jev-1.13.0" },
    ]);
    for (const c of report.cats) {
      expect(c.estimatedInferenceCostUsd).toBe(0.001);
      expect(c.netPnlUsd).toBe(0);
      expect(c.netPnlAfterEstimatedInferenceUsd).toBe(-0.001);
    }
    const audit = JSON.stringify(
      h.db.raw.prepare("SELECT audit_json FROM decisions").all(),
    );
    expect(audit).not.toContain("never-record-this-key");
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it("continues protective exits during slow inference and discards the changed-position response", async () => {
    const pending: Array<() => void> = [];
    const h = await harness(
      (ask) =>
        new Promise((resolve) =>
          pending.push(() => resolve(answer(ask, "HOLD"))),
        ),
    );
    h.engine.bees.tiger.position = position(h.s, { stopPx: 99, contracts: 10 });
    h.engine.bees.mochi.position = position(h.s, { stopPx: 99, contracts: 10 });
    const request = h.engine.tick();
    expect(pending).toHaveLength(2);
    h.s.mid = 98;
    h.v.tickers.get(h.s.instId)!.mid = 98;
    h.v.tickers.get(h.s.instId)!.bid = 97.99;
    h.v.tickers.get(h.s.instId)!.ask = 98.01;
    h.advance(5000);
    await h.engine.protectiveTick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.engine.bees.mochi.position).toBeNull();
    pending.forEach((resolve) => resolve());
    await request;
    expect(
      h.db.raw
        .prepare(
          "SELECT * FROM decisions WHERE vetoed_by='stale_model_response'",
        )
        .all(),
    ).toHaveLength(2);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(2);
  });
  it("does not overlap decisions per cat, and expires returned entries", async () => {
    const pending: Array<() => void> = [];
    const h = await harness(
      (ask) =>
        new Promise((resolve) =>
          pending.push(() => resolve(answer(ask, "LONG_BTC"))),
        ),
    );
    const first = h.engine.tick();
    await h.engine.tick();
    expect(pending).toHaveLength(2);
    h.advance(h.cfg.maxDecisionAgeMs + 1);
    pending.forEach((r) => r());
    await first;
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
    expect(
      h.db.raw
        .prepare(
          "SELECT * FROM decisions WHERE vetoed_by='stale_model_response'",
        )
        .all(),
    ).toHaveLength(2);
  });
  it("uses the independent five-second timer while the sixty-second model task waits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const pending: Array<() => void> = [];
    const h = await harness(
      (ask) =>
        new Promise((resolve) =>
          pending.push(() => resolve(answer(ask, "HOLD"))),
        ),
      { clock: Date.now },
    );
    h.engine.bees.tiger.position = position(h.s, { stopPx: 90, contracts: 10 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(pending.length).toBe(2);
    h.v.tickers.get(h.s.instId)!.mid = 89;
    h.v.tickers.get(h.s.instId)!.bid = 88.99;
    h.v.tickers.get(h.s.instId)!.ask = 89.01;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.engine.bees.tiger.position).toBeNull();
    pending.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    await h.close();
  });
  it("rechecks liquidity, spread, setup and fresh market data after inference", async () => {
    const pending: Array<() => void> = [];
    const h = await harness(
      (ask) =>
        new Promise((resolve) =>
          pending.push(() => resolve(answer(ask, "LONG_BTC"))),
        ),
    );
    const task = h.engine.tick();
    h.v.tickers.get(h.s.instId)!.spreadBp = 100;
    pending.forEach((r) => r());
    await task;
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
    expect(
      h.db.raw
        .prepare("SELECT * FROM decisions WHERE vetoed_by='spread_gate'")
        .all(),
    ).toHaveLength(2);
  });
  it("persists model failures and can exit despite entry caps", async () => {
    const h = await harness(async () => ({
      ok: false,
      reason: "timeout",
      latencyMs: 45000,
    }));
    await h.engine.tick();
    expect(
      h.db.raw
        .prepare("SELECT * FROM decisions WHERE jev_error IS NOT NULL")
        .all(),
    ).toHaveLength(2);
    h.engine.bees.tiger.tradesToday = 6;
    expect(h.db.recentEvents(2, "decision").map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ error: "timeout", probabilities: null, confidence: null, source: "model", latencyMs: 45000 }),
      expect.objectContaining({ error: "timeout", probabilities: null, confidence: null, source: "model", latencyMs: 45000 }),
    ]);
    h.engine.bees.tiger.position = position(h.s, { stopPx: 101 });
    await h.engine.protectiveTick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(morningReport(h.db).cats[0]!.modelFailures).toBe(1);
  });
  it("rejects repeated orders after rejection cooldown but allows protective exits", async () => {
    let sends = 0;
    const h = await harness(async (ask) => answer(ask, "LONG_BTC"), {
      executor: (sim) => ({
        kind: "sim",
        init: async () => {},
        market: async (id, req) => {
          if (req.reduceOnly) return sim.market(id, req);
          sends++;
          return {
            ok: false,
            state: "rejected",
            error: { code: "TEST", message: "rejected" },
          };
        },
        positions: async () => null,
        fundingBills: async () => null,
        feesFor: async () => null,
      }),
    });
    await h.engine.tick();
    await h.engine.tick();
    expect(sends).toBe(2);
    h.engine.bees.tiger.position = position(h.s, { stopPx: 101 });
    await h.engine.protectiveTick();
    expect(h.engine.bees.tiger.position).toBeNull();
  });
  it("restarts from committed books without top-ups or duplicate entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catfolio-"));
    const path = join(dir, "run.sqlite");
    const first = await harness(async (ask) => answer(ask, "LONG_BTC"), {
      db: new Db(path),
    });
    await first.engine.tick();
    const saved = structuredClone(first.engine.bees.tiger);
    await first.close();
    const second = await harness(
      async (ask) =>
        answer(ask, Object.hasOwn(ask.menu, "HOLD") ? "HOLD" : "WAIT"),
      { db: new Db(path) },
    );
    await second.engine.tick();
    expect(second.engine.bees.tiger.position!.contracts).toBe(
      saved.position!.contracts,
    );
    expect(second.engine.bees.tiger.cashUsd).toBe(saved.cashUsd);
    expect(second.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(2);
    await second.close();
    const bad = new Db(path),
      cfg = loadConfig({ TOTAL_START_EQUITY_USD: "300" });
    await expect(harness(undefined, { db: bad, cfg })).rejects.toThrow(
      /Persisted capital/,
    );
    bad.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("persists Breezy entry score and one-time trim across restart, then protects without inference", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-trim-")), path = join(dir, "run.sqlite");
    const choose: DecisionProvider["decide"] = async ask => answer(ask,
      ask.menu.TRIM_HALF ? "TRIM_HALF" : ask.menu.HOLD ? "HOLD" : ask.menu.LONG_BTC ? "LONG_BTC" : "WAIT");
    const first = await harness(choose, { db: new Db(path) });
    await first.engine.tick();
    const original = first.engine.bees.mochi.position!.contracts;
    expect(first.engine.bees.mochi.position!.entryScore).toBe(9);
    first.s.intraday!.mochi.trend.score = 6;
    await first.engine.tick();
    expect(first.engine.bees.mochi.position).toMatchObject({ entryScore: 9, trendTrimmed: true });
    const remaining = first.engine.bees.mochi.position!.contracts;
    expect(remaining).toBeLessThan(original);
    await first.close();
    const second = await harness(choose, { db: new Db(path) });
    second.s.intraday!.mochi.trend.score = 6;
    await second.engine.tick();
    expect(second.engine.bees.mochi.position!.contracts).toBe(remaining);
    expect(second.db.raw.prepare("SELECT * FROM orders WHERE purpose='trim'").all()).toHaveLength(1);
    second.s.intraday!.mochi.trend.score = 0;
    await second.engine.protectiveTick();
    expect(second.engine.bees.mochi.position).toBeNull();
    expect(second.db.raw.prepare("SELECT * FROM orders WHERE purpose='trend_lost'").all()).toHaveLength(1);
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("durably closes both positions and never reopens a closed run after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-close-")),
      path = join(dir, "run.sqlite");
    let closing = false;
    const first = await harness(async (ask) => answer(ask, "LONG_BTC"), {
      db: new Db(path),
      closeRequested: () => closing,
    });
    await first.engine.tick();
    closing = true;
    first.advance(5000);
    await first.engine.protectiveTick();
    for (const id of BEES) {
      expect(first.engine.bees[id].position).toBeNull();
      expect(first.db.loadBee(id)!.position).toBeNull();
    }
    expect(first.engine.snapshot().closed?.flat).toBe(true);
    expect(first.db.raw.prepare("SELECT * FROM fills").all()).toHaveLength(4);
    expect(first.engine.bees.tiger.exposedMs).toBe(5000);
    await first.close();
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask, "LONG_BTC"));
    const resumed = await harness(decide, { db: new Db(path) });
    await resumed.engine.tick();
    expect(decide).not.toHaveBeenCalled();
    expect(resumed.engine.snapshot().closed?.flat).toBe(true);
    expect(resumed.db.raw.prepare("SELECT * FROM fills").all()).toHaveLength(4);
    await resumed.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("rejects interrupted uncommitted paper orders on restart without inventing fills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-pending-")),
      path = join(dir, "run.sqlite");
    const first = await harness(undefined, { db: new Db(path) });
    first.db.insertOrder({
      decisionId: 1,
      bee: "tiger",
      ts: NOW,
      clOrdId: "pending",
      instId: first.s.instId,
      side: "buy",
      contracts: 1,
      reduceOnly: false,
      purpose: "open",
    });
    await first.close();
    const resumed = await harness(undefined, { db: new Db(path) });
    expect(
      resumed.db.raw.prepare("SELECT state FROM orders").get(),
    ).toMatchObject({ state: "rejected" });
    expect(resumed.db.raw.prepare("SELECT * FROM fills").all()).toHaveLength(0);
    expect(resumed.engine.bees.tiger.cashUsd).toBe(100);
    await resumed.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("records independent funding once per slot and retains it on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-funding-")),
      path = join(dir, "run.sqlite");
    const first = await harness(async (ask) => answer(ask, "LONG_BTC"), {
      db: new Db(path),
    });
    await first.engine.tick();
    first.s.fundingPct = 0.01;
    const slotMs = 8 * 3600000;
    first.advance((Math.floor(NOW / slotMs) + 1) * slotMs - NOW);
    await first.engine.protectiveTick();
    await first.engine.protectiveTick();
    expect(first.db.raw.prepare("SELECT * FROM funding").all()).toHaveLength(2);
    const paid = first.engine.bees.tiger.totals.fundingUsd;
    expect(paid).toBeLessThan(0);
    expect(Math.abs(first.engine.bees.mochi.totals.fundingUsd)).toBeLessThan(
      Math.abs(paid),
    );
    await first.close();
    const resumed = await harness(undefined, { db: new Db(path) });
    expect(resumed.engine.bees.tiger.totals.fundingUsd).toBe(paid);
    expect(resumed.db.raw.prepare("SELECT * FROM funding").all()).toHaveLength(
      2,
    );
    await resumed.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("prevents duplicate execution IDs and rolls back a failed ledger transaction", () => {
    const db = new Db(":memory:");
    const o = {
      decisionId: 1,
      bee: "tiger" as const,
      ts: NOW,
      clOrdId: "one",
      instId: "BTC",
      side: "buy" as const,
      contracts: 1,
      reduceOnly: false,
      purpose: "open",
    };
    db.insertOrder(o);
    expect(() => db.insertOrder({ ...o, clOrdId: "two" })).toThrow();
    expect(() =>
      db.transaction(() => {
        db.saveBee(freshBee("tiger", 100, NOW), NOW);
        throw new Error("rollback");
      }),
    ).toThrow();
    expect(db.loadBee("tiger")).toBeNull();
    db.close();
  });
  it("refuses an old three-bot database and leaves historical rows intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "old-bees-")),
      path = join(dir, "old.sqlite"),
      db = new Db(path);
    db.raw
      .prepare("INSERT INTO bee_state VALUES (?,?,?)")
      .run("bee3", "{}", NOW);
    db.close();
    expect(() => new Db(path)).toThrow(/Incompatible historical/);
    rmSync(dir, { recursive: true, force: true });
  });
  it("recovers a lock whose PID was reused after a container restart", () => {
    if (!["darwin", "linux"].includes(process.platform)) return;
    const dir = mkdtempSync(join(tmpdir(), "cat-lock-reuse-")),
      path = join(dir, "run.sqlite");
    const unlock = lockRun(path);
    const saved = JSON.parse(readFileSync(`${path}.lock`, "utf8"));
    unlock();
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({ ...saved, identity: "old-process-start" }),
    );
    expect(() => lockRun(path)()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
  it("allows only one running engine per local database", () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-lock-")),
      path = join(dir, "run.sqlite");
    const unlock = lockRun(path);
    expect(() => lockRun(path)).toThrow(/already running/);
    unlock();
    lockRun(path)();
    rmSync(dir, { recursive: true, force: true });
  });
});


describe("coach approval in the running engine", () => {
  const coachFetch = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    diagnosis: "Trend threshold blocked the recorded entries", rationale: "Try a one-point adjustment", tradeoff: "More false signals are possible",
    change: { field: "minTrendScore", from: 3, to: 2 },
  }) } }] }))) as typeof fetch;
  function seedHistory(db: Db) {
    for (let i = 0; i < 31; i++) db.raw.prepare(`INSERT INTO decisions(bee,ts,choice,menu_json,action_json,status,audit_json)
      SELECT bee,?,choice,menu_json,action_json,status,audit_json FROM decisions WHERE bee='tiger' ORDER BY id LIMIT 1`).run(NOW - 3600000 - i * 60000);
  }
  it("hot-applies only an approved threshold and keeps normal position sizing and exits", async () => {
    const h = await harness(async (ask) => answer(ask, ask.menu.LONG_BTC ? "LONG_BTC" : "WAIT"), {
      cfg: loadConfig({ AI_GATEWAY_API_KEY: "test-only" }), coachFetch,
    });
    h.s.intraday!.tiger.trend.score = 2;
    h.s.intraday!.mochi.trend.score = 2;
    await h.engine.tick(); seedHistory(h.db);
    expect(h.engine.bees.tiger.position).toBeNull();
    await h.engine.coach.tick();
    const pending = h.engine.coach.state().entries.find((e) => e.cat === "tiger")!;
    expect(pending.status).toBe("pending");
    await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    h.engine.coach.resolve(pending.id, "accept");
    expect(h.engine.bees.tiger.position).toBeNull();
    await h.engine.tick(); expect(h.engine.bees.tiger.position).not.toBeNull();
    expect(h.engine.bees.tiger.position!.stopPx).toBeCloseTo(h.engine.bees.tiger.position!.entryPx * 0.99);
    expect(h.engine.bees.mochi.position).toBeNull();
    h.engine.coach.reset("tiger");
    expect(h.cfg.cats.tiger.minTrendScore).toBe(3);
    expect(h.engine.bees.tiger.position!.stopPx).toBeCloseTo(h.engine.bees.tiger.position!.entryPx * 0.99);
  });
  it("discards in-flight decisions when an approved threshold changes", async () => {
    let slow = false;
    const releases: Array<() => void> = [];
    const h = await harness(async (ask) => slow ? new Promise((resolve) => releases.push(() => resolve(answer(ask)))) : answer(ask), {
      cfg: loadConfig({ AI_GATEWAY_API_KEY: "test-only" }), coachFetch,
    });
    h.s.intraday!.tiger.trend.score = 2;
    h.s.intraday!.mochi.trend.score = 2;
    await h.engine.tick(); seedHistory(h.db); await h.engine.coach.tick();
    slow = true;
    const pending = h.engine.tick();
    expect(releases).toHaveLength(2);
    h.engine.coach.resolve(h.engine.coach.state().entries[0]!.id, "accept");
    releases.forEach((release) => release()); await pending;
    expect(h.db.raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE bee='tiger' AND vetoed_by='stale_model_response'").get()).toMatchObject({ n: 1 });
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
});
