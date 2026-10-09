import { decisionConfiguration } from "./providers.js";
import { catBrain } from "./cats.js";
import { positionNotional } from "./bees/common.js";
import type {
  Action,
  BeeBrain,
  BeeContext,
  BeeState,
  Side,
} from "./bees/types.js";
import { BEES, type BeeId, type Config } from "./config.js";
import {
  STRATEGY_VERSION,
  RUBRIC_VERSION,
  type DecisionProvider,
  type DecisionResult,
} from "./decision.js";
import type { Alerts } from "./alerts.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { Executor } from "./exec/executor.js";
import { contractsFor, roundToLot } from "./exec/sizing.js";
import {
  applyFill,
  applyFunding,
  freshBee,
  mark,
  rollDay,
  sizedRiskUsd,
} from "./ledger.js";
import { log } from "./log.js";
import type { MarketFeed } from "./market/data.js";
import { safeError } from "./redact.js";
import {
  applyRisk,
  freshTicker,
  type Proposal,
  type RiskResult,
} from "./risk.js";
import { buildSnapshot } from "./snapshot.js";

const RECON_MS = 5 * 60_000;
export const ORDER_REJECT_PAUSE_MS = 10 * 60_000;
export interface EngineDeps {
  cfg: Config;
  db: Db;
  feed: MarketFeed;
  provider: DecisionProvider;
  exec: Executor;
  bus: EventBus;
  alerts: Alerts;
  now?: () => number;
  closeRequested?: () => boolean;
}
export class Engine {
  readonly bees = {} as Record<BeeId, BeeState>;
  private last: Partial<
    Record<
      BeeId,
      {
        choice: string | null;
        status: string;
        vetoedBy: string | null;
        latencyMs: number | null;
        ts: number;
      }
    >
  > = {};
  private orderPauseUntil: Partial<Record<BeeId, number>> = {};
  private deciding = new Set<BeeId>();
  private executing = new Set<BeeId>();
  private pending = new Set<Promise<void>>();
  private now: () => number;
  private ticking = false;
  private stopped = false;
  private refreshing = false;
  private timers: NodeJS.Timeout[] = [];
  private lastReconAt = 0;
  private lastFundingSlot: number;
  private recon = {
    ok: null as boolean | null,
    detail: "not applicable in PAPER",
    ts: 0,
  };
  private liveStartedAt: number | null = null;
  startedAt: number;
  private experimentStartedAt = 0;
  private closedAt: number | null = null;
  private closeRetryAt: Partial<Record<BeeId, number>> = {};
  private closeAnnounced = false;
  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFundingSlot = fundingSlot(this.startedAt);
  }

  async start(): Promise<void> {
    const { cfg, db } = this.d;
    const signature = JSON.stringify({
      identities: BEES,
      total: cfg.totalStartEquityUsd,
      allocations: BEES.map((id) => cfg.cats[id].allocationPct),
      mode: cfg.mode,
    });
    if (db.getMeta("allocation") && db.getMeta("allocation") !== signature)
      throw new Error(
        "Persisted capital/mode is incompatible. Preserve history and select a new DB_PATH; no automatic transfers or top-ups.",
      );
    const resume = db.getMeta("allocation") !== null;
    for (const id of BEES)
      if (resume && !db.loadBee(id))
        throw new Error(
          "Incomplete persisted Catfolio accounts; refusing to create replacement funds",
        );
    db.transaction(() => {
      db.setMeta("product", "catfolio-1");
      db.setMeta("allocation", signature);
      db.setMeta("mode", cfg.mode);
      if (!db.getMeta("experiment_started_at"))
        db.setMeta("experiment_started_at", String(this.now()));
      for (const id of BEES) {
        this.bees[id] =
          db.loadBee(id) ??
          freshBee(id, cfg.cats[id].startEquityUsd, this.now());
        this.bees[id].metricsAt = this.now(); // offline time cannot be marked reliably
        db.saveBee(this.bees[id], this.now());
      }
      if (cfg.mode === "dry")
        db.raw
          .prepare(
            "UPDATE orders SET state='rejected', error='interrupted paper order; no committed fill' WHERE state IN ('sent','unknown')",
          )
          .run();
    });
    this.experimentStartedAt = Number(db.getMeta("experiment_started_at"));
    this.closedAt = db.getMeta("experiment_closed_at")
      ? Number(db.getMeta("experiment_closed_at"))
      : null;
    if (cfg.mode === "live") {
      this.liveStartedAt = Number(db.getMeta("live_started_at") ?? this.now());
      db.setMeta("live_started_at", String(this.liveStartedAt));
    }
    if (!db.getMeta("funding_since"))
      db.setMeta("funding_since", String(this.now()));
    for (const id of BEES) await this.d.exec.init(id);
    await this.refreshMarket();
    if (this.d.exec.kind === "okx") await this.reconcile();
    this.d.bus.emit("status", {
      event: "engine_start",
      product: "Catfolio",
      mode: cfg.mode,
      strategyVersion: STRATEGY_VERSION,
      provider: cfg.decisionProvider,
      model: decisionConfiguration(cfg).model,
    });
    await this.protectiveTick();
    this.loop(() => this.tick(), cfg.tickMs);
    this.loop(() => this.protectiveTick(), cfg.protectiveMs);
    this.loop(() => this.refreshMarket(), cfg.dataRefreshMs);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.d.provider.close?.();
    await Promise.allSettled([...this.pending]);
    for (const id of BEES)
      if (this.bees[id]) this.d.db.saveBee(this.bees[id], this.now());
  }
  private loop(fn: () => Promise<void>, everyMs: number) {
    const slot = this.timers.length;
    const run = async () => {
      const t0 = this.now();
      const task = fn();
      this.pending.add(task);
      try {
        await task;
      } catch (err) {
        log.error("loop error", { err: safeError(err) });
      } finally {
        this.pending.delete(task);
      }
      if (!this.stopped)
        this.timers[slot] = setTimeout(
          run,
          Math.max(1, everyMs - (this.now() - t0)),
        );
    };
    this.timers[slot] = setTimeout(run, everyMs);
  }
  async refreshMarket(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      await this.d.feed.refresh(this.now());
      if (this.d.exec.kind === "okx") await this.pollFunding();
    } catch (err) {
      log.warn("market refresh failed", { err: safeError(err) });
    } finally {
      this.refreshing = false;
    }
  }
  private ctx(id: BeeId, now = this.now()): BeeContext {
    const bee = this.bees[id],
      p = bee.position;
    return {
      bee,
      view: this.d.feed.view(),
      cfg: this.d.cfg,
      knobs: this.d.cfg.cats[id],
      now,
      uplR: p && p.riskUsd > 0 ? bee.uplUsd / p.riskUsd : null,
    };
  }
  private brains: Partial<Record<BeeId, BeeBrain>> = {};
  private brain(id: BeeId): BeeBrain {
    return (this.brains[id] ??= catBrain(id, this.d.cfg));
  }
  private sizeMult(now: number): number {
    return this.d.cfg.mode === "live" &&
      this.liveStartedAt !== null &&
      now - this.liveStartedAt < this.d.cfg.risk.liveRampHours * 3600000
      ? this.d.cfg.risk.liveSizeMultiplier
      : 1;
  }
  private markBee(id: BeeId, now: number) {
    const bee = this.bees[id],
      ctx = this.ctx(id, now),
      p = bee.position;
    if (p && freshTicker(ctx, p.instId)) {
      mark(
        bee,
        ctx.view.tickers.get(p.instId)?.mid,
        ctx.view.instruments.get(p.instId)?.ctVal,
      );
      const stop = this.brain(id).trail?.(ctx);
      if (
        stop !== undefined &&
        stop !== null &&
        Number.isFinite(stop) &&
        p.stopPx !== null
      )
        p.stopPx =
          p.side === "long"
            ? Math.max(p.stopPx, stop)
            : Math.min(p.stopPx, stop);
    } else if (!p) mark(bee, undefined, undefined);
    if (p && bee.metricsAt) bee.exposedMs += Math.max(0, now - bee.metricsAt);
    bee.metricsAt = now;
    bee.peakEquityUsd = Math.max(bee.peakEquityUsd, bee.equityUsd);
    bee.maxDrawdownPct = Math.max(
      bee.maxDrawdownPct,
      (100 * (bee.peakEquityUsd - bee.equityUsd)) / bee.peakEquityUsd,
    );
    rollDay(bee, now);
  }
  private risk(
    id: BeeId,
    proposal: Proposal | null,
    available: boolean,
  ): RiskResult {
    return applyRisk({
      ctx: this.ctx(id),
      brain: this.brain(id),
      proposal,
      modelStatus: available ? (proposal ? "ok" : "no_options") : "unreachable",
      sizeMult: this.sizeMult(this.now()),
      dataAgeMs: this.now() - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs,
    });
  }
  /** Never waits for model requests. New ticker quotes drive stops independently of indicator refreshes. */
  async protectiveTick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("ticker refresh failed", { err: safeError(err) });
      }
      if (this.stopped) return;
      const now = this.now();
      if (this.closedAt === null && this.d.closeRequested?.())
        this.beginClose(now);
      for (const id of BEES) this.markBee(id, now);
      if (this.d.exec.kind === "sim") this.simulateFunding(now);
      if (this.closedAt !== null) await this.windDown(now);
      else
        await Promise.all(
          BEES.map(async (id) => {
            const risk = this.risk(id, null, true);
            this.setCap(id, risk);
            if (
              risk.action.kind !== "none" ||
              risk.vetoedBy === "stale_exit_market_data"
            ) {
              const decisionId = this.record(
                id,
                null,
                this.auditInputs(id).state,
                {},
                risk,
                { ...this.auditInputs(id), source: "protective" },
              );
              await this.execute(id, risk.action, decisionId, this.ctx(id), 0);
            }
          }),
        );
      for (const id of BEES) {
        const b = this.bees[id];
        this.d.db.saveBee(b, now);
        this.d.db.insertEquity(id, now, b.equityUsd, b.cashUsd, b.uplUsd);
      }
      this.d.bus.emit(
        "equity",
        { bees: BEES.map((id) => this.publicBee(id)) },
        now,
      );
      if (this.d.exec.kind === "okx" && now - this.lastReconAt >= RECON_MS)
        await this.reconcile();
    } finally {
      this.ticking = false;
    }
  }
  async tick(): Promise<void> {
    if (!this.stopped && this.closedAt === null)
      await Promise.all(BEES.map((id) => this.decide(id)));
  }
  private async decide(id: BeeId) {
    if (this.deciding.has(id) || this.executing.has(id)) return;
    this.deciding.add(id);
    try {
      const now = this.now(),
        brain = this.brain(id),
        ctx = this.ctx(id, now),
        menu = brain.menu(ctx);
      const snap = buildSnapshot(brain, ctx);
      const before = this.positionVersion(id);
      const audit = this.auditInputs(id, now);
      let r: DecisionResult;
      try {
        r = await this.d.provider.decide({
          strategy: brain.strategy,
          state: snap.state,
          menu,
          convictionLabels: brain.convictionLabels,
        });
      } catch {
        r = {
          ok: false,
          reason: "provider_exception",
          latencyMs: this.now() - now,
        };
      }
      if (this.stopped) return;
      const stale =
        this.closedAt !== null ||
        this.d.closeRequested?.() ||
        this.now() - now > this.d.cfg.maxDecisionAgeMs ||
        before !== this.positionVersion(id);
      this.markBee(id, this.now());
      const selected =
        r.ok && Object.hasOwn(menu, r.choice) ? menu[r.choice] : undefined;
      const proposal: Proposal | null =
        r.ok && selected && !stale
          ? {
              label: r.choice,
              intent: selected.intent,
              prob: r.probabilities[r.choice]!,
              conviction: r.conviction,
            }
          : null;
      let risk = this.risk(id, proposal, r.ok && !!selected && !stale);
      if (stale && risk.action.kind === "none")
        risk = {
          ...risk,
          vetoedBy: "stale_model_response",
          status: "stale_model_response",
        };
      this.setCap(id, risk);
      const decisionId = this.record(id, r, snap.state, menu, risk, {
        ...audit,
        source: "model_request",
        response: r,
        executionCheck: this.auditInputs(id),
      });
      await this.execute(
        id,
        risk.action,
        decisionId,
        this.ctx(id),
        r.ok ? r.conviction : 0,
      );
      this.d.db.saveBee(this.bees[id], this.now());
    } finally {
      this.deciding.delete(id);
    }
  }
  /** Capture rules and market inputs for both model decisions and protective exits. */
  private auditInputs(id: BeeId, now = this.now()): Record<string, unknown> {
    const ctx = this.ctx(id, now),
      brain = this.brain(id);
    return JSON.parse(
      JSON.stringify({
        at: now,
        strategyVersion: STRATEGY_VERSION,
        rubricVersion: RUBRIC_VERSION,
        strategy: brain.strategy,
        rubric: brain.convictionLabels,
        state: buildSnapshot(brain, ctx).state,
        menu: brain.menu(ctx),
        account: ctx.bee,
        market: {
          ts: ctx.view.ts,
          instruments: [...ctx.view.instruments],
          tickers: [...ctx.view.tickers],
          stats: [...ctx.view.stats],
        },
        config: {
          ...decisionConfiguration(this.d.cfg),
          limits: this.d.cfg.cats[id],
          strategyParameters: this.d.cfg.strategies[id],
          risk: this.d.cfg.risk,
          timing: {
            decisionMs: this.d.cfg.tickMs,
            protectiveMs: this.d.cfg.protectiveMs,
            maxDecisionAgeMs: this.d.cfg.maxDecisionAgeMs,
            maxTickerAgeMs: this.d.cfg.maxTickerAgeMs,
            dataRefreshMs: this.d.cfg.dataRefreshMs,
          },
          feeRate: this.d.cfg.risk.takerFeeRate,
          slippageBps: this.d.cfg.paperSlippageBps,
        },
      }),
    ) as Record<string, unknown>;
  }
  private positionVersion(id: BeeId) {
    const b = this.bees[id];
    return JSON.stringify([
      b.totals.orders,
      b.position?.instId,
      b.position?.side,
      b.position?.contracts,
      b.position?.openedAt,
    ]);
  }
  private setCap(id: BeeId, risk: RiskResult) {
    this.bees[id].cap = risk.cap;
    if (risk.capTripped) {
      this.d.db.insertCap(id, this.now(), risk.capTripped, risk.status);
      this.d.bus.emit("cap", {
        bee: id,
        cap: risk.capTripped,
        detail: risk.status,
      });
    }
  }
  private record(
    id: BeeId,
    r: DecisionResult | null,
    state: unknown,
    menu: unknown,
    risk: RiskResult,
    audit: unknown,
  ): number {
    const now = this.now();
    const latencyMs =
      (r?.ok && r.source === "rules") ||
      (r &&
        !r.ok &&
        ["not_configured", "invalid_menu_or_rubric"].includes(r.reason))
        ? null
        : (r?.latencyMs ?? null);
    const decisionId = this.d.db.insertDecision({
      bee: id,
      ts: now,
      stateHash: null,
      stateJson: JSON.stringify(state),
      menuJson: JSON.stringify(menu),
      choice: r?.ok ? r.choice : null,
      probabilities: r?.ok ? r.probabilities : null,
      confidence: r?.ok ? r.confidence : null,
      conviction: r?.ok ? r.convictionRaw : null,
      latencyMs,
      inputTokens: r?.ok ? r.inputTokens : null,
      jevCostUsd: r?.costUsd ?? 0,
      jevError: r && !r.ok ? JSON.stringify(r) : null,
      action: risk.action,
      vetoedBy: risk.vetoedBy,
      forcedBy: risk.forcedBy,
      status: risk.status,
      auditJson: JSON.stringify(audit),
    });
    if (r) {
      this.bees[id].totals.decisions++;
      this.bees[id].totals.jevUsd += r.costUsd ?? 0;
    }
    this.last[id] = {
      choice: r?.ok
        ? r.choice
        : risk.action.kind !== "none"
          ? risk.action.kind.toUpperCase()
          : null,
      status: risk.status,
      vetoedBy: risk.vetoedBy,
      latencyMs,
      ts: now,
    };
    this.d.bus.emit(
      "decision",
      {
        bee: id,
        ...this.last[id],
        action: risk.action,
        forcedBy: risk.forcedBy,
        model: r?.ok ? r.model : null,
        provider: this.d.cfg.decisionProvider,
        error: r && !r.ok ? r.reason : null,
      },
      now,
    );
    return decisionId;
  }
  // ---------- closing the experiment ----------

  private beginClose(now: number) {
    this.closedAt = now;
    this.d.db.setMeta("experiment_closed_at", String(now));
    log.info(
      "experiment close requested: closing every position, no more model calls",
    );
    this.d.bus.emit("status", { event: "experiment_closing" }, now);
    this.d.alerts.send("experiment close requested: closing all positions");
  }

  /** Close whatever each bee holds (reduce-only market, through the normal ledger), then idle. */
  private async windDown(now: number): Promise<void> {
    await Promise.all(
      BEES.map(async (id) => {
        const bee = this.bees[id];
        const p = bee.position;
        if (
          !p ||
          this.executing.has(id) ||
          !freshTicker(this.ctx(id), p.instId) ||
          now < (this.closeRetryAt[id] ?? 0)
        )
          return;
        const risk: RiskResult = {
          action: { kind: "close", reason: "experiment_closed" },
          vetoedBy: null,
          forcedBy: "experiment_closed",
          cap: bee.cap,
          capTripped: null,
          status: "experiment closed: closing position",
        };
        const audit = this.auditInputs(id, now);
        const decisionId = this.record(
          id,
          null,
          audit.state,
          audit.menu,
          risk,
          { ...audit, source: "manual_paper_stop" },
        );
        await this.execute(
          id,
          { kind: "close", reason: "experiment_closed" },
          decisionId,
          this.ctx(id),
          0,
        );
        this.closeRetryAt[id] = now + 10_000;
        this.d.db.saveBee(this.bees[id], now);
      }),
    ).catch((err) => log.error("close failed", { err: safeError(err) }));
    if (!this.closeAnnounced && BEES.every((id) => !this.bees[id].position)) {
      this.closeAnnounced = true;
      this.d.db.setMeta("experiment_flat_at", String(now));
      this.lastReconAt = 0; // confirm flat against OKX on the next tick
      this.d.bus.emit("status", { event: "experiment_closed" }, now);
      this.d.alerts.send("experiment closed: both cats are flat");
    }
  }

  // ---------- execution ----------

  private async execute(
    id: BeeId,
    action: Action,
    decisionId: number,
    ctx: BeeContext,
    _conviction: number,
  ): Promise<void> {
    if (this.executing.has(id) || action.kind === "none") return;
    this.executing.add(id);
    try {
      const bee = this.bees[id];
      const p = bee.position;
      switch (action.kind) {
        case "close":
          if (p)
            await this.order(
              id,
              decisionId,
              p.instId,
              p.side === "long" ? "sell" : "buy",
              p.contracts,
              true,
              action.reason,
            );
          return;
        case "trim": {
          if (!p) return;
          const inst = ctx.view.instruments.get(p.instId);
          const n = inst ? roundToLot(p.contracts * action.fraction, inst) : 0;
          if (n > 0 && inst && n >= inst.minSz)
            await this.order(
              id,
              decisionId,
              p.instId,
              p.side === "long" ? "sell" : "buy",
              n,
              true,
              "trim",
            );
          else log.info("trim rounds to zero, skipped", { bee: id });
          return;
        }
        case "add":
        case "switch":
          return; // Catfolio never adds, averages down, or flips directly.
        case "open":
          await this.openPosition(
            id,
            decisionId,
            action.instId,
            action.side,
            action.notionalUsd,
          );
          return;
      }
    } finally {
      this.executing.delete(id);
    }
  }

  private async openPosition(
    id: BeeId,
    decisionId: number,
    instId: string,
    side: Side,
    notionalUsd: number,
  ): Promise<void> {
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!inst || !s) return;
    if (this.bees[id].position || !freshTicker(this.ctx(id), instId)) return;
    const t = view.tickers.get(instId)!;
    const slip = this.d.cfg.paperSlippageBps / 10000;
    const px = side === "long" ? t.ask * (1 + slip) : t.bid * (1 - slip);
    const contracts = contractsFor(notionalUsd, inst, px);
    if (contracts <= 0) {
      log.info("order rounds to zero contracts, skipped", {
        bee: id,
        coin: inst.coin,
        notionalUsd,
      });
      return;
    }
    const ok = await this.order(
      id,
      decisionId,
      instId,
      side === "long" ? "buy" : "sell",
      contracts,
      false,
      "open",
    );
    const bee = this.bees[id];
    if (!ok || !bee.position) return;
  }

  /** Record the order, send it, apply the fill. Returns true when it filled. */
  private async order(
    id: BeeId,
    decisionId: number,
    instId: string,
    side: "buy" | "sell",
    contracts: number,
    reduceOnly: boolean,
    purpose: string,
  ): Promise<boolean> {
    const { db, bus, exec } = this.d;
    const now = this.now();
    const inst = this.d.feed.view().instruments.get(instId);
    if (!inst || !freshTicker(this.ctx(id), instId)) return false;
    if (
      db.raw
        .prepare(
          "SELECT 1 FROM orders WHERE bee=? AND state IN ('sent','unknown') LIMIT 1",
        )
        .get(id)
    )
      return false;
    if (
      db.raw
        .prepare(
          "SELECT 1 FROM orders WHERE decision_id=? AND bee=? AND purpose=?",
        )
        .get(decisionId, id, purpose)
    )
      return false;
    // After the exchange rejects a new order, this bee opens nothing for ORDER_REJECT_PAUSE_MS (it used to resend
    // every tick). Closes (reduceOnly) are never paused: stops must always try.
    if (!reduceOnly && now < (this.orderPauseUntil[id] ?? 0)) {
      log.info("new orders paused after an exchange rejection", {
        bee: id,
        coin: inst.coin,
        purpose,
        untilS: Math.round(((this.orderPauseUntil[id] ?? 0) - now) / 1000),
      });
      return false;
    }
    const clOrdId = `cf${id.slice(0, 2)}${decisionId.toString(36)}${purpose.replace(/[^a-z0-9]/gi, "").slice(0, 10)}`;
    const orderId = db.insertOrder({
      decisionId,
      bee: id,
      ts: now,
      clOrdId,
      instId,
      side,
      contracts,
      reduceOnly,
      purpose,
    });
    bus.emit(
      "order",
      {
        bee: id,
        coin: inst.coin,
        side,
        contracts,
        purpose,
        clOrdId,
        state: "sent",
      },
      now,
    );
    const res = await exec.market(id, {
      instId,
      side,
      contracts,
      reduceOnly,
      clOrdId,
    });
    if (!res.ok) {
      db.updateOrder(
        orderId,
        res.state,
        null,
        `${res.error.code} ${res.error.message}`,
      );
      bus.emit("order", {
        bee: id,
        coin: inst.coin,
        side,
        contracts,
        purpose,
        state: res.state,
        error: res.error,
      });
      log.warn("order failed", {
        bee: id,
        coin: inst.coin,
        purpose,
        err: res.error,
      });
      if (res.state === "unknown") this.lastReconAt = 0; // reconcile on the next tick
      if (!reduceOnly) {
        this.orderPauseUntil[id] = now + ORDER_REJECT_PAUSE_MS;
        this.d.alerts.send(
          `${this.d.cfg.slots[id].name}: ${inst.coin} ${purpose} order rejected (${res.error.code} ${res.error.message}); new orders paused ${ORDER_REJECT_PAUSE_MS / 60_000} min`,
        );
      }
      return false;
    }
    this.markBee(id, this.now());
    const bee = structuredClone(this.bees[id]);
    let realised = 0;
    const notionalUsd = res.contracts * inst.ctVal * res.avgPx;
    db.transaction(() => {
      db.updateOrder(orderId, "filled", res.ordId, null);
      realised = applyFill(bee, {
        instId,
        coin: inst.coin,
        side,
        contracts: res.contracts,
        px: res.avgPx,
        feeUsd: res.feeUsd,
        ctVal: inst.ctVal,
        ts: res.ts,
      });
      if (!reduceOnly && bee.position) {
        bee.tradesToday++;
        bee.lastEntryAt = res.ts;
        const p = bee.position;
        p.stopPx = this.brain(id).stopFor(
          instId,
          p.side,
          p.entryPx,
          this.ctx(id),
        );
        p.initialStopPx = p.stopPx;
        p.entryScore = this.d.feed.view().stats.get(instId)?.trend?.score;
        p.trendTrimmed = false;
        p.riskUsd =
          p.stopPx === null
            ? 0
            : sizedRiskUsd(p.contracts, inst.ctVal, p.entryPx, p.stopPx);
      }
      if (reduceOnly && purpose === "trim" && bee.position) bee.position.trendTrimmed = true;
      bee.slippageUsd += res.slippageUsd ?? 0;
      db.insertFill({
        orderId,
        bee: id,
        ts: res.ts,
        instId,
        side,
        contracts: res.contracts,
        px: res.avgPx,
        notionalUsd,
        feeUsd: res.feeUsd,
        realisedUsd: realised,
        slippageUsd: res.slippageUsd ?? 0,
      });
      mark(bee, this.d.feed.view().tickers.get(instId)?.mid, inst.ctVal);
      bee.peakEquityUsd = Math.max(bee.peakEquityUsd, bee.equityUsd);
      bee.maxDrawdownPct = Math.max(
        bee.maxDrawdownPct,
        (100 * (bee.peakEquityUsd - bee.equityUsd)) / bee.peakEquityUsd,
      );
      db.saveBee(bee, now);
    });
    this.bees[id] = bee;
    const dir = reduceOnly ? "CLOSE" : side === "buy" ? "LONG" : "SHORT";
    bus.emit("fill", {
      bee: id,
      coin: inst.coin,
      side,
      purpose,
      contracts: res.contracts,
      px: res.avgPx,
      notionalUsd: Number(notionalUsd.toFixed(2)),
      feeUsd: Number(res.feeUsd.toFixed(4)),
      realisedUsd: Number(realised.toFixed(2)),
      label: `${this.d.cfg.slots[id].name} ${dir} ${inst.coin} $${notionalUsd.toFixed(0)}`,
    });
    return true;
  }

  // ---------- funding, reconciliation, ranks ----------

  /** MODE=dry: charge funding at 00/08/16 UTC using the current rate (long pays a positive rate). */
  private simulateFunding(now: number) {
    const slot = fundingSlot(now);
    if (slot === this.lastFundingSlot) return;
    this.lastFundingSlot = slot;
    const view = this.d.feed.view();
    for (const id of BEES) {
      const bee = structuredClone(this.bees[id]);
      const p = bee.position;
      const s = p ? view.stats.get(p.instId) : undefined;
      const inst = p ? view.instruments.get(p.instId) : undefined;
      if (!p || !s || !inst || s.fundingPct === null) continue;
      const amount =
        -(p.side === "long" ? 1 : -1) *
        (s.fundingPct / 100) *
        positionNotional(p, s.mid, inst.ctVal);
      let recorded = false;
      this.d.db.transaction(() => {
        if (
          this.d.db.insertFunding(
            id,
            now,
            p.instId,
            amount,
            `sim-${id}-${slot}`,
          )
        ) {
          applyFunding(bee, amount);
          mark(bee, s.mid, inst.ctVal);
          this.d.db.saveBee(bee, now);
          recorded = true;
        }
      });
      if (recorded) {
        this.bees[id] = bee;
        this.d.bus.emit(
          "funding",
          { bee: id, coin: p.coin, amountUsd: Number(amount.toFixed(4)) },
          now,
        );
      }
    }
  }

  /** MODE=demo/live: record funding bills (type 8) as their own ledger rows. */
  private async pollFunding() {
    const since = Number(this.d.db.getMeta("funding_since") ?? 0);
    for (const id of BEES) {
      const bills = await this.d.exec.fundingBills(id);
      for (const b of bills ?? []) {
        if (b.ts < since) continue;
        if (
          this.d.db.insertFunding(id, b.ts, b.instId, b.amountUsd, b.billId)
        ) {
          applyFunding(this.bees[id], b.amountUsd);
          this.d.bus.emit(
            "funding",
            {
              bee: id,
              coin: b.instId?.split("-")[0] ?? null,
              amountUsd: b.amountUsd,
            },
            b.ts,
          );
        }
      }
    }
  }

  /** Every 5 min (demo/live): our position and fees vs OKX. On mismatch, adopt OKX's position and go red. */
  async reconcile(): Promise<void> {
    const now = this.now();
    this.lastReconAt = now;
    const view = this.d.feed.view();
    const diffs: string[] = [];
    for (const id of BEES) {
      const bee = this.bees[id];
      const ex = await this.d.exec.positions(id);
      if (ex === null) {
        diffs.push(
          `${this.d.cfg.slots[id].name}: could not read OKX positions`,
        );
        continue;
      }
      const theirs = ex[0];
      const ours = bee.position;
      const oursSigned = ours
        ? (ours.side === "long" ? 1 : -1) * ours.contracts
        : 0;
      const theirSigned = theirs?.pos ?? 0;
      const sameInst = (ours?.instId ?? null) === (theirs?.instId ?? null);
      let ok =
        ex.length <= 1 && sameInst && Math.abs(oursSigned - theirSigned) < 1e-9;
      let detail = ok
        ? "match"
        : `ours ${ours ? `${ours.side} ${ours.contracts} ${ours.coin}` : "flat"} vs OKX ${theirs ? `${theirs.pos} ${theirs.instId.split("-")[0]}` : "flat"}`;

      // Fees to the cent on our recent filled orders.
      const rows = this.d.db.raw
        .prepare(
          `SELECT o.ord_id AS ordId, o.inst_id AS instId, f.fee_usd AS fee FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.bee = ? AND o.ord_id IS NOT NULL ORDER BY o.id DESC LIMIT 50`,
        )
        .all(id) as Array<{ ordId: string; instId: string; fee: number }>;
      if (rows.length) {
        const theirFees = await this.d.exec.feesFor(
          id,
          [...new Set(rows.map((r) => r.instId))],
          new Set(rows.map((r) => r.ordId)),
        );
        if (theirFees) {
          const ourSum = rows
            .filter((r) => theirFees.has(r.ordId))
            .reduce((a, r) => a + r.fee, 0);
          const theirSum = [...theirFees.values()].reduce((a, b) => a + b, 0);
          if (Math.abs(ourSum - theirSum) >= 0.005) {
            ok = false;
            detail += `; fees ours $${ourSum.toFixed(2)} vs OKX $${theirSum.toFixed(2)}`;
          }
        }
      }

      if (!sameInst || Math.abs(oursSigned - theirSigned) >= 1e-9) {
        // OKX is the truth: rebuild the position from it.
        if (!theirs) {
          bee.position = null;
          bee.flatSince ??= now;
        } else {
          const inst = view.instruments.get(theirs.instId);
          const side: Side = theirs.pos > 0 ? "long" : "short";
          const keepStop =
            ours && sameInst && ours.side === side ? ours.stopPx : null;
          bee.position = {
            instId: theirs.instId,
            coin: theirs.instId.split("-")[0]!,
            side,
            contracts: Math.abs(theirs.pos),
            entryPx: theirs.avgPx,
            openedAt: ours?.openedAt ?? now,
            stopPx:
              keepStop ??
              this.brain(id).stopFor(
                theirs.instId,
                side,
                theirs.avgPx,
                this.ctx(id, now),
              ),
            riskUsd:
              ours?.riskUsd ??
              (inst
                ? Math.abs(theirs.pos) * inst.ctVal * theirs.avgPx * 0.01
                : 0),
          };
          const np = bee.position;
          np.initialStopPx =
            keepStop !== null && ours
              ? (ours.initialStopPx ?? ours.stopPx)
              : np.stopPx;
          np.peakPx = keepStop !== null && ours ? (ours.peakPx ?? null) : null;
          if (
            inst &&
            np.initialStopPx !== null &&
            np.initialStopPx !== undefined
          )
            np.riskUsd = sizedRiskUsd(
              np.contracts,
              inst.ctVal,
              np.entryPx,
              np.initialStopPx,
            );
          bee.flatSince = null;
        }
      }
      this.d.db.insertRecon(id, now, ok, { detail });
      if (!ok) diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    const ok = diffs.length === 0;
    const was = this.recon.ok;
    this.recon = {
      ok,
      detail: ok ? "books match OKX" : diffs.join(" | "),
      ts: now,
    };
    this.d.bus.emit("recon", { ok, detail: this.recon.detail }, now);
    if (!ok && was !== false)
      this.d.alerts.send(`reconciliation mismatch: ${this.recon.detail}`);
  }

  private publicBee(id: BeeId) {
    const b = this.bees[id],
      p = b.position,
      ctx = this.ctx(id),
      start = this.d.cfg.cats[id].startEquityUsd;
    const inst = p ? ctx.view.instruments.get(p.instId) : undefined,
      mid = p ? ctx.view.tickers.get(p.instId)?.mid : undefined;
    return {
      bee: id,
      name: this.d.cfg.slots[id].name,
      allocatedUsd: start,
      equityUsd: b.equityUsd,
      cashUsd: b.cashUsd,
      uplUsd: b.uplUsd,
      pnlUsd: b.equityUsd - start,
      pnlPct: (b.equityUsd / start - 1) * 100,
      maxDrawdownPct: b.maxDrawdownPct,
      exposedMs: b.exposedMs,
      exposureUsd: p && mid && inst ? positionNotional(p, mid, inst.ctVal) : 0,
      position: p ? { ...p, markPx: mid ?? null } : null,
      tradesToday: b.tradesToday,
      maxTradesPerDay: this.d.cfg.cats[id].maxTradesPerDay,
      totals: b.totals,
      slippageUsd: b.slippageUsd,
      cap: b.cap,
      last: this.last[id] ?? null,
    };
  }
  snapshot() {
    return {
      ts: this.now(),
      mode: this.d.cfg.mode === "dry" ? "PAPER" : this.d.cfg.mode.toUpperCase(),
      startedAt: this.experimentStartedAt,
      closed:
        this.closedAt === null
          ? null
          : {
              at: this.closedAt,
              flat: BEES.every((id) => !this.bees[id].position),
            },
      totalStartEquityUsd: this.d.cfg.totalStartEquityUsd,
      decisionIntervalMs: this.d.cfg.tickMs,
      protectiveIntervalMs: this.d.cfg.protectiveMs,
      cats: BEES.map((id) => this.publicBee(id)),
      inference: this.d.provider.status(),
      market: { refreshedAt: this.d.feed.lastRefreshAt },
      recon: this.recon,
    };
  }
  health() {
    return {
      ok:
        this.d.feed.lastRefreshAt > 0 &&
        this.now() - this.d.feed.lastRefreshAt < 5 * this.d.cfg.dataRefreshMs,
      mode: this.d.cfg.mode,
      inference: this.d.provider.status(),
      uptimeS: Math.round((this.now() - this.startedAt) / 1000),
    };
  }
}
function fundingSlot(ms: number): number {
  return Math.floor(ms / (8 * 3600000)) * 8 * 3600000;
}
