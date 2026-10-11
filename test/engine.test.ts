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
import { CatfolioEngine as Engine } from "../src/catfolio-engine.js";
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
  if (choice === "HOLD" && ask.menu.HOLD_WINNER) choice = "HOLD_WINNER";
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
  it("uses each cat's allocation for source loss limits and reported returns", async () => {
    const cfg = loadConfig({ TIGER_ALLOCATION_PCT: "75", MOCHI_ALLOCATION_PCT: "25" });
    const h = await harness(undefined, { cfg });
    expect(h.engine.snapshot().cats.map(c => [c.allocatedUsd, c.pnlUsd])).toEqual([[150, 0], [50, 0]]);
    h.engine.bees.tiger.cashUsd = 135;
    await h.engine.tick();
    expect(h.engine.bees.tiger.cap).toBe("loss_stop");
    expect(h.engine.bees.mochi.cap).toBeNull();
    expect(h.engine.snapshot().cats[0]!.pnlUsd).toBe(-15);
  });
  it("shows upstream benched pulses without calling the provider or replaying an old decision", async () => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask));
    const h = await harness(decide);
    for (const id of BEES) {
      h.engine.bees[id].cap = "trade_cap";
      h.engine.bees[id].tradesToday = h.cfg.cats[id].maxTradesPerDay;
    }
    await h.engine.tick();
    expect(decide).not.toHaveBeenCalled();
    const events = h.db.recentEvents(10, "decision").map(line => JSON.parse(line));
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ choice: "BENCHED", pulse: true, source: "rules", decisionId: null, action: { kind: "none" }, latencyMs: null });
    for (const cat of h.engine.snapshot().cats) expect(cat.last?.status).toBeTruthy();
  });
  it("schedules the first source tick at ten seconds", async () => {
    vi.useFakeTimers();
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask));
    const h = await harness(decide);
    await vi.advanceTimersByTimeAsync(9999);
    expect(decide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(decide).toHaveBeenCalled();
    await h.close();
  });
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
    await h.engine.tick();
    expect(h.engine.bees.mochi.cashUsd).toBe(100);
    expect(h.engine.bees.tiger.cashUsd).toBe(5);
  });
  it("records unconfirmed momentum as rules observations without asking the model", async () => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask));
    const h = await harness(decide);
    h.s.ret1hPct = 0;
    await h.engine.tick();
    expect(decide.mock.calls.every(([ask]) => !ask.strategy.includes("active intraday"))).toBe(true);
    const row = h.db.raw.prepare("SELECT choice, audit_json FROM decisions WHERE bee='tiger'").get() as { choice: string | null; audit_json: string };
    expect(row.choice).toBeNull();
    expect(JSON.parse(row.audit_json)).toMatchObject({source:"rules",entryDiagnostics:[expect.objectContaining({coin:"BTC",blockers:["momentum_not_confirmed"]}), ...h.cfg.slots.tiger.coins.slice(1).map(coin => expect.objectContaining({coin}))]});
    expect(h.engine.coach.state().cats[0]?.observations).toBe(1);
    expect(h.engine.bees.tiger.position).toBeNull();
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
      strategyVersion: "catfolio-6-active-momentum",
      rubricVersion: "upstream-style-conviction-1",
      config: { model: "", slippageBps: 2 },
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
      const recordedCost = c.cat === "tiger" ? 0.001 : 0; // Invalid choices have no successful source result.
      expect(c.estimatedInferenceCostUsd).toBe(recordedCost);
      expect(c.netPnlUsd).toBe(0);
      expect(c.netPnlAfterEstimatedInferenceUsd).toBe(0 - recordedCost);
    }
    const audit = JSON.stringify(
      h.db.raw.prepare("SELECT audit_json FROM decisions").all(),
    );
    expect(audit).not.toContain("never-record-this-key");
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it("uses the upstream serialized tick while inference is pending", async () => {
    const releases: Array<()=>void> = [];
    const h=await harness(ask=>new Promise(resolve=>releases.push(()=>resolve(answer(ask,"HOLD")))));
    h.engine.bees.mochi.position=position(h.s,{stopPx:90,contracts:10});
    const task=h.engine.tick(); await Promise.resolve(); await Promise.resolve();
    const count=releases.length;
    await h.engine.tick(); expect(releases.length).toBe(count);
    // There is no second protection loop that can mutate a position during this source tick.
    expect(h.engine.bees.mochi.position!.contracts).toBe(10);
    releases.forEach(release=>release()); await task;
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
    h.engine.bees.tiger.tradesToday = h.cfg.cats.tiger.maxTradesPerDay;
    h.engine.bees.tiger.cap = "trade_cap";
    expect(h.db.recentEvents(2, "decision").map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ error: "timeout", probabilities: null, confidence: null, source: "model", latencyMs: 45000 }),
      expect.objectContaining({ error: "timeout", probabilities: null, confidence: null, source: "model", latencyMs: 45000 }),
    ]);
    h.engine.bees.tiger.position = position(h.s, { stopPx: 101 });
    await h.engine.tick();
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
    await h.engine.tick();
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
  it("persists source Breezy entry score and allows subsequent trims after restart; stops still protect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-trim-")), path = join(dir, "run.sqlite");
    const choose: DecisionProvider["decide"] = async ask => answer(ask,
      ask.menu.TRIM_HALF ? "TRIM_HALF" : ask.menu.HOLD ? "HOLD" : ask.menu.LONG_BTC ? "LONG_BTC" : "WAIT");
    const first = await harness(choose, { db: new Db(path) });
    await first.engine.tick();
    const original = first.engine.bees.mochi.position!.contracts;
    expect(first.engine.bees.mochi.position!.entryScore).toBe(9);
    first.s.trend!.score = 6;
    await first.engine.tick();
    expect(first.engine.bees.mochi.position).toMatchObject({ entryScore: 9 });
    const remaining = first.engine.bees.mochi.position!.contracts;
    expect(remaining).toBeLessThan(original);
    await first.close();
    const second = await harness(choose, { db: new Db(path) });
    second.advance(10_000); // A restart happens later than the preceding source order timestamp.
    second.s.trend!.score = 6;
    await second.engine.tick();
    expect(second.engine.bees.mochi.position!.contracts).toBeLessThan(remaining);
    expect(second.db.raw.prepare("SELECT * FROM orders WHERE purpose='trim'").all()).toHaveLength(2);
    second.engine.bees.mochi.position!.stopPx = 101;
    await second.engine.tick();
    expect(second.engine.bees.mochi.position).toBeNull();
    expect(second.db.raw.prepare("SELECT * FROM orders WHERE purpose='stop'").all()).toHaveLength(1);
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
    await first.engine.tick();
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
    await first.engine.tick();
    await first.engine.tick();
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


