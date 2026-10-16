import type { BeeId } from "./config.js";
import type { Db } from "./db.js";

export interface TradeWindow {
  /** Require the first opening fill in the window; never truncate a trade's entry costs. */
  since?: number;
  /** Last included execution timestamp, inclusive. */
  until?: number;
  /** Every fill must have this strategy version; mixed and legacy trades are excluded. */
  version?: string;
}

export interface CompletedTrade {
  cat: BeeId;
  instId: string;
  coin: string;
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  holdingMinutes: number;
  entryOrderId: number;
  exitReason: string;
  strategyVersion: string | null;
  strategyVersions: string[];
  attribution: "single_version" | "mixed_versions" | "legacy_missing_audit";
  missingAudit: boolean;
  fills: number;
  grossRealisedPnlUsd: number;
  feesUsd: number;
  netPnlAfterFeesUsd: number;
  /** Informational only: already embedded in executed prices and realised P&L. */
  slippageUsd: number;
  /** Sum of absolute executed notionals, including opens, adds, trims and exits. */
  turnoverUsd: number;
}

interface Execution {
  id: number; orderId: number; ts: number; instId: string; side: string; contracts: number;
  notional: number; fee: number; realised: number; slippage: number;
  reducing: number | null; purpose: string | null; orderInstId: string | null; audit: string | null;
}

interface OpenTrade {
  instId: string; side: "long" | "short"; openedAt: number; entryOrderId: number;
  remaining: number; versions: Set<string>; missingAudit: boolean; completeOrigin: boolean; valid: boolean;
  fills: number; gross: number; fees: number; slippage: number; turnover: number;
}

function bounds(options: TradeWindow) {
  const since = options.since ?? 0, until = options.until ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || until < since)
    throw new Error("Invalid trade performance window");
  return { since, until };
}

function strategyVersion(audit: string | null): string | null {
  try {
    const value: unknown = audit ? JSON.parse(audit) : null;
    if (value && typeof value === "object" && "strategyVersion" in value &&
      typeof value.strategyVersion === "string" && value.strategyVersion.length) return value.strategyVersion;
  } catch { /* Legacy or malformed audits cannot establish version attribution. */ }
  return null;
}

