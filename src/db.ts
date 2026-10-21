// SQLite (WAL) via node:sqlite. Hard rule 10: every decision is written before it is acted on.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BeeId } from "./config.js";
import type { BeeState } from "./bees/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY, bee TEXT NOT NULL, ts INTEGER NOT NULL,
  state_hash TEXT, state_json TEXT, menu_json TEXT,
  choice TEXT, probabilities_json TEXT, confidence REAL, conviction REAL,
  latency_ms INTEGER, input_tokens INTEGER, jev_cost_usd REAL NOT NULL DEFAULT 0, jev_error TEXT,
  action_json TEXT NOT NULL, vetoed_by TEXT, forced_by TEXT, status TEXT
);
CREATE INDEX IF NOT EXISTS decisions_bee_ts ON decisions(bee, ts);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, decision_id INTEGER NOT NULL, bee TEXT NOT NULL, ts INTEGER NOT NULL,
  cl_ord_id TEXT NOT NULL UNIQUE, ord_id TEXT, inst_id TEXT NOT NULL, side TEXT NOT NULL,
  contracts REAL NOT NULL, reduce_only INTEGER NOT NULL, purpose TEXT NOT NULL,
  state TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, bee TEXT NOT NULL, ts INTEGER NOT NULL,
  inst_id TEXT NOT NULL, side TEXT NOT NULL, contracts REAL NOT NULL, px REAL NOT NULL,
  notional_usd REAL NOT NULL, fee_usd REAL NOT NULL, realised_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS funding (
  id INTEGER PRIMARY KEY, bee TEXT NOT NULL, ts INTEGER NOT NULL, inst_id TEXT,
  amount_usd REAL NOT NULL, bill_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS equity_snapshots (bee TEXT NOT NULL, ts INTEGER NOT NULL, equity_usd REAL, cash_usd REAL, upl_usd REAL);
CREATE INDEX IF NOT EXISTS equity_bee_ts ON equity_snapshots(bee, ts);
CREATE TABLE IF NOT EXISTS reconciliations (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bee TEXT NOT NULL, ok INTEGER NOT NULL, diff_json TEXT);
CREATE TABLE IF NOT EXISTS caps (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bee TEXT NOT NULL, cap TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS bee_state (bee TEXT PRIMARY KEY, json TEXT NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chooser_spend (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bee TEXT NOT NULL, reserved_usd REAL NOT NULL, charged_usd REAL NOT NULL, settled INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS chooser_spend_ts ON chooser_spend(ts);
`;

export interface DecisionRow {
  bee: BeeId;
  ts: number;
  stateHash: string | null;
  stateJson: string | null;
  menuJson: string | null;
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  conviction: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  jevCostUsd: number;
  jevError: string | null;
  action: unknown;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  auditJson?: string;
  decidedBy?: string | null;
  fallbackReason?: string | null;
}

export interface OrderRow {
  decisionId: number;
  bee: BeeId;
  ts: number;
  clOrdId: string;
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  reduceOnly: boolean;
  purpose: string;
}

export interface FillRow {
  orderId: number;
  bee: BeeId;
  ts: number;
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
  slippageUsd?: number;
}

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string, readOnly = false) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path, { readOnly });
    if (readOnly) {
      if (this.getMeta("product") !== "catfolio-1") {
        this.raw.close();
        throw new Error("Not a Catfolio database");
      }
      return;
    }
    const old = this.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='bee_state'",
      )
      .get();
    if (old) {
      const ids = this.raw
        .prepare(
          "SELECT bee FROM bee_state UNION SELECT bee FROM decisions UNION SELECT bee FROM fills",
        )
        .all() as Array<{ bee: string }>;
      const product = this.raw
        .prepare("SELECT v FROM meta WHERE k='product'")
        .get() as { v: string } | undefined;
      if (
        ids.some((r) => !["tiger", "mochi"].includes(r.bee)) ||
        product?.v !== "catfolio-1"
      ) {
        this.raw.close();
        throw new Error(
          "Incompatible historical database. Preserve this file and choose a new DB_PATH for Catfolio; no migration or deletion was performed.",
        );
      }
    }
    this.raw.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    );
    this.raw.exec(SCHEMA);
    if (!old) this.setMeta("product", "catfolio-1");
    const addColumn = (table: string, column: string, definition: string) => {
      const columns = this.raw
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column))
        this.raw.exec(
          `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
        );
    };
    addColumn("decisions", "audit_json", "TEXT");
    addColumn("decisions", "decided_by", "TEXT");
    addColumn("decisions", "fallback_reason", "TEXT");
    addColumn("fills", "slippage_usd", "REAL NOT NULL DEFAULT 0");
    this.raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS execution_once ON orders(decision_id, bee, purpose)",
    );
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.raw.exec("COMMIT");
      return value;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  insertDecision(d: DecisionRow): number {
    const r = this.raw
      .prepare(
        `INSERT INTO decisions (bee, ts, state_hash, state_json, menu_json, choice, probabilities_json, confidence, conviction,
          latency_ms, input_tokens, jev_cost_usd, jev_error, action_json, vetoed_by, forced_by, status, audit_json, decided_by, fallback_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.bee,
        d.ts,
        d.stateHash,
        d.stateJson,
        d.menuJson,
        d.choice,
        d.probabilities ? JSON.stringify(d.probabilities) : null,
        d.confidence,
        d.conviction,
        d.latencyMs,
        d.inputTokens,
        d.jevCostUsd,
        d.jevError,
        JSON.stringify(d.action),
        d.vetoedBy,
        d.forcedBy,
        d.status,
        d.auditJson ?? null,
        d.decidedBy ?? null,
        d.fallbackReason ?? null,
      );
    return Number(r.lastInsertRowid);
  }

  reserveChooserSpend(ts: number, bee: string, usd: number): number {
    return Number(this.raw.prepare("INSERT INTO chooser_spend (ts, bee, reserved_usd, charged_usd) VALUES (?,?,?,?)").run(ts, bee, usd, usd).lastInsertRowid);
  }
  settleChooserSpend(id: number, usd: number): void {
    this.raw.prepare("UPDATE chooser_spend SET charged_usd=?, settled=1 WHERE id=?").run(usd, id);
  }
  chooserSpendSince(ts: number): number {
    return (this.raw.prepare("SELECT COALESCE(SUM(charged_usd),0) AS spent FROM chooser_spend WHERE ts>=?").get(ts) as {spent:number}).spent;
  }

  insertOrder(o: OrderRow): number {
    const r = this.raw
      .prepare(
        `INSERT INTO orders (decision_id, bee, ts, cl_ord_id, inst_id, side, contracts, reduce_only, purpose, state)
         VALUES (?,?,?,?,?,?,?,?,?,'sent')`,
      )
      .run(
        o.decisionId,
        o.bee,
        o.ts,
        o.clOrdId,
        o.instId,
        o.side,
        o.contracts,
        o.reduceOnly ? 1 : 0,
        o.purpose,
      );
    return Number(r.lastInsertRowid);
  }

  updateOrder(
    id: number,
    state: string,
    ordId: string | null,
    error: string | null,
  ): void {
    this.raw
      .prepare(
        `UPDATE orders SET state = ?, ord_id = COALESCE(?, ord_id), error = ? WHERE id = ?`,
      )
      .run(state, ordId, error, id);
  }

  insertFill(f: FillRow): void {
    this.raw
      .prepare(
        `INSERT INTO fills (order_id, bee, ts, inst_id, side, contracts, px, notional_usd, fee_usd, realised_usd, slippage_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        f.orderId,
        f.bee,
        f.ts,
        f.instId,
        f.side,
        f.contracts,
        f.px,
        f.notionalUsd,
        f.feeUsd,
        f.realisedUsd,
        f.slippageUsd ?? 0,
      );
  }

  /** Returns false if this bill was already recorded. */
  insertFunding(
    bee: BeeId,
    ts: number,
    instId: string | null,
    amountUsd: number,
    billId: string,
  ): boolean {
    const r = this.raw
      .prepare(
        `INSERT OR IGNORE INTO funding (bee, ts, inst_id, amount_usd, bill_id) VALUES (?,?,?,?,?)`,
      )
      .run(bee, ts, instId, amountUsd, billId);
    return Number(r.changes) > 0;
  }

  insertEquity(
    bee: BeeId,
    ts: number,
    equity: number,
    cash: number,
    upl: number,
  ): void {
    this.raw
      .prepare(
        `INSERT INTO equity_snapshots (bee, ts, equity_usd, cash_usd, upl_usd) VALUES (?,?,?,?,?)`,
      )
      .run(bee, ts, equity, cash, upl);
  }

  /** Equity per bee, bucketed to at most ~`points` samples (last value in each bucket). */
  equitySeries(
    sinceTs: number,
    points: number,
  ): Record<string, Array<[number, number]>> {
    const span = Math.max(1, Date.now() - sinceTs);
    const bucket = Math.max(10_000, Math.ceil(span / points));
    const rows = this.raw
      .prepare(
        `SELECT bee, MAX(ts) AS ts, equity_usd AS eq FROM equity_snapshots WHERE ts >= ? GROUP BY bee, ts / ? ORDER BY ts`,
      )
      .all(sinceTs, bucket) as Array<{ bee: string; ts: number; eq: number }>;
    const out: Record<string, Array<[number, number]>> = {};
    for (const r of rows)
      (out[r.bee] ??= []).push([r.ts, Number(r.eq.toFixed(2))]);
    return out;
  }

  insertRecon(bee: BeeId, ts: number, ok: boolean, diff: unknown): void {
    this.raw
      .prepare(
        `INSERT INTO reconciliations (ts, bee, ok, diff_json) VALUES (?,?,?,?)`,
      )
      .run(ts, bee, ok ? 1 : 0, JSON.stringify(diff));
  }

  insertCap(bee: BeeId, ts: number, cap: string, detail: string): void {
    this.raw
      .prepare(`INSERT INTO caps (ts, bee, cap, detail) VALUES (?,?,?,?)`)
      .run(ts, bee, cap, detail);
  }

  saveBee(s: BeeState, ts: number): void {
    this.raw
      .prepare(
        `INSERT INTO bee_state (bee, json, updated_ts) VALUES (?,?,?) ON CONFLICT(bee) DO UPDATE SET json = excluded.json, updated_ts = excluded.updated_ts`,
      )
      .run(s.id, JSON.stringify(s), ts);
  }

  loadBee(bee: BeeId): BeeState | null {
    const row = this.raw
      .prepare(`SELECT json FROM bee_state WHERE bee = ?`)
      .get(bee) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as BeeState) : null;
  }

  insertEvent(ts: number, type: string, json: string): void {
    this.raw
      .prepare(`INSERT INTO events (ts, type, json) VALUES (?,?,?)`)
      .run(ts, type, json);
  }

  recentEvents(n: number, type?: "decision"): string[] {
    const rows = this.raw
      .prepare(
        `SELECT json FROM (SELECT id, json FROM events ${type ? "WHERE type = 'decision'" : ""} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
      )
      .all(n) as Array<{ json: string }>;
    return rows.map((r) => r.json);
  }

  pruneEvents(olderThanTs: number): void {
    this.raw.prepare(`DELETE FROM events WHERE ts < ?`).run(olderThanTs);
  }

  getMeta(k: string): string | null {
    const r = this.raw.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as
      | { v: string }
      | undefined;
    return r?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.raw
      .prepare(
        `INSERT INTO meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      )
      .run(k, v);
  }

  close(): void {
    this.raw.close();
  }
}