describe("active Dark Wall-E execution", () => {
  const isDark = (ask: DecisionAsk) => ask.strategy.includes("active intraday");
  it("executes a short, places its stop above entry, and stops out even during model failure", async () => {
    let unavailable = false;
    const h = await harness(async ask => unavailable ? {ok:false,reason:"timeout",latencyMs:1} : answer(ask,isDark(ask) ? "SHORT_BTC" : "WAIT"));
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2;
    await h.engine.tick();
    const p = h.engine.bees.tiger.position!;
    expect(p.side).toBe("short"); expect(p.stopPx).toBeGreaterThan(p.entryPx);
    expect(h.db.raw.prepare("SELECT side,reduce_only FROM orders WHERE bee='tiger'").get()).toMatchObject({side:"sell",reduce_only:0});
    unavailable = true; h.s.mid = p.stopPx! + 0.01;
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT side,reduce_only FROM orders WHERE bee='tiger' ORDER BY id DESC LIMIT 1").get()).toMatchObject({side:"buy",reduce_only:1});
  });
  it("allows another entry after a close and cooldown, and closes at the two-hour limit", async () => {
    let choice = "LONG_BTC";
    const h = await harness(async ask => answer(ask,isDark(ask) ? choice : "WAIT"));
    await h.engine.tick(); expect(h.engine.bees.tiger.tradesToday).toBe(1);
    choice = "CLOSE"; await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    choice = "LONG_BTC"; await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    h.advance(5 * 60000); await h.engine.refreshMarket(); h.s.refreshedAt = NOW + 5 * 60000;
    await h.engine.tick(); expect(h.engine.bees.tiger.tradesToday).toBe(2);
    expect(h.engine.bees.tiger.position).not.toBeNull();
    choice = "HOLD"; h.advance(120 * 60000); await h.engine.refreshMarket();
    await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT forced_by FROM decisions WHERE bee='tiger' ORDER BY id DESC LIMIT 1").get()).toMatchObject({forced_by:"time_stop"});
  });
  it("closes a long before opening a short reversal, and counts the new entry", async () => {
    let choice = "LONG_BTC";
    const h = await harness(async ask => answer(ask,isDark(ask) ? choice : "WAIT"));
    await h.engine.tick();
    h.advance(5 * 60000); await h.engine.refreshMarket(); h.s.refreshedAt = NOW + 5 * 60000;
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2; choice = "FLIP_SHORT";
    await h.engine.tick();
    expect(h.engine.bees.tiger.position?.side).toBe("short");
    expect(h.engine.bees.tiger.tradesToday).toBe(2);
    expect(h.db.raw.prepare("SELECT side,reduce_only FROM orders WHERE bee='tiger' ORDER BY id").all()).toEqual([
      expect.objectContaining({side:"buy",reduce_only:0}),expect.objectContaining({side:"sell",reduce_only:1}),expect.objectContaining({side:"sell",reduce_only:0}),
    ]);
  });
});

