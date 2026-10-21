import { BEES } from "./config.js";
import type { Db } from "./db.js";
import type { CatfolioEngine as Engine } from "./catfolio-engine.js";
import { tradePerformance } from "./performance.js";
const percentile = (values: number[], p: number): number | null =>
  values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)]! : null;
export function morningReport(
  db: Db,
  snapshot?: ReturnType<Engine["snapshot"]>,
) {
  const allocation = JSON.parse(db.getMeta("allocation") ?? "null") as {
    total: number;
    allocations: number[];
    mode: string;
  } | null;
  if (!allocation) throw new Error("No Catfolio run in this database");
  const cats = BEES.map((id, i) => {
    const stored = db.loadBee(id);
    if (!stored) throw new Error(`Missing persisted ${id} account`);
    const current = snapshot?.cats.find((c) => c.bee === id);
    const equity = current?.equityUsd ?? stored.equityUsd;
    const start = (allocation.total * allocation.allocations[i]!) / 100;
    const counts = db.raw
      .prepare(
        `SELECT COUNT(*) AS decisions, COALESCE(SUM(vetoed_by IS NOT NULL),0) AS vetoes, COALESCE(SUM(jev_error IS NOT NULL),0) AS modelFailures FROM decisions WHERE bee=?`,
      )
      .get(id) as { decisions: number; vetoes: number; modelFailures: number };
    const orders = db.raw
      .prepare(
        `SELECT COALESCE(SUM(reduce_only=0),0) AS entries, COALESCE(SUM(reduce_only=1),0) AS exits FROM orders WHERE bee=? AND state='filled'`,
      )
      .get(id) as { entries: number; exits: number };
    const latency = (
      db.raw
        .prepare(
          `SELECT latency_ms AS ms FROM decisions WHERE bee=? AND latency_ms IS NOT NULL ORDER BY latency_ms`,
        )
        .all(id) as Array<{ ms: number }>
    ).map((r) => r.ms);
    return {
      cat: id,
      startingEquityUsd: start,
      endingEquityUsd: equity,
      netReturnPct: (equity / start - 1) * 100,
      netPnlUsd: equity - start,
      realisedPnlUsd: stored.totals.realisedUsd,
      unrealisedPnlUsd: current?.uplUsd ?? stored.uplUsd,
      feesUsd: stored.totals.feesUsd,
      estimatedInferenceCostUsd: stored.totals.jevUsd,
      netPnlAfterEstimatedInferenceUsd: equity - start - stored.totals.jevUsd,
      fundingUsd: stored.totals.fundingUsd,
      simulatedSlippageUsd: stored.slippageUsd,
      maxDrawdownPct: current?.maxDrawdownPct ?? stored.maxDrawdownPct,
      timeExposedHours: (current?.exposedMs ?? stored.exposedMs) / 3600000,
      ...counts,
      ...orders,
      performance: tradePerformance(db, id),
      inferenceLatencyMs: {
        samples: latency.length,
        median: percentile(latency, 0.5),
        p95: percentile(latency, 0.95),
      },
    };
  });
  return {
    product: "Catfolio",
    mode: allocation.mode === "dry" ? "PAPER" : allocation.mode.toUpperCase(),
    startedAt: Number(db.getMeta("experiment_started_at")),
    asOf:
      snapshot?.ts ??
      Math.max(...BEES.map((id) => db.loadBee(id)?.metricsAt ?? 0)),
    cats,
    backends: db.raw
      .prepare(
        `SELECT DISTINCT COALESCE(json_extract(audit_json, '$.config.provider'), 'lmstudio') AS provider, json_extract(audit_json, '$.config.model') AS requestedModel FROM decisions WHERE audit_json IS NOT NULL AND (choice IS NOT NULL OR jev_error IS NOT NULL)`,
      )
      .all(),
    limitations:
      "Whole-run report; mixed providers do not allow clean attribution of trading returns. API costs are estimates. Gemini includes output/thinking tokens and reserves unknown billing at its worst case; Jev estimates input tokens, and timeouts may still be billed. Costs are separate from cat trading equity. Equity uses the last observed quote; CLI does not fetch new quotes. Realised P&L is before fees/funding. Slippage includes half spread plus configured adverse slippage, already embedded in P&L. Funding approximates 8-hour settlements; downtime is not backfilled. Exposure time excludes downtime. No queue, depth, liquidation or market impact simulation. A profitable night is not evidence of a durable advantage.",
  };
}
