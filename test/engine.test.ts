import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BEES, loadConfig, type BeeId, type Config } from "../src/config.js";
import type { BeeBrain } from "../src/bees/types.js";
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
const isDark = (ask: DecisionAsk) => ask.convictionLabels[0] === "meh";
async function harness(
  decide: DecisionProvider["decide"] = async (ask) => answer(ask),
  opts: {
    cfg?: Config;
    db?: Db;
    executor?: (sim: SimExecutor) => Executor;
    clock?: () => number;
    closeRequested?: () => boolean;
    coachFetch?: typeof fetch;
    decisionKey?: BeeBrain["decisionKey"];
    activeCadence?: boolean;
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
  // Existing scenarios exercise tick mechanics independently of strategy cadence. The cadence
  // cases below opt in explicitly; no shared production brain is mutated by the test harness.
  const core = engine.core as unknown as { brain(id: BeeId): BeeBrain };
  const brain = core.brain.bind(core);
  if (!opts.activeCadence)
    vi.spyOn(core, "brain").mockImplementation(id => ({ ...brain(id), decisionKey: opts.decisionKey }));
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
    now,
    advance: (ms: number) => {
      clock += ms;
      v.tickers.get(s.instId)!.ts = clock;
    },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
function markPrice(h: Harness, mid: number) {
  Object.assign(h.s, { mid, last: mid, bid: mid * 0.99995, ask: mid * 1.00005 });
  Object.assign(h.v.tickers.get(h.s.instId)!, { mid, last: mid, bid: h.s.bid, ask: h.s.ask });
}
async function completeNewBars(h: Harness, elapsedMs: number) {
  h.advance(elapsedMs);
  const at = h.now();
  h.s.confirmed15m = { close: h.s.mid, ts: Math.floor(at / 900000) * 900000 - 900000 };
  h.s.confirmed4h = { close: h.s.mid, ts: Math.floor(at / 14400000) * 14400000 - 14400000 };
  h.s.refreshedAt = h.v.ts = at;
  await h.engine.refreshMarket();
}
describe("Catfolio engine, protection and recovery", () => {
  const completedBar: NonNullable<BeeBrain["decisionKey"]> = ctx => {
    const ts = [...ctx.view.stats.values()][0]?.confirmed15m?.ts;
    return ts === undefined ? null : String(ts);
  };
  it("attempts each completed signal bar once and holds an unchanged invested signal without inference", async () => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask, ask.menu.LONG_BTC ? "LONG_BTC" : "HOLD"));
    const h = await harness(decide, { decisionKey: completedBar });
    await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(2);
    const firstKeys = BEES.map(id => h.engine.bees[id].strategyDecisionKey);
    expect(firstKeys.every(Boolean)).toBe(true);
    expect(BEES.every(id => !!h.engine.bees[id].position)).toBe(true);
    for (let i = 0; i < 3; i++) { h.advance(10000); await h.engine.tick(); }
    expect(decide).toHaveBeenCalledTimes(2);
    expect(h.db.raw.prepare("SELECT * FROM orders WHERE reduce_only=1").all()).toHaveLength(0);
    expect(h.engine.snapshot().cats.every(c => c.cap === null)).toBe(true);
    expect(h.db.recentEvents(30).some(row => JSON.parse(row).status?.includes("next completed signal bar"))).toBe(true);
    await completeNewBars(h,900000);
    await h.engine.tick(); await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(BEES.map(id => h.engine.bees[id].strategyDecisionKey)).not.toEqual(firstKeys);
    expect(h.db.raw.prepare("SELECT * FROM orders WHERE reduce_only=1").all()).toHaveLength(0);
  });
  it("consumes failed model attempts until the next completed signal bar", async () => {
    const decide = vi.fn(async (): Promise<DecisionResult> => ({ok:false,reason:"timeout",latencyMs:1}));
    const h = await harness(decide, {decisionKey:completedBar});
    await h.engine.tick(); await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(h.db.raw.prepare("SELECT * FROM decisions WHERE jev_error IS NOT NULL").all()).toHaveLength(2);
    await completeNewBars(h,900000);
    await h.engine.tick(); await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(4);
    expect(h.db.raw.prepare("SELECT * FROM decisions WHERE jev_error IS NOT NULL").all()).toHaveLength(4);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it("uses the active fifteen-minute and four-hour clocks independently", async () => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask));
    const h = await harness(decide,{activeCadence:true});
    await h.engine.tick(); await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(2);
    const firstMochiKey = h.engine.bees.mochi.strategyDecisionKey;
    await completeNewBars(h,15*60000);
    await h.engine.tick(); await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(3);
    expect(h.engine.bees.mochi.strategyDecisionKey).toBe(firstMochiKey);
    await completeNewBars(h,225*60000);
    await h.engine.tick(); await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(5);
    expect(h.engine.bees.mochi.strategyDecisionKey).not.toBe(firstMochiKey);
    expect(h.db.raw.prepare("SELECT bee,COUNT(*) AS n FROM decisions GROUP BY bee ORDER BY bee").all()).toEqual([{bee:"mochi",n:2},{bee:"tiger",n:3}]);
  });
  it("keeps active-brain stop protection working after the held instrument loses its signal bar", async () => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask,"LONG_BTC"));
    const h = await harness(decide,{activeCadence:true});
    await h.engine.tick();
    h.s.confirmed15m = undefined;
    h.engine.bees.tiger.position!.stopPx = 101;
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(h.db.raw.prepare("SELECT purpose FROM orders WHERE bee='tiger' AND reduce_only=1").get()).toMatchObject({purpose:"stop"});
  });
  it("persists a consumed signal before inference and does not re-query it after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-signal-cadence-")), path = join(dir, "run.sqlite");
    const db = new Db(path);
    const decide = vi.fn(async (ask: DecisionAsk) => {
      const id = isDark(ask) ? "tiger" : "mochi";
      expect(db.loadBee(id)?.strategyDecisionKey).toBeTruthy();
      return answer(ask);
    });
    const first = await harness(decide, { db, decisionKey: completedBar });
    await first.engine.tick(); const key = first.engine.bees.tiger.strategyDecisionKey;
    await first.close();
    const resumedDecide = vi.fn(async (ask: DecisionAsk) => answer(ask));
    const resumed = await harness(resumedDecide, { db: new Db(path), decisionKey: completedBar });
    await resumed.engine.tick();
    expect(resumed.engine.bees.tiger.strategyDecisionKey).toBe(key);
    expect(resumedDecide).not.toHaveBeenCalled();
    await resumed.close(); rmSync(dir, { recursive: true, force: true });
  });
  it.each(["rules", "parameters"])("invalidates a consumed signal when effective %s change", async change => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask));
    const h = await harness(decide, { decisionKey: completedBar });
    await h.engine.tick(); const key = h.engine.bees.tiger.strategyDecisionKey;
    if (change === "rules") h.cfg.slots.tiger.rules += " Be selective.";
    else h.cfg.strategies.tiger.minMomentumPct += 0.01;
    await h.engine.tick(); await h.engine.tick();
    expect(decide).toHaveBeenCalledTimes(3);
    expect(h.engine.bees.tiger.strategyDecisionKey).not.toBe(key);
  });
  it("holds on a missing completed bar without logging an inference failure or suppressing caps", async () => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask, "LONG_BTC"));
    const h = await harness(decide, { decisionKey: () => null });
    h.engine.bees.tiger.tradesToday = h.cfg.cats.tiger.maxTradesPerDay;
    await h.engine.tick();
    expect(decide).not.toHaveBeenCalled();
    expect(h.engine.bees.tiger.cap).toBe("trade_cap");
    expect(h.engine.bees.mochi.cap).toBeNull();
    expect(h.engine.bees.mochi.strategyDecisionKey).toBeUndefined();
    expect(h.db.raw.prepare("SELECT * FROM decisions WHERE jev_error IS NOT NULL").all()).toHaveLength(0);
    expect(h.db.recentEvents(30).some(row => JSON.parse(row).status?.includes("valid completed signal bar"))).toBe(true);
  });
  it.each(["stop", "time_stop", "loss_stop", "trend_reversal"])("still executes %s protection on a consumed signal bar", async reason => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask, "LONG_BTC"));
    const h = await harness(decide, { decisionKey: completedBar });
    await h.engine.tick();
    const id = reason === "trend_reversal" ? "mochi" : "tiger", bee = h.engine.bees[id];
    expect(bee.position).not.toBeNull();
    if (reason === "stop") bee.position!.stopPx = 101;
    if (reason === "time_stop") bee.position!.openedAt = NOW - (h.cfg.strategies.tiger.maxHoldMinutes + 1) * 60000;
    if (reason === "loss_stop") bee.cashUsd = bee.dayStartEquityUsd * 0.8;
    if (reason === "trend_reversal") h.s.trend = trend({ score: -9, shortOn: 9, longOn: 0 });
    await h.engine.tick();
    expect(bee.position).toBeNull();
    await h.engine.tick(); // A protective close does not make this same signal eligible for re-entry.
    expect(bee.position).toBeNull();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(h.db.raw.prepare("SELECT purpose FROM orders WHERE bee=? AND reduce_only=1").all(id)).toEqual([{ purpose: reason }]);
  });
  it.each(BEES)("renews %s's entry allowance without erasing books or bypassing the next cap", async id => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask, "LONG_BTC"));
    const h = await harness(decide), bee = h.engine.bees[id], max = h.cfg.cats[id].maxTradesPerDay;
    bee.tradesToday = max; bee.cap = "trade_cap"; bee.feesTodayUsd = 0.1;
    bee.lastOrderAt = NOW;
    const before = structuredClone(bee), other = structuredClone(h.engine.bees[id === "tiger" ? "mochi" : "tiger"]);
    expect(h.engine.resetEntryLimit(id)).toMatchObject({cat:id,entriesUsed:0,tradesToday:max,maxTradesPerDay:max});
    expect(bee).toEqual({...before,cap:null,entryLimitBaseline:max});
    expect(h.engine.bees[id === "tiger" ? "mochi" : "tiger"]).toEqual(other);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
    expect(h.db.raw.prepare("SELECT * FROM caps WHERE cap='entry_limit_reset'").all()).toHaveLength(1);
    expect(h.db.recentEvents(20).some(row => JSON.parse(row).event === "entry_limit_reset")).toBe(true);
    expect(h.engine.snapshot().cats.find(c => c.bee === id)).toMatchObject({entriesUsed:0,tradesToday:max,cap:null});
    expect(() => h.engine.resetEntryLimit(id)).toThrow(/exhausted/);
    // The reset leaves the cooldown intact; a fresh tick cannot immediately re-enter.
    await h.engine.tick();
    expect(bee.position).toBeNull();
    expect(bee.tradesToday).toBe(max);
    bee.lastOrderAt = null;
    await h.engine.tick();
    expect(bee.position).not.toBeNull();
    expect(bee.tradesToday).toBe(max + 1);
    // Consuming the renewed allowance blocks further entry decisions again.
    bee.tradesToday = 2 * max;
    await h.engine.tick();
    expect(bee.cap).toBe("trade_cap");
    expect(h.engine.snapshot().cats.find(c => c.bee === id)?.entriesUsed).toBe(max);
  });
  it.each(["loss_stop", "fee_budget", "retired", "unrecorded_loss", "unrecorded_fee", "zero_limit", "new_day"])("refuses an entry reset for %s", async reason => {
    const h = await harness(), bee = h.engine.bees.tiger;
    bee.tradesToday = h.cfg.cats.tiger.maxTradesPerDay; bee.cap = "trade_cap";
    if (reason === "loss_stop" || reason === "fee_budget" || reason === "retired") bee.cap = reason;
    if (reason === "unrecorded_loss") bee.equityUsd = bee.dayStartEquityUsd * 0.8;
    if (reason === "unrecorded_fee") bee.feesTodayUsd = h.cfg.cats.tiger.feeBudgetUsdDay;
    if (reason === "zero_limit") h.cfg.cats.tiger.maxTradesPerDay = 0;
    if (reason === "new_day") h.advance(86400000);
    const before = structuredClone(bee);
    expect(() => h.engine.resetEntryLimit("tiger")).toThrow();
    expect(bee).toEqual(before);
    expect(h.db.raw.prepare("SELECT * FROM caps").all()).toHaveLength(0);
  });
  it("does not race a trading tick or change a stopped run", async () => {
    const h = await harness();
    h.engine.bees.tiger.tradesToday = h.cfg.cats.tiger.maxTradesPerDay;
    h.engine.bees.tiger.cap = "trade_cap";
    let release!: () => void;
    h.feed.refreshTickers = () => new Promise<void>(resolve => { release = resolve; });
    const tick = h.engine.tick(); await Promise.resolve();
    expect(() => h.engine.resetEntryLimit("tiger")).toThrow(/in progress/);
    release(); await tick;
    await h.engine.stop();
    expect(() => h.engine.resetEntryLimit("tiger")).toThrow(/stopped/);
  });
  it("rolls back the allowance when its durable audit cannot be saved", async () => {
    const h = await harness(), bee = h.engine.bees.tiger;
    bee.tradesToday = h.cfg.cats.tiger.maxTradesPerDay; bee.cap = "trade_cap";
    h.db.saveBee(bee, NOW);
    h.db.raw.exec("CREATE TRIGGER reject_reset BEFORE INSERT ON caps BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect(() => h.engine.resetEntryLimit("tiger")).toThrow(/audit unavailable/);
    expect(bee.entryLimitBaseline).toBeUndefined();
    expect(h.db.loadBee("tiger")).toMatchObject({cap:"trade_cap",tradesToday:bee.tradesToday});
    expect(h.db.loadBee("tiger")?.entryLimitBaseline).toBeUndefined();
  });
  it("persists entry resets across restart and expires them on the next UTC day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-entry-reset-")), path = join(dir, "run.sqlite");
    const first = await harness(undefined, {db:new Db(path)});
    first.engine.bees.tiger.tradesToday = first.cfg.cats.tiger.maxTradesPerDay;
    first.engine.bees.tiger.cap = "trade_cap";
    first.engine.resetEntryLimit("tiger"); await first.close();
    const resumed = await harness(undefined, {db:new Db(path)});
    expect(resumed.engine.snapshot().cats[0]).toMatchObject({entriesUsed:0,tradesToday:first.cfg.cats.tiger.maxTradesPerDay,cap:null});
    resumed.advance(86400000); await resumed.engine.tick();
    expect(resumed.engine.bees.tiger.entryLimitBaseline).toBeUndefined();
    expect(resumed.engine.bees.tiger.tradesToday).toBe(0);
    await resumed.close(); rmSync(dir,{recursive:true,force:true});
  });
  it("reports stale market data separately from a running engine and clears it on recovery", async () => {
    const h = await harness();
    h.advance(5 * h.cfg.dataRefreshMs + 1);
    await h.engine.tick();
    expect(h.engine.health()).toMatchObject({ ok: false, live: true, reasons: ["market_data_stale"] });
    await h.engine.refreshMarket();
    expect(h.engine.health()).toMatchObject({ ok: true, live: true, reasons: [] });
  });
  it.each(["decisions", "market"] as const)("detects a stalled %s loop even with fresh market data", async which => {
    const h = await harness();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    if (which === "decisions") h.feed.refreshTickers = () => blocked;
    else h.feed.refresh = () => blocked;
    const pending = which === "decisions" ? h.engine.tick() : h.engine.refreshMarket();
    try {
      h.advance(h.engine.health().stallMs + 1);
      h.feed.lastRefreshAt = NOW + h.engine.health().stallMs + 1;
      expect(h.engine.health()).toMatchObject({ ok: false, live: false,
        reasons: expect.arrayContaining([which === "decisions" ? "decision_loop_stalled" : "market_loop_stalled"]),
        loops: { [which]: { running: true, stalled: true } } });
      if (which === "decisions") await h.engine.tick();
      else await h.engine.refreshMarket();
      expect(h.engine.health().loops[which].stalled).toBe(true);
    } finally { release(); await pending; }
    // Refresh completion and a decision completion are independent progress signals.
    await h.engine.refreshMarket(); await h.engine.tick();
    expect(h.engine.health()).toMatchObject({ live: true });
  });
  it("does not treat repeated settled failures as a frozen loop", async () => {
    const h = await harness(async () => ({ ok: false, reason: "timeout", latencyMs: 1 }));
    h.feed.refresh = async () => { throw new Error("exchange temporarily unavailable"); };
    for (let i = 0; i < 12; i++) {
      h.advance(60000);
      await h.engine.refreshMarket(); await h.engine.tick();
    }
    expect(h.engine.health()).toMatchObject({ ok: false, live: true, reasons: ["market_data_stale"] });
  });
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
      strategyVersion: "catfolio-9-profit-protection",
      rubricVersion: "selected-setup-conviction-2",
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
      const recordedCost = 0.001; // WAIT is now a valid model choice for both cats.
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
  it("persists the completed trim across restart and never trims again; stops still protect", async () => {
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
    expect(second.engine.bees.mochi.position!.contracts).toBe(remaining);
    expect(second.db.raw.prepare("SELECT * FROM orders WHERE purpose='trim'").all()).toHaveLength(1);
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
  it("executes a short, places its stop above entry, and stops out even during model failure", async () => {
    let unavailable = false;
    const decide = vi.fn(async (ask: DecisionAsk): Promise<DecisionResult> => unavailable ? {ok:false,reason:"timeout",latencyMs:1} : answer(ask,isDark(ask) ? "SHORT_BTC" : "WAIT"));
    const h = await harness(decide,{activeCadence:true});
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2;
    await h.engine.tick();
    const p = h.engine.bees.tiger.position!;
    expect(p.side).toBe("short"); expect(p.stopPx).toBeGreaterThan(p.entryPx);
    expect(h.db.raw.prepare("SELECT side,reduce_only FROM orders WHERE bee='tiger'").get()).toMatchObject({side:"sell",reduce_only:0});
    unavailable = true; markPrice(h,p.stopPx! + 0.01);
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(decide).toHaveBeenCalledTimes(2); // Stop execution must not wait for or sample the failing model.
    expect(h.engine.bees.tiger.totals.realisedUsd).toBeLessThan(0);
    expect(h.db.raw.prepare("SELECT side,reduce_only FROM orders WHERE bee='tiger' ORDER BY id DESC LIMIT 1").get()).toMatchObject({side:"buy",reduce_only:1});
  });
  it("requires a new signal and cooldown after a deterministic exit, then closes at the holding limit", async () => {
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask,isDark(ask) ? "LONG_BTC" : "WAIT"));
    const h = await harness(decide,{activeCadence:true,cfg:loadConfig({TIGER_COOLDOWN_MINUTES:"20"})});
    await h.engine.tick(); expect(h.engine.bees.tiger.tradesToday).toBe(1);
    await completeNewBars(h,15*60000);
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2;
    await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT purpose FROM orders WHERE bee='tiger' ORDER BY id DESC LIMIT 1").get()).toMatchObject({purpose:"momentum_reversal"});
    h.s.ret1hPct = 1; h.s.macdHistPct = 0.2;
    await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    await completeNewBars(h,15*60000); // A new bar is available, but the 20-minute exit cooldown is not over.
    await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT vetoed_by FROM decisions WHERE bee='tiger' ORDER BY id DESC LIMIT 1").get()).toMatchObject({vetoed_by:"cooldown 5m"});
    await completeNewBars(h,15*60000);
    await h.engine.tick(); expect(h.engine.bees.tiger.tradesToday).toBe(2);
    expect(h.engine.bees.tiger.position).not.toBeNull();
    await completeNewBars(h,120*60000);
    await h.engine.tick(); expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT forced_by FROM decisions WHERE bee='tiger' ORDER BY id DESC LIMIT 1").get()).toMatchObject({forced_by:"time_stop"});
  });
  it("closes a reversed long deterministically and waits until the following bar before entering short", async () => {
    let choice = "LONG_BTC";
    const decide = vi.fn(async (ask: DecisionAsk) => answer(ask,isDark(ask) ? choice : "WAIT"));
    const h = await harness(decide,{activeCadence:true});
    await h.engine.tick();
    await completeNewBars(h,15*60000);
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2; choice = "SHORT_BTC";
    await h.engine.tick(); await h.engine.tick();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.engine.bees.tiger.tradesToday).toBe(1);
    expect(decide).toHaveBeenCalledTimes(2);
    await completeNewBars(h,15*60000);
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
  function seedHistory(db: Db, cat: BeeId = "tiger") {
    const signalPeriod = (cat === "tiger" ? 15 : 240) * 60000;
    for (let i = 0; i < 31; i++) db.raw.prepare(`INSERT INTO decisions(bee,ts,choice,menu_json,action_json,status,audit_json)
      SELECT bee,?,choice,menu_json,action_json,status,audit_json FROM decisions WHERE bee=? ORDER BY id LIMIT 1`)
      .run(NOW - (i + 1) * signalPeriod, cat);
  }
  it("hot-applies validated rules and coins and keeps numeric gates, sizing and exits", async () => {
    const h = await harness(async (ask) => answer(ask, ask.strategy.includes("Pick LONG_BTC when r1h_pct") && ask.menu.LONG_BTC ? "LONG_BTC" : "WAIT"), {
      cfg: loadConfig({ AI_GATEWAY_API_KEY: "test-only", COACH_AUTO_APPLY: "true" }), coachFetch,
    });
    h.s.intraday!.tiger.trend.score = 3;
    h.s.intraday!.mochi.trend.score = 2;
    await h.engine.tick(); seedHistory(h.db);
    expect(h.engine.bees.tiger.position).toBeNull();
    await h.engine.coach.tick();
    const pending = h.engine.coach.state().entries.find((e) => e.cat === "tiger")!;
    expect(pending.status).toBe("accepted");
    expect(h.cfg.cats.tiger.minConviction).toBe(1);
    expect(h.cfg.slots.tiger.coins).toEqual(["BTC"]);
    expect(h.engine.bees.tiger.position).toBeNull();
    await h.engine.tick(); expect(h.engine.bees.tiger.position).not.toBeNull();
    expect(h.engine.bees.tiger.position!.stopPx).toBeCloseTo(h.engine.bees.tiger.position!.entryPx * (1 - 0.005 * h.cfg.cats.tiger.stopAtrMult));
    expect(h.engine.bees.mochi.position).toBeNull();
    h.engine.coach.reset("tiger");
    expect(h.cfg.cats.tiger.minConviction).toBe(1);
    expect(h.engine.bees.tiger.position!.stopPx).toBeCloseTo(h.engine.bees.tiger.position!.entryPx * (1 - 0.005 * h.cfg.cats.tiger.stopAtrMult));
  });
  it("discards in-flight decisions when automatic rules change", async () => {
    let slow = false;
    const releases: Array<() => void> = [];
    const h = await harness(async (ask) => slow ? new Promise((resolve) => releases.push(() => resolve(answer(ask)))) : answer(ask), {
      cfg: loadConfig({ AI_GATEWAY_API_KEY: "test-only", COACH_AUTO_APPLY: "true" }), coachFetch,
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

describe("active strategy position management reaches the executor", () => {
  function pick(ask: DecisionAsk, choice: string) {
    if (isDark(ask)) return answer(ask, ask.menu.HOLD ? "HOLD" : "WAIT");
    return answer(ask, choice);
  }
  it("can add to a short winner when optional profit management is disabled, preserving entry risk and count", async () => {
    let choice = "SHORT_BTC";
    const cfg = loadConfig({MOCHI_COOLDOWN_MINUTES:"0", MOCHI_BREAKEVEN_AT_R:"0", MOCHI_TRAIL_ACTIVATION_R:"0",
      MOCHI_PROFIT_LOCK_AT_R:"0", MOCHI_EXIT_REVIEW_MIN_R:"0", MOCHI_PARTIAL_TAKE_PROFIT_ENABLED:"false"});
    const h = await harness(async ask => pick(ask, choice), {cfg,activeCadence:true});
    h.s.trend!.score = -9;
    await h.engine.tick();
    h.engine.bees.mochi.position!.stopPx = 99; // A trailed stop frees risk budget for a winner add.
    const before = structuredClone(h.engine.bees.mochi.position!);
    expect(before.side).toBe("short");
    expect(before.initialStopPx).toBeGreaterThan(before.entryPx);
    markPrice(h,95);
    await completeNewBars(h,4*3600000);
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
  it("closes a failed four-hour trend before considering the opposite side on a later bar",async()=>{
    let choice="LONG_BTC";
    const h=await harness(async ask=>pick(ask,choice),{cfg:loadConfig({MOCHI_COOLDOWN_MINUTES:"0"}),activeCadence:true});
    await h.engine.tick();
    expect(h.engine.bees.mochi.position!.side).toBe("long");
    await completeNewBars(h,4*3600000);
    choice="SHORT_BTC"; h.s.trend!.score=-9; await h.engine.tick();
    expect(h.engine.bees.mochi.position).toBeNull();
    await h.engine.tick();
    expect(h.engine.bees.mochi.position).toBeNull();
    await completeNewBars(h,4*3600000);
    await h.engine.tick();
    expect(h.engine.bees.mochi.position!.side).toBe("short");
    expect(h.engine.bees.mochi.tradesToday).toBe(2);
    expect(h.db.raw.prepare("SELECT purpose,side,reduce_only FROM orders WHERE bee='mochi' ORDER BY id").all()).toEqual([
      {purpose:"open",side:"buy",reduce_only:0},{purpose:"trend_reversal",side:"sell",reduce_only:1},{purpose:"open",side:"sell",reduce_only:0},
    ]);
  });
  it.each(["rejected","unknown","partial"] as const)("does not open the opposite side after a %s protective close",async outcome=>{
    let choice="LONG_BTC";
    const h=await harness(async ask=>pick(ask,choice),{cfg:loadConfig({MOCHI_COOLDOWN_MINUTES:"0"}),activeCadence:true,executor:sim=>({
      kind:"sim",init:async()=>{},positions:async()=>null,fundingBills:async()=>null,feesFor:async()=>null,
      market:async(id,req)=>req.reduceOnly
        ? outcome === "partial" ? sim.market(id,{...req,contracts:Math.floor(req.contracts/2)})
          : {ok:false,state:outcome,error:{code:"TEST",message:"close incomplete"}}
        : sim.market(id,req),
    })});
    await h.engine.tick(); const original=h.engine.bees.mochi.position!.contracts;
    choice="SHORT_BTC";h.s.trend!.score=-9;await h.engine.tick();
    expect(h.engine.bees.mochi.position!.side).toBe("long");
    expect(h.engine.bees.mochi.tradesToday).toBe(1);
    expect(h.db.raw.prepare("SELECT * FROM orders WHERE bee='mochi' AND reduce_only=0").all()).toHaveLength(1);
    expect(h.engine.bees.mochi.position!.contracts).toBe(outcome==="partial" ? original-Math.floor(original/2) : original);
  });
  it("does not force weak entries or rebalance a held position",async()=>{
    let choice="LONG_BTC", conviction=0;
    const h=await harness(async ask=>isDark(ask) ? answer(ask,"WAIT")
      : {...answer(ask,choice),conviction});
    await h.engine.tick();
    expect(h.engine.bees.mochi.position).toBeNull();
    expect(h.db.raw.prepare("SELECT vetoed_by,forced_by FROM decisions WHERE bee='mochi' ORDER BY id DESC LIMIT 1").get()).toMatchObject({forced_by:null,vetoed_by:expect.stringContaining("weak_conviction")});
    conviction=3;await h.engine.tick();
    h.engine.bees.mochi.position!.contracts=1;
    choice="HOLD_WINNER";await h.engine.tick();
    expect(h.engine.bees.mochi.position!.contracts).toBe(1);
    expect(h.db.raw.prepare("SELECT * FROM orders WHERE purpose='add'").all()).toHaveLength(0);
  });
});