describe("automatic coach changes in the running engine", () => {
  const coachFetch = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    idea: "Confirmed momentum", rules: "Pick LONG_BTC when r1h_pct > 0 and macd_pct >= 0. Pick WAIT otherwise.",
    coins: "BTC", reason: "Compare momentum with the fixed trend gate.", quip: "DARK Wall-E, check your signals before flexing those claws.",
    note: "Your cat needs evidence before enthusiasm. False breakouts can still lose money.",
  }) } }] }))) as typeof fetch;
  function seedHistory(db: Db) {
    for (let i = 0; i < 31; i++) db.raw.prepare(`INSERT INTO decisions(bee,ts,choice,menu_json,action_json,status,audit_json)
      SELECT bee,?,choice,menu_json,action_json,status,audit_json FROM decisions WHERE bee='tiger' ORDER BY id LIMIT 1`).run(NOW - 3600000 - i * 60000);
  }
  it("hot-applies validated rules and coins and keeps numeric gates, sizing and exits", async () => {
    const h = await harness(async (ask) => answer(ask, ask.strategy.includes("Pick LONG_BTC when r1h_pct") && ask.menu.LONG_BTC ? "LONG_BTC" : "WAIT"), {
      cfg: loadConfig({ AI_GATEWAY_API_KEY: "test-only" }), coachFetch,
    });
    h.s.intraday!.tiger.trend.score = 3;
    h.s.intraday!.mochi.trend.score = 2;
    await h.engine.tick(); seedHistory(h.db);
    expect(h.engine.bees.tiger.position).toBeNull();
    await h.engine.coach.tick();
    const pending = h.engine.coach.state().entries.find((e) => e.cat === "tiger")!;
    expect(pending.status).toBe("accepted");
    expect(h.cfg.cats.tiger.minTrendScore).toBe(3);
    expect(h.cfg.slots.tiger.coins).toEqual(["BTC"]);
    expect(h.engine.bees.tiger.position).toBeNull();
    await h.engine.tick(); expect(h.engine.bees.tiger.position).not.toBeNull();
    expect(h.engine.bees.tiger.position!.stopPx).toBeCloseTo(h.engine.bees.tiger.position!.entryPx * (1 - 0.005 * h.cfg.cats.tiger.stopAtrMult));
    expect(h.engine.bees.mochi.position).toBeNull();
    h.engine.coach.reset("tiger");
    expect(h.cfg.cats.tiger.minTrendScore).toBe(3);
    expect(h.engine.bees.tiger.position!.stopPx).toBeCloseTo(h.engine.bees.tiger.position!.entryPx * (1 - 0.005 * h.cfg.cats.tiger.stopAtrMult));
  });
  it("discards in-flight decisions when automatic rules change", async () => {
    let slow = false;
    const releases: Array<() => void> = [];
    const h = await harness(async (ask) => slow ? new Promise((resolve) => releases.push(() => resolve(answer(ask)))) : answer(ask), {
      cfg: loadConfig({ AI_GATEWAY_API_KEY: "test-only" }), coachFetch,
    });
    h.s.intraday!.tiger.trend.score = 2;
    h.s.intraday!.mochi.trend.score = 2;
    await h.engine.tick(); seedHistory(h.db);
    slow = true;
    const pending = h.engine.tick();
    await Promise.resolve(); await Promise.resolve();
    expect(releases).toHaveLength(2);
    await h.engine.coach.tick();
    releases.forEach((release) => release()); await pending;
    expect(h.db.raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE bee='tiger' AND jev_error='rules_changed_during_request'").get()).toMatchObject({ n: 1 });
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
});

describe("restored source actions reach the executor", () => {
  function pick(ask: DecisionAsk, choice: string) {
    if (ask.menu.WAIT || ask.menu.HOLD) return answer(ask, ask.menu.HOLD ? "HOLD" : "WAIT");
    return answer(ask, choice);
  }
  it("opens a short and adds to the winner without resetting its stop, entry score or opening count", async () => {
    let choice = "SHORT_BTC";
    const cfg = loadConfig({MOCHI_COOLDOWN_MINUTES:"0"});
    const h = await harness(async ask => pick(ask, choice), {cfg});
    await h.engine.tick();
    const before = structuredClone(h.engine.bees.mochi.position!);
    expect(before.side).toBe("short");
    expect(before.stopPx).toBeGreaterThan(before.entryPx);
    h.s.mid=95;
    Object.assign(h.v.tickers.get(h.s.instId)!,{mid:95,bid:94.995,ask:95.005});
    choice="ADD_TO_WINNER";
    await h.engine.tick();
    const after=h.engine.bees.mochi.position!;
    expect(after.contracts).toBeGreaterThan(before.contracts);
    expect(after.entryPx).toBeLessThan(before.entryPx);
    expect(after.stopPx).toBe(before.stopPx);
    expect(after.initialStopPx).toBe(before.initialStopPx);
    expect(after.entryScore).toBe(before.entryScore);
    expect(after.riskUsd).toBeGreaterThan(before.riskUsd);
    expect(h.engine.bees.mochi.tradesToday).toBe(1);
    expect(h.db.loadBee("mochi")!.position).toEqual(after);
    expect(h.db.raw.prepare("SELECT purpose,side,reduce_only FROM orders WHERE bee='mochi' ORDER BY id").all()).toEqual([
      {purpose:"open",side:"sell",reduce_only:0},{purpose:"add",side:"sell",reduce_only:0},
    ]);
  });
  it("closes a long before opening the short side of a flip",async()=>{
    let choice="LONG_BTC";
    const h=await harness(async ask=>pick(ask,choice),{cfg:loadConfig({MOCHI_COOLDOWN_MINUTES:"0"})});
    await h.engine.tick();
    expect(h.engine.bees.mochi.position!.side).toBe("long");
    choice="SHORT_BTC"; await h.engine.tick();
    expect(h.engine.bees.mochi.position!.side).toBe("short");
    expect(h.engine.bees.mochi.tradesToday).toBe(2);
    expect(h.db.raw.prepare("SELECT purpose,side,reduce_only FROM orders WHERE bee='mochi' ORDER BY id").all()).toEqual([
      {purpose:"open",side:"buy",reduce_only:0},{purpose:"switch_close",side:"sell",reduce_only:1},{purpose:"open",side:"sell",reduce_only:0},
    ]);
  });
  it.each(["rejected","unknown","partial"] as const)("does not open the switch leg after a %s close",async outcome=>{
    let choice="LONG_BTC";
    const h=await harness(async ask=>pick(ask,choice),{cfg:loadConfig({MOCHI_COOLDOWN_MINUTES:"0"}),executor:sim=>({
      kind:"sim",init:async()=>{},positions:async()=>null,fundingBills:async()=>null,feesFor:async()=>null,
      market:async(id,req)=>req.reduceOnly
        ? outcome === "partial" ? sim.market(id,{...req,contracts:Math.floor(req.contracts/2)})
          : {ok:false,state:outcome,error:{code:"TEST",message:"close incomplete"}}
        : sim.market(id,req),
    })});
    await h.engine.tick(); const original=h.engine.bees.mochi.position!.contracts;
    choice="SHORT_BTC";await h.engine.tick();
    expect(h.engine.bees.mochi.position!.side).toBe("long");
    expect(h.engine.bees.mochi.tradesToday).toBe(1);
    expect(h.db.raw.prepare("SELECT * FROM orders WHERE bee='mochi' AND reduce_only=0").all()).toHaveLength(1);
    expect(h.engine.bees.mochi.position!.contracts).toBe(outcome==="partial" ? original-Math.floor(original/2) : original);
  });
  it("runs upstream flat forcing and rebalance in the decision loop, and suspends both on model failure",async()=>{
    let unavailable=false;
    const h=await harness(async ask=>ask.menu.WAIT ? answer(ask,"WAIT") : unavailable
      ? {ok:false,reason:"timeout",latencyMs:1}
      : {...answer(ask,ask.menu.HOLD_WINNER ? "HOLD_WINNER":"LONG_BTC"),conviction:0});
    await h.engine.tick();
    expect(h.engine.bees.mochi.position).not.toBeNull();
    expect(h.db.raw.prepare("SELECT forced_by FROM decisions WHERE bee='mochi' ORDER BY id DESC LIMIT 1").get()).toMatchObject({forced_by:"max_flat"});
    h.engine.bees.mochi.position!.contracts=10;
    unavailable=true;await h.engine.tick();
    expect(h.engine.bees.mochi.position!.contracts).toBe(10);
    unavailable=false;await h.engine.tick();
    expect(h.engine.bees.mochi.position!.contracts).toBeGreaterThan(10);
    expect(h.db.raw.prepare("SELECT forced_by FROM decisions WHERE bee='mochi' ORDER BY id DESC LIMIT 1").get()).toMatchObject({forced_by:"rebalance"});
  });
});
