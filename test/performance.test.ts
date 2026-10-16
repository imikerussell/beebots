import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import type { BeeId } from "../src/config.js";
import { aggregateTrades, completedTrades, tradePerformance } from "../src/performance.js";
import { freshBee } from "../src/ledger.js";
import { morningReport } from "../src/report.js";

const databases: Db[] = [];
const START = Date.UTC(2026, 9, 1);
function fixture() {
  const db = new Db(":memory:"); databases.push(db);
  let sequence = 0;
  const fill = (options: { cat?: BeeId; ts?: number; contracts?: number; side?: "buy" | "sell";
    purpose?: string; reducing?: boolean; gross?: number; fee?: number; slippage?: number;
    version?: string | null; audit?: string; instId?: string; orderId?: number } = {}) => {
    sequence++;
    const cat = options.cat ?? "tiger", ts = options.ts ?? START + sequence * 60_000;
    const purpose = options.purpose ?? "open", reducing = options.reducing ?? purpose !== "open";
    const side = options.side ?? (reducing ? "sell" : "buy"), contracts = options.contracts ?? 10;
    const instId = options.instId ?? "BTC-USD_UM_XPERP-040431";
    const audit = options.audit ?? (options.version === null ? undefined : JSON.stringify({ strategyVersion: options.version ?? "v1" }));
    const decisionId = db.insertDecision({ bee: cat, ts, stateHash: null, stateJson: null, menuJson: null,
      choice: purpose, probabilities: null, confidence: null, conviction: null, latencyMs: null,
      inputTokens: null, jevCostUsd: 0, jevError: null, action: {}, vetoedBy: null, forcedBy: null,
      status: purpose, auditJson: audit });
    const orderId = options.orderId ?? db.insertOrder({ decisionId, bee: cat, ts, clOrdId: `test-${sequence}`,
      instId, side, contracts, reduceOnly: reducing, purpose });
    // Intentionally leave order state='sent': recorded executions, not final order state, determine P&L.
    db.insertFill({ orderId, bee: cat, ts, instId, side, contracts, px: 100, notionalUsd: contracts * 100,
      feeUsd: options.fee ?? 0.1, realisedUsd: options.gross ?? 0, slippageUsd: options.slippage ?? 0.2 });
    return { orderId, decisionId, ts };
  };
  return { db, fill };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("completed trade performance", () => {
  it("counts split opens, adds, partial closes and trims as one round trip with every execution cost", () => {
    const { db, fill } = fixture();
    const first = fill({ contracts: 4 });
    fill({ contracts: 6, orderId: first.orderId });
    fill({ contracts: 5, purpose: "add", reducing: false });
    fill({ contracts: 4, purpose: "trim", gross: 3 });
    const exit = fill({ contracts: 5, purpose: "stop", gross: 4 });
    expect(completedTrades(db, "tiger")).toEqual([]);
    fill({ contracts: 6, purpose: "stop", gross: 5, orderId: exit.orderId });
    const trades = completedTrades(db, "tiger");
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: "long", coin: "BTC", exitReason: "stop", fills: 6,
      entryOrderId: first.orderId, holdingMinutes: 5, strategyVersion: "v1", attribution: "single_version",
      grossRealisedPnlUsd: 12, feesUsd: expect.closeTo(0.6), netPnlAfterFeesUsd: expect.closeTo(11.4),
      slippageUsd: expect.closeTo(1.2), turnoverUsd: 3000 });
    expect(aggregateTrades(trades)).toMatchObject({ closedTrades: 1, winners: 1, profitFactor: null,
      winRatePct: 100, expectancyUsd: expect.closeTo(11.4), medianHoldingMinutes: 5 });
  });

  it("uses net after-fee wins and losses and separates coins, sides, exit reasons and cats", () => {
    const { db, fill } = fixture();
    fill(); fill({ purpose: "momentum_exit", gross: 2.2 }); // +2 net
    fill({ side: "sell", instId: "ETH-USDT-SWAP" });
    fill({ side: "buy", instId: "ETH-USDT-SWAP", purpose: "stop", gross: -0.8 }); // -1 net
    fill({ cat: "mochi" }); fill({ cat: "mochi", purpose: "stop", gross: 100 });
    const result = tradePerformance(db, "tiger");
    expect(result).toMatchObject({ closedTrades: 2, winners: 1, losers: 1, winRatePct: 50,
      expectancyUsd: expect.closeTo(0.5), profitFactor: expect.closeTo(2), netClosedPnlAfterFeesUsd: expect.closeTo(1),
      medianHoldingMinutes: 1, turnoverUsd: 4000 });
    expect(result.byCoin).toEqual(expect.arrayContaining([
      expect.objectContaining({ coin: "BTC", closedTrades: 1, winners: 1 }),
      expect.objectContaining({ coin: "ETH", closedTrades: 1, losers: 1 }),
    ]));
    expect(result.bySide).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: "short", losers: 1 }), expect.objectContaining({ side: "long", winners: 1 }),
    ]));
    expect(result.byExitReason).toEqual(expect.arrayContaining([
      expect.objectContaining({ exitReason: "stop", closedTrades: 1 }),
    ]));
    expect(completedTrades(db, "mochi")).toHaveLength(1);
  });

  it("reconstructs history before the window and includes only complete in-window cycles", () => {
    const { db, fill } = fixture();
    const first = fill(); const close = fill({ purpose: "close", gross: 1 });
    expect(completedTrades(db, "tiger", { until: close.ts - 1 })).toEqual([]);
    expect(completedTrades(db, "tiger", { since: first.ts + 1 })).toEqual([]);
    expect(completedTrades(db, "tiger", { since: first.ts, until: close.ts })).toHaveLength(1);
    expect(tradePerformance(db, "tiger", { since: first.ts + 1 })).toMatchObject({
      diagnostics: { openedBeforeWindow: 1, orphanReducingFills: 0 }, executionTotals: { fills: 1 },
    });
  });

  it("flags mixed and missing audit attribution and excludes them from a version filter", () => {
    const { db, fill } = fixture();
    fill(); fill({ purpose: "close", version: "v2" });
    fill({ version: null }); fill({ purpose: "close", version: null });
    fill({ audit: "invalid legacy json" }); fill({ purpose: "close" });
    fill(); fill({ purpose: "close" });
    const all = completedTrades(db, "tiger");
    expect(all.map(t => t.attribution)).toEqual(["mixed_versions", "legacy_missing_audit", "legacy_missing_audit", "single_version"]);
    expect(all[0]).toMatchObject({ strategyVersion: null, strategyVersions: ["v1", "v2"] });
    expect(completedTrades(db, "tiger", { version: "v1" })).toHaveLength(1);
    const result = tradePerformance(db, "tiger");
    expect(result.attribution).toEqual({ singleVersionTrades: 1, mixedVersionTrades: 1, legacyMissingAuditTrades: 2 });
    expect(result.byStrategyVersion).toHaveLength(1);
    expect(result.byStrategyVersion[0]).toMatchObject({ strategyVersion: "v1", closedTrades: 1 });
  });

  it("reports unfinished fills and keeps funding and model cost outside completed trade expectancy", () => {
    const { db, fill } = fixture();
    fill(); fill({ purpose: "close", gross: 1.2 });
    const pending = fill(); fill({ purpose: "trim", contracts: 5, gross: 10 });
    db.insertFunding("tiger", pending.ts, "BTC-USD_UM_XPERP-040431", -2, "funding-1");
    db.raw.prepare("UPDATE decisions SET jev_cost_usd=3 WHERE id=?").run(pending.decisionId);
    const result = tradePerformance(db, "tiger");
    expect(result).toMatchObject({ closedTrades: 1, netClosedPnlAfterFeesUsd: expect.closeTo(1),
      diagnostics: { unfinishedPositions: 1 },
      executionTotals: { fills: 4, grossRealisedPnlUsd: 11.2, turnoverUsd: 3500 },
      unallocatedCosts: { fundingPnlUsd: -2, estimatedInferenceCostUsd: 3 } });
  });

  it("excludes a strategy changed while holding even when both entry and exit execute under the original version", () => {
    const { db, fill } = fixture();
    fill({ ts: START + 60_000 });
    const transient = fill({ ts: START + 120_000 });
    db.raw.prepare("DELETE FROM fills WHERE order_id=?").run(transient.orderId);
    db.raw.prepare("UPDATE decisions SET audit_json=? WHERE id=?")
      .run(JSON.stringify({ strategyVersion: "v2" }), transient.decisionId);
    fill({ ts: START + 180_000, purpose: "close" });
    expect(completedTrades(db, "tiger")[0]).toMatchObject({ attribution: "mixed_versions", strategyVersions: ["v1", "v2"] });
    expect(completedTrades(db, "tiger", { version: "v1" })).toEqual([]);
  });

  it("does not invent trades from orphan exits, missing opening history or over-closes", () => {
    const { db, fill } = fixture();
    fill({ purpose: "close" });
    fill({ purpose: "add", reducing: false }); fill({ purpose: "close" });
    fill({ contracts: 5 }); fill({ contracts: 6, purpose: "close" });
    const invalid = fill();
    db.raw.prepare("DELETE FROM orders WHERE id=?").run(invalid.orderId);
    const result = tradePerformance(db, "tiger");
    expect(result.closedTrades).toBe(0);
    expect(result.diagnostics).toMatchObject({ orphanReducingFills: 1, incompleteOriginTrades: 1,
      inconsistentTrades: 1, invalidFills: 1 });
    expect(result.executionTotals.fills).toBe(6);
  });

  it("treats a paper resume as a new cycle and preserves small positive contract balances", () => {
    const { db, fill } = fixture();
    fill({ contracts: 0.00000002, purpose: "resume_last", reducing: false });
    fill({ contracts: 0.00000001, purpose: "trim" });
    expect(completedTrades(db, "tiger")).toEqual([]);
    fill({ contracts: 0.00000001, purpose: "close" });
    expect(completedTrades(db, "tiger")).toHaveLength(1);
  });

  it("returns undefined sample statistics as null and validates time boundaries", () => {
    const { db } = fixture();
    expect(aggregateTrades([])).toMatchObject({ closedTrades: 0, winRatePct: null, expectancyUsd: null,
      profitFactor: null, medianHoldingMinutes: null, netClosedPnlAfterFeesUsd: 0 });
    expect(() => completedTrades(db, "tiger", { since: 2, until: 1 })).toThrow("Invalid trade performance window");
    expect(() => completedTrades(db, "tiger", { until: Infinity })).toThrow("Invalid trade performance window");
  });

  it("adds detailed outcomes to the morning report without changing existing capital totals", () => {
    const { db, fill } = fixture();
    db.setMeta("allocation", JSON.stringify({ total: 500, allocations: [50, 50], mode: "dry" }));
    db.setMeta("experiment_started_at", String(START));
    db.saveBee(freshBee("tiger", 250, START), START); db.saveBee(freshBee("mochi", 250, START), START);
    fill(); fill({ purpose: "stop", gross: 2.2 });
    const report = morningReport(db);
    expect(report.mode).toBe("PAPER");
    expect(report.cats[0]).toMatchObject({ startingEquityUsd: 250, endingEquityUsd: 250, netPnlUsd: 0,
      performance: { closedTrades: 1, netClosedPnlAfterFeesUsd: expect.closeTo(2) } });
  });
});