function scanTrades(db: Db, cat: BeeId, options: TradeWindow) {
  const { since, until } = bounds(options);
  // Read before `since` to recognise existing positions and their eventual close correctly.
  // Fills are the source of truth even if an order's final state was never updated.
  const fills = db.raw.prepare(`SELECT f.id, f.order_id AS orderId, f.ts, f.inst_id AS instId, f.side,
    f.contracts, f.notional_usd AS notional, f.fee_usd AS fee, f.realised_usd AS realised,
    f.slippage_usd AS slippage, o.reduce_only AS reducing, o.purpose, o.inst_id AS orderInstId,
    d.audit_json AS audit FROM fills f
    LEFT JOIN orders o ON o.id=f.order_id AND o.bee=f.bee
    LEFT JOIN decisions d ON d.id=o.decision_id AND d.bee=f.bee
    WHERE f.bee=? AND f.ts<=? ORDER BY f.ts,f.id`).all(cat, until) as unknown as Execution[];
  const open = new Map<string, OpenTrade>(), trades: CompletedTrade[] = [];
  const interveningVersions = db.raw.prepare(`SELECT DISTINCT version FROM (
    SELECT CASE WHEN json_valid(audit_json) THEN json_extract(audit_json,'$.strategyVersion') END AS version
    FROM decisions WHERE bee=? AND ts>=? AND ts<=?
  ) WHERE typeof(version)='text' AND length(version)>0`);
  const diagnostics = { unfinishedPositions: 0, orphanReducingFills: 0, invalidFills: 0,
    incompleteOriginTrades: 0, inconsistentTrades: 0, openedBeforeWindow: 0, excludedByVersion: 0 };
  const executionTotals = { fills: 0, turnoverUsd: 0, feesUsd: 0, grossRealisedPnlUsd: 0, slippageUsd: 0 };
  for (const f of fills) {
    const inWindow = f.ts >= since;
    const numeric = [f.contracts, f.notional, f.fee, f.realised, f.slippage].every(Number.isFinite);
    if (inWindow && numeric) {
      executionTotals.fills++;
      executionTotals.turnoverUsd += Math.abs(f.notional);
      executionTotals.feesUsd += f.fee;
      executionTotals.grossRealisedPnlUsd += f.realised;
      executionTotals.slippageUsd += f.slippage;
    }
    if (!numeric || f.contracts <= 0 || !["buy", "sell"].includes(f.side) ||
      (f.reducing !== 0 && f.reducing !== 1) || f.orderInstId !== f.instId) {
      if (inWindow) diagnostics.invalidFills++;
      const existing = open.get(f.instId);
      if (existing) existing.valid = false;
      continue;
    }
    let trade = open.get(f.instId);
    if (!trade) {
      if (f.reducing) { if (inWindow) diagnostics.orphanReducingFills++; continue; }
      trade = { instId: f.instId, side: f.side === "buy" ? "long" : "short", openedAt: f.ts,
        entryOrderId: f.orderId, remaining: 0, versions: new Set(), missingAudit: false,
        completeOrigin: f.purpose === "open" || f.purpose === "resume_last", valid: true,
        fills: 0, gross: 0, fees: 0, slippage: 0, turnover: 0 };
      open.set(f.instId, trade);
    }
    const openingSide = trade.side === "long" ? "buy" : "sell";
    if ((f.reducing === 0) !== (f.side === openingSide) ||
      (f.reducing && f.contracts > trade.remaining + 1e-8)) trade.valid = false;
    const version = strategyVersion(f.audit);
    if (version) trade.versions.add(version); else trade.missingAudit = true;
    trade.fills++;
    trade.gross += f.realised;
    trade.fees += f.fee;
    trade.slippage += f.slippage;
    trade.turnover += Math.abs(f.notional);
    // Match the ledger's eight-decimal contract balance, not order purpose or order state.
    trade.remaining = Number((trade.remaining + (f.reducing ? -1 : 1) * f.contracts).toFixed(8));
    if (trade.remaining > 0) continue;
    open.delete(f.instId);
    if (!inWindow) continue;
    if (!trade.completeOrigin) { diagnostics.incompleteOriginTrades++; continue; }
    if (!trade.valid) { diagnostics.inconsistentTrades++; continue; }
    if (trade.openedAt < since) { diagnostics.openedBeforeWindow++; continue; }
    // A deployment can change strategy while holding without placing an intermediate order.
    // Preserve known intervening versions even if a later deployment returns to the entry version.
    for (const row of interveningVersions.all(cat, trade.openedAt, f.ts) as Array<{ version: string }>)
      trade.versions.add(row.version);
    const versions = [...trade.versions].sort();
    const attribution = versions.length > 1 ? "mixed_versions" : trade.missingAudit ? "legacy_missing_audit" : "single_version";
    const versionOnly = attribution === "single_version" ? versions[0]! : null;
    if (options.version !== undefined && versionOnly !== options.version) { diagnostics.excludedByVersion++; continue; }
    trades.push({ cat, instId: trade.instId, coin: trade.instId.split("-")[0]!, side: trade.side,
      openedAt: trade.openedAt, closedAt: f.ts, holdingMinutes: (f.ts - trade.openedAt) / 60_000,
      entryOrderId: trade.entryOrderId, exitReason: f.purpose ?? "unknown", strategyVersion: versionOnly,
      strategyVersions: versions, attribution, missingAudit: trade.missingAudit, fills: trade.fills,
      grossRealisedPnlUsd: trade.gross, feesUsd: trade.fees, netPnlAfterFeesUsd: trade.gross - trade.fees,
      slippageUsd: trade.slippage, turnoverUsd: trade.turnover });
  }
  diagnostics.unfinishedPositions = open.size;
  return { trades, diagnostics, executionTotals };
}

/** Fully observed opening-to-flat cycles. Partial trims never count as completed trades. */
export function completedTrades(db: Db, cat: BeeId, options: TradeWindow = {}): CompletedTrade[] {
  return scanTrades(db, cat, options).trades;
}

export function aggregateTrades(rows: readonly CompletedTrade[]) {
  const winners = rows.filter(t => t.netPnlAfterFeesUsd > 0), losers = rows.filter(t => t.netPnlAfterFeesUsd < 0);
  const sum = (field: "netPnlAfterFeesUsd" | "grossRealisedPnlUsd" | "feesUsd" | "slippageUsd" | "turnoverUsd") =>
    rows.reduce((total, t) => total + t[field], 0);
  const winningPnlAfterFeesUsd = winners.reduce((total, t) => total + t.netPnlAfterFeesUsd, 0);
  const losingPnlAfterFeesUsd = -losers.reduce((total, t) => total + t.netPnlAfterFeesUsd, 0);
  const durations = rows.map(t => t.holdingMinutes).sort((a, b) => a - b), middle = Math.floor(durations.length / 2);
  const netClosedPnlAfterFeesUsd = sum("netPnlAfterFeesUsd");
  return { closedTrades: rows.length, winners: winners.length, losers: losers.length,
    breakeven: rows.length - winners.length - losers.length,
    winRatePct: rows.length ? winners.length / rows.length * 100 : null,
    grossRealisedPnlUsd: sum("grossRealisedPnlUsd"), feesUsd: sum("feesUsd"), netClosedPnlAfterFeesUsd,
    expectancyUsd: rows.length ? netClosedPnlAfterFeesUsd / rows.length : null,
    winningPnlAfterFeesUsd, losingPnlAfterFeesUsd,
    // Null means undefined (no losing trades), never an infinite JSON number or a claim of certainty.
    profitFactor: losingPnlAfterFeesUsd > 0 ? winningPnlAfterFeesUsd / losingPnlAfterFeesUsd : null,
    medianHoldingMinutes: durations.length ? durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2 : null,
    slippageUsd: sum("slippageUsd"), turnoverUsd: sum("turnoverUsd") };
}

/** Outcome attribution plus unallocated costs and ledger coverage diagnostics. */
export function tradePerformance(db: Db, cat: BeeId, options: TradeWindow = {}) {
  const { since, until } = bounds(options), result = scanTrades(db, cat, options), rows = result.trades;
  const grouped = <K extends "coin" | "side" | "exitReason" | "strategyVersion">(key: K, source = rows) => {
    const groups = new Map<string, CompletedTrade[]>();
    for (const row of source) {
      const value = row[key];
      if (value === null) continue;
      groups.set(value, [...(groups.get(value) ?? []), row]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([value, trades]) => ({ [key]: value, ...aggregateTrades(trades) }));
  };
  const funding = db.raw.prepare("SELECT COALESCE(SUM(amount_usd),0) AS amount FROM funding WHERE bee=? AND ts>=? AND ts<=?")
    .get(cat, since, until) as { amount: number };
  const inference = db.raw.prepare("SELECT COALESCE(SUM(jev_cost_usd),0) AS amount FROM decisions WHERE bee=? AND ts>=? AND ts<=?")
    .get(cat, since, until) as { amount: number };
  return { ...aggregateTrades(rows), byCoin: grouped("coin"), bySide: grouped("side"), byExitReason: grouped("exitReason"),
    byStrategyVersion: grouped("strategyVersion"),
    attribution: { singleVersionTrades: rows.filter(t => t.attribution === "single_version").length,
      mixedVersionTrades: rows.filter(t => t.attribution === "mixed_versions").length,
      legacyMissingAuditTrades: rows.filter(t => t.attribution === "legacy_missing_audit").length },
    diagnostics: result.diagnostics, executionTotals: result.executionTotals,
    unallocatedCosts: { fundingPnlUsd: funding.amount, estimatedInferenceCostUsd: inference.amount },
    limitations: "Trade outcomes require an observed opening fill and a flat contract balance. The window includes only trades opened and fully closed within it. Attribution checks every fill and known strategy versions in intervening decisions; missing non-executing audits cannot establish a version change. Mixed-version and missing-fill-audit trades remain in overall outcomes but are excluded from version attribution. Slippage is already embedded in realised P&L and is not subtracted again. Funding and estimated inference costs are reported separately, not allocated to trades or versions. Execution totals include unfinished and excluded trades and all fills within the time window, even with a version filter. Median holding time and profit factor describe this sample; they do not establish an edge." };
}
