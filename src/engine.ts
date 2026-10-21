import { createHash } from "node:crypto";
import { customBrain } from "./bees/custom.js";
import { brainsFor } from "./bees/index.js";
import { entriesUsed, maxNotionalUsd, minutesSince, positionNotional, profitLockStop } from "./bees/common.js";
import { profitStopCandidate, takeProfitContracts } from "./bees/profit-management.js";
import { coinOf, type Action, type BeeBrain, type BeeContext, type BeeState, type Position, type Side } from "./bees/types.js";
import { BEES, type BeeId, type Config } from "./config.js";
import { strategyVersion } from "./decision.js";
import { liveRules } from "./lab/brain.js";
import type { EngineOverlay as Overlay, EngineStore as Db, EngineJev as Jev, EngineAnswer as JevAnswer, EngineResult as JevResult } from "./engine-ports.js";
import type { Alerts } from "./alerts.js";
import type { EventBus } from "./events.js";
import type { Executor } from "./exec/executor.js";
import { contractsFor, roundToLot } from "./exec/sizing.js";
import { applyFill, applyFunding, dayKey, freshBee, fundingForRemainingPosition, mark, rollDay, sizedRiskUsd } from "./ledger.js";
import { log } from "./log.js";
import type { MarketFeed } from "./market/data.js";
import { safeError } from "./redact.js";
import { applyRisk, evaluateCaps, type JevStatus, type Proposal } from "./risk.js";
import { buildSnapshot } from "./snapshot.js";

const FUNDING_HOURS_UTC = [0, 8, 16];
const RECON_MS = 5 * 60_000;
/** How often a benched bee gets a live P&L row in the stream. */
const PULSE_MS = 4_000;
/** How long a bee opens nothing after the exchange rejects one of its new orders. */
export const ORDER_REJECT_PAUSE_MS = 10 * 60_000;
const EQUITY_SNAPSHOT_MS = 10_000;

export class EngineControlConflict extends Error {}

export interface EngineDeps {
  cfg: Config;
  db: Db;
  feed: MarketFeed;
  jev: Jev;
  exec: Executor;
  bus: EventBus;
  alerts: Alerts;
  now?: () => number;
  /** True once someone asked to end the experiment (deploy/close.sh drops a flag file in the data volume). */
  closeRequested?: () => boolean;
  /** Dry run only: consume a one-shot "resume last position" request (flag file). */
  takeResumeRequest?: () => boolean;
  /** The Beekeeper's rewrites (lab/store.ts). A bump of `version` rebuilds the brains on the next tick, no restart. */
  lab?: { readonly version: number; overlay(bee: BeeId): Overlay | null };
}

interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  /** The rules made the call (one legal move, a hold); Jev was not asked. */
  required?: boolean;
  decidedBy?: string | null;
  fallbackReason?: string | null;
}

/** Move a stop only in the position's favour. */
function ratchetStop(p: Position, cand: number): void {
  if (p.stopPx === null) p.stopPx = cand;
  else p.stopPx = p.side === "long" ? Math.max(p.stopPx, cand) : Math.min(p.stopPx, cand);
}

/** The answer when the menu leaves one legal hold: no Jev call, no cost. */
function requiredAnswer(label: string): JevAnswer {
  return { ok: true, choice: label, probabilities: { [label]: 1 }, confidence: 1, conviction: 0, convictionRaw: 0, inputTokens: 0, costUsd: 0, latencyMs: 0, model: "rules", decidedBy: "rules" };
}

export class Engine {
  readonly bees = {} as Record<BeeId, BeeState>;
  private last = {} as Partial<Record<BeeId, LastDecision>>;
  private orderPauseUntil = {} as Partial<Record<BeeId, number>>;
  private now: () => number;
  private ticking = false;
  private stopped = false;
  private refreshing = false;
  private executing = new Set<BeeId>();
  private beeLock: Partial<Record<BeeId, Promise<void>>> = {};
  private exitEpoch: Partial<Record<BeeId, number>> = {};
  private watchingExits = false;
  private timers: NodeJS.Timeout[] = [];
  private lastEquityAt = 0;
  private lastReconAt = 0;
  private lastFundingSlot: number;
  private seq = 0;
  private jevDownAlerted = false;
  private recon: { ok: boolean | null; detail: string; ts: number } = { ok: null, detail: "not run yet", ts: 0 };
  private liveStartedAt: number | null = null;
  private lastPulseAt: Partial<Record<BeeId, number>> = {};
  private lastChipUsd: Partial<Record<BeeId, number>> = {};
  startedAt: number;
  private experimentStartedAt = 0;
  /** Experiment closed: no Jev calls, no new positions; open positions are closed, then the engine only marks and reconciles. */
  private closedAt: number | null = null;
  private closeRetryAt: Partial<Record<BeeId, number>> = {};
  private closeAnnounced = false;

  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFundingSlot = fundingSlot(this.startedAt);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const { cfg, db } = this.d;
    const storedMode = db.getMeta("mode");
    if (storedMode && storedMode !== cfg.mode) {
      throw new Error(`This database was used for MODE=${storedMode}. Point DB_PATH at a separate file for MODE=${cfg.mode}.`);
    }
    db.setMeta("mode", cfg.mode);
    if (cfg.mode === "live") {
      const s = db.getMeta("live_started_at");
      this.liveStartedAt = s ? Number(s) : this.now();
      if (!s) db.setMeta("live_started_at", String(this.liveStartedAt));
    }
    if (!db.getMeta("funding_since")) db.setMeta("funding_since", String(this.now()));
    if (!db.getMeta("experiment_started_at")) db.setMeta("experiment_started_at", String(this.now()));
    this.experimentStartedAt = Number(db.getMeta("experiment_started_at"));
    const closed = db.getMeta("experiment_closed_at");
    if (closed) {
      this.closedAt = Number(closed);
      this.closeAnnounced = db.getMeta("experiment_flat_at") !== null;
    }

    for (const id of BEES) {
      this.bees[id] = db.loadBee(id) ?? freshBee(id, cfg.cats[id].startEquityUsd, this.now());
      await this.d.exec.init(id);
    }

    await this.refreshMarket();
    if (this.d.exec.kind === "okx") await this.reconcile();

    this.d.bus.emit("status", { event: "engine_start", mode: cfg.mode, tickMs: cfg.tickMs });
    this.d.alerts.send(`engine started (MODE=${cfg.mode})`);

    this.loop(() => this.tick(), cfg.tickMs);
    this.loop(() => this.exitWatch(), Math.min(cfg.tickMs, 2000));
    this.loop(() => this.refreshMarket(), cfg.dataRefreshMs);
    this.timers.push(setInterval(() => this.d.bus.emit("heartbeat", {}), 15_000));
    this.timers.push(setInterval(() => this.d.db.pruneEvents(this.now() - 3 * 86_400_000), 3_600_000));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const id of BEES) this.d.db.saveBee(this.bees[id], this.now());
  }

  /** Owner-only command: renew one exhausted entry allowance without rewriting trade history. */
  resetEntryLimit(id: BeeId) {
    if (this.stopped || this.closedAt !== null || this.d.closeRequested?.())
      throw new EngineControlConflict("This run is stopped or closing.");
    if (this.ticking) throw new EngineControlConflict("A trading tick is in progress. Retry in a moment.");
    const bee = this.bees[id], now = this.now(), max = this.d.cfg.cats[id].maxTradesPerDay;
    if (!bee || bee.dayKey !== dayKey(now)) throw new EngineControlConflict("Wait for the next trading tick to update the UTC day.");
    if (max <= 0) throw new EngineControlConflict("Entries are disabled by the configured limit.");
    if ((bee.cap !== null && bee.cap !== "trade_cap") || entriesUsed(bee) < max)
      throw new EngineControlConflict("Only an exhausted daily entry limit can be reset.");
    const updated = { ...bee, entryLimitBaseline: bee.tradesToday, cap: null };
    const otherCap = evaluateCaps({ ...this.ctx(id, now), bee: updated }).cap;
    if (otherCap) throw new EngineControlConflict(`Entry reset cannot clear ${otherCap}.`);
    const detail = `Owner reset entry allowance: ${entriesUsed(bee)} used -> 0/${max}; ${bee.tradesToday} actual entries today.`;
    const { db, bus } = this.d;
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      db.saveBee(updated, now);
      db.insertCap(id, now, "entry_limit_reset", detail);
      db.raw.exec("COMMIT");
    } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
    Object.assign(bee, updated);
    bus.emit("cap", { bee: id, cap: null, event: "entry_limit_reset", detail,
      tradesToday: bee.tradesToday, entriesUsed: 0, maxTradesPerDay: max }, now);
    return { cat: id, entriesUsed: 0, tradesToday: bee.tradesToday, maxTradesPerDay: max };
  }

  private loop(fn: () => Promise<void>, everyMs: number) {
    const slot = this.timers.length;
    const run = async () => {
      const t0 = this.now();
      try {
        await fn();
      } catch (err) {
        log.error("loop error", { err: safeError(err) });
      }
      if (!this.stopped) this.timers[slot] = setTimeout(run, Math.max(0, everyMs - (this.now() - t0)));
    };
    this.timers[slot] = setTimeout(run, everyMs);
  }

  async refreshMarket(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.d.feed.refresh(this.now());
      this.rankBoozyHourly();
      if (this.d.exec.kind === "okx") await this.pollFunding();
    } catch (err) {
      log.warn("market refresh failed", { err: safeError(err) });
    } finally {
      this.refreshing = false;
    }
  }

  // ---------- the tick ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("ticker refresh failed", { err: safeError(err) });
      }
      const now = this.now();
      for (const id of BEES) this.markBee(id, now);
      if (this.d.feed.lastRefreshAt === 0) return; // no market data yet
      if (this.d.exec.kind === "sim") this.simulateFunding(now);

      if (this.closedAt === null && this.d.closeRequested?.()) this.beginClose(now);
      if (this.closedAt === null && this.d.takeResumeRequest?.()) await this.resumeLast(now);
      if (this.closedAt !== null) await this.windDown(now);
      else await Promise.all(BEES.map((id) => this.decide(id, now).catch((err) => log.error("decision failed", { bee: id, err: safeError(err) }))));

      if (now - this.lastEquityAt >= EQUITY_SNAPSHOT_MS) {
        this.lastEquityAt = now;
        for (const id of BEES) {
          const b = this.bees[id];
          this.d.db.insertEquity(id, now, b.equityUsd, b.cashUsd, b.uplUsd);
        }
      }
      this.d.bus.emit("equity", { bees: BEES.map((id) => this.publicBee(id)) }, now);
      if (this.d.exec.kind === "okx" && now - this.lastReconAt >= RECON_MS) await this.reconcile();
      this.checkJevOutage(now);
    } finally {
      this.ticking = false;
    }
  }

  private ctx(id: BeeId, now: number): BeeContext {
    const bee = this.bees[id];
    const p = bee.position;
    return {
      bee,
      view: this.d.feed.view(),
      cfg: { ...this.d.cfg, risk: { ...this.d.cfg.risk, startEquityUsd: this.d.cfg.cats[id].startEquityUsd, dailyLossStopPct: this.d.cfg.cats[id].dailyLossStopPct } },
      knobs: this.knobs(id),
      now,
      uplR: p && p.riskUsd > 0 ? bee.uplUsd / p.riskUsd : null,
    };
  }

  private markBee(id: BeeId, now: number) {
    const bee = this.bees[id];
    const view = this.d.feed.view();
    const p = bee.position;
    const t = p ? view.tickers.get(p.instId) : undefined;
    const ctVal = p ? view.instruments.get(p.instId)?.ctVal : undefined;
    mark(bee, t?.mid, ctVal);
    // Positions opened before initialStopPx existed: their stop has never trailed past entry, so it is the entry stop.
    // Re-size R once from it (R used to stay at the first fill's risk after adds).
    if (p && p.initialStopPx === undefined && p.stopPx !== null && ctVal) {
      const lossSide = p.side === "long" ? p.stopPx < p.entryPx : p.stopPx > p.entryPx;
      p.initialStopPx = lossSide ? p.stopPx : null;
      if (lossSide) p.riskUsd = sizedRiskUsd(p.contracts, ctVal, p.entryPx, p.stopPx);
    }
    if (rollDay(bee, now)) {
      this.d.bus.emit("cap", { bee: id, cap: null, detail: "new UTC day: counters and caps reset" }, now);
    }
    // Trailing stop: only ever ratchets in the position's favour.
    const brain = this.brain(id);
    if (p && brain.trail) {
      const cand = brain.trail(this.ctx(id, now));
      if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
    }
    if (p && brain.profitProtection) {
      const protection = profitStopCandidate(this.ctx(id, now));
      if (protection) {
        p.exitPeakPx = protection.peakPx;
        p.exitPeakNetPerUnit = protection.peakNetPerUnit;
        if (protection.stopPx !== null) ratchetStop(p, protection.stopPx);
      }
    }
    // Profit lock: track the best price since entry; past a rung the stop keeps part of that move.
    if (p && brain.profitLock && t?.mid) {
      const better = p.peakPx == null || (p.side === "long" ? t.mid > p.peakPx : t.mid < p.peakPx);
      if (better) p.peakPx = t.mid;
      const cand = profitLockStop(p.side, p.entryPx, p.peakPx!, brain.profitLock);
      if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
    }
  }

  private async decide(id: BeeId, now: number): Promise<void> {
    const { cfg, db, bus, jev } = this.d;
    const brain = this.brain(id);
    const bee = this.bees[id];
    // Entry caps must not prevent reducing an existing position.
    if (!bee.position && (bee.cap === "trade_cap" || bee.cap === "fee_budget")) return this.decideBenched(id, now);
    const epoch = this.exitEpoch[id] ?? 0;
    if (cfg.strategyEngine === "upstream" && this.deterministicExit(id, now)) return this.decideBenched(id, now);
    const ctx = this.ctx(id, now);
    const revision = createHash("sha256").update(JSON.stringify({
        version: strategyVersion(cfg), style: brain.id, strategy: brain.strategy,
        parameters: cfg.strategies[id], limits: cfg.cats[id], exits: cfg.exits[id],
        rules: cfg.slots[id].rules, coins: cfg.slots[id].coins,
      })).digest("hex").slice(0, 16);
    const signalKey = brain.decisionKey?.(ctx) ?? null;
    const managementKey = brain.managementKey?.(ctx) ?? null;
    const freshSignal = signalKey !== null && bee.strategyDecisionKey !== `${revision}:${signalKey}`;
    const profitReview = managementKey !== null && !freshSignal;
    const profitChoicesConsumed = managementKey !== null && bee.profitDecisionKey === `${revision}:${managementKey}`;
    if (profitReview) {
      const key = `${revision}:${managementKey}`;
      if (bee.profitDecisionKey === key)
        return this.decideBenched(id, now, "waiting for the next profit review; protection remains active");
      bee.profitDecisionKey = key;
      // A profit close must not unlock another entry sample on the same signal bar.
      if (signalKey !== null) bee.strategyDecisionKey = `${revision}:${signalKey}`;
      db.saveBee(bee, now);
    } else if (brain.decisionKey) {
      if (signalKey === null) return this.decideBenched(id, now, "waiting for a valid completed signal bar; protection remains active");
      const key = `${revision}:${signalKey}`;
      if (bee.strategyDecisionKey === key)
        return this.decideBenched(id, now, "waiting for the next completed signal bar; protection remains active");
      // Consume before inference or execution. An outage, veto, fill or process restart must not
      // repeatedly sample the same signal until a different answer happens to allow a trade.
      bee.strategyDecisionKey = key;
      if (managementKey !== null && !profitChoicesConsumed) bee.profitDecisionKey = `${revision}:${managementKey}`;
      db.saveBee(bee, now);
    }
    const fullMenu = brain.menu(ctx);
    // Between signal bars the review can only hold or reduce exposure.
    const menu = profitReview ? Object.fromEntries(Object.entries(fullMenu).filter(([, option]) =>
      option.intent.kind === "hold" || option.intent.kind === "close" || option.intent.kind === "trim"))
      : profitChoicesConsumed ? Object.fromEntries(Object.entries(fullMenu).filter(([label]) => label !== "CLOSE_PROFIT" && label !== "TAKE_PROFIT")) : fullMenu;
    const snap = buildSnapshot(brain, ctx);
    if (brain.id === "boozy" && bee.top1.coin) snap.state.top1 = `${bee.top1.coin} x${bee.top1.streak}`;

    let jevStatus: JevStatus = "ok";
    let r: JevResult | null = null;
    const discard = () => {
      // A stop may invalidate an answer, but its paid usage and input still belong in the audit.
      const costUsd = r?.costUsd ?? 0;
      const decidedBy = r?.ok ? r.decidedBy ?? cfg.decisionProvider : null;
      const row = {bee:id,ts:this.now(),stateHash:snap.hash,stateJson:JSON.stringify(snap.state),menuJson:JSON.stringify(menu),
        auditJson:JSON.stringify({decisionKind:"discarded",requestStrategy:brain.strategy}),
        choice:r?.ok ? r.choice : null,probabilities:r?.ok && decidedBy !== "code" ? r.probabilities : null,
        confidence:r?.ok && decidedBy !== "code" ? r.confidence : null,conviction:r?.ok && decidedBy !== "code" ? r.convictionRaw : null,
        latencyMs:r?.latencyMs ?? null,inputTokens:r?.ok ? r.inputTokens : null,jevCostUsd:costUsd,
        jevError:r && !r.ok ? r.reason : null,decidedBy,fallbackReason:r?.ok ? r.fallbackReason ?? null : null,
        action:{kind:"none"},vetoedBy:"stale_model_response",forcedBy:null,status:"Answer discarded: position closed or engine stopping"};
      db.insertDecision(row); bee.totals.jevUsd += costUsd; bee.totals.decisions++; db.saveBee(bee,this.now());
      bus.emit("decision",{bee:id,choice:row.choice,probabilities:[],confidence:null,latencyMs:row.latencyMs,
        decidedBy,fallbackReason:row.fallbackReason,jev:"no_options",action:"hold",vetoedBy:row.vetoedBy,forcedBy:null,status:row.status,jevUsd:costUsd},this.now());
    };
    // One legal move and it is "keep what you hold" (a Momentum bee inside its 24h lock): asking Jev buys nothing, so
    // the rules make the call. Only for a hold: a lone open or close still goes to Jev.
    const labels = Object.keys(menu);
    const required = labels.length === 1 && menu[labels[0]!]!.intent.kind === "hold";
    const protective = applyRisk({ ctx, brain, proposal: null, jev: "unreachable", sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt, maxDataAgeMs: 3 * cfg.dataRefreshMs + 30_000 });
    // An already-triggered protective exit must not wait for a model response.
    if (protective.action.kind === "close") jevStatus = "no_options";
    else if (jev.capTripped) jevStatus = "daily_cap";
    else if (labels.length === 0) jevStatus = "no_options";
    else if (required) r = requiredAnswer(labels[0]!);
    else {
      r = await jev.decide({ strategy: brain.strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels, key: id });
      if (this.stopped || (this.exitEpoch[id] ?? 0) !== epoch) { discard(); return; }
      if (!r.ok) jevStatus = r.reason === "daily_cap" ? "daily_cap" : "unreachable";
    }
    const proposal: Proposal | null =
      r && r.ok && menu[r.choice] ? { label: r.choice, intent: menu[r.choice]!.intent, prob: r.probabilities[r.choice] ?? 0, conviction: r.conviction } : null;

    // Inference can outlive the quote that justified taking profit. Re-mark and give hard stops
    // priority on the latest available quote before accepting a discretionary reduction.
    let executionCtx = ctx;
    if (((brain.profitProtection && bee.position) || cfg.strategyEngine === "upstream") && r && !required) {
      try { await this.d.feed.refreshTickers(); }
      catch (err) { log.warn("exit quote refresh failed", { err: safeError(err) }); }
      const executionNow = this.now();
      this.markBee(id, executionNow);
      executionCtx = this.ctx(id, executionNow);
    }

    if (this.stopped || (this.exitEpoch[id] ?? 0) !== epoch) { discard(); return; }
    const risk = applyRisk({
      ctx: executionCtx,
      brain,
      proposal,
      jev: jevStatus,
      sizeMult: this.sizeMult(executionCtx.now),
      dataAgeMs: executionCtx.now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * cfg.dataRefreshMs + 30_000,
    });

    if (risk.capTripped) {
      const detail = risk.status;
      db.insertCap(id, now, risk.capTripped, detail);
      bus.emit("cap", { bee: id, cap: risk.capTripped, detail }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    bee.cap = risk.cap;
    // A rules-only hold that the risk layer left alone (a stop or cap still overrides it and shows as usual).
    const ruled = required && risk.action.kind === "none" && !risk.forcedBy;
    const status = ruled ? `${labels[0]}: required by rules, ${cfg.decisionProvider === "gemini" ? "Argon" : cfg.decisionProvider === "jev" ? "Jev" : "local model"} not asked` : risk.status;

    // Hard rule 10: recorded before it is acted on.
    const costUsd = r?.costUsd ?? 0;
    const decidedBy = r && r.ok ? r.decidedBy ?? (required ? "rules" : cfg.decisionProvider) : null;
    const fallbackReason = r && r.ok ? r.fallbackReason ?? null : null;
    const decisionId = db.insertDecision({
      bee: id,
      ts: now,
      stateHash: snap.hash,
      stateJson: JSON.stringify(snap.state),
      menuJson: JSON.stringify(menu),
      auditJson: JSON.stringify({ decisionKind: profitReview ? "profit_review" : "signal", requestStrategy: brain.strategy }),
      choice: r && r.ok ? r.choice : null,
      probabilities: r && r.ok && decidedBy !== "code" ? r.probabilities : null,
      confidence: r && r.ok && decidedBy !== "code" ? r.confidence : null,
      conviction: r && r.ok && decidedBy !== "code" ? r.convictionRaw : null,
      latencyMs: r ? r.latencyMs : null,
      inputTokens: r && r.ok ? r.inputTokens : null,
      jevCostUsd: costUsd,
      decidedBy, fallbackReason,
      jevError: r && !r.ok ? `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}` : null,
      action: risk.action,
      vetoedBy: risk.vetoedBy,
      forcedBy: risk.forcedBy,
      status,
    });
    bee.totals.jevUsd += costUsd;
    bee.totals.decisions++;

    const top3 = r && r.ok && decidedBy !== "code" ? (Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) as Array<[string, number]>) : [];
    this.last[id] = { choice: r && r.ok ? r.choice : null, top3: ruled ? [] : top3, confidence: r && r.ok && !ruled && decidedBy !== "code" ? r.confidence : null, latencyMs: ruled ? null : r ? r.latencyMs : null, status, ts: now, decidedBy, fallbackReason, ...(ruled ? { required: true } : {}) };
    // Flat and nothing to ask Jev (bizzy waiting for her breakout): a live "watching" row every PULSE_MS instead of a
    // "no call" row every tick, so the stream shows how close the trigger is.
    const watching = jevStatus === "no_options" && !bee.position && !!brain.idleStatus && risk.action.kind === "none";
    // Same for a rules-only hold: a row every PULSE_MS, not every tick.
    if ((watching || ruled) && now - (this.lastPulseAt[id] ?? 0) < PULSE_MS) {
      db.saveBee(bee, now);
      return;
    }
    if (watching || ruled) this.lastPulseAt[id] = now;
    bus.emit(
      "decision",
      {
        bee: id,
        choice: r && r.ok ? r.choice : watching ? "WATCHING" : null,
        ...(watching ? { watch: risk.status } : {}),
        probabilities: ruled ? [] : top3.map(([label, p]) => ({ label, p: Number(p.toFixed(3)) })),
        ...(ruled ? { required: true } : {}),
        confidence: r && r.ok && !ruled && decidedBy !== "code" ? Number(r.confidence.toFixed(3)) : null,
        conviction: r && r.ok && !ruled ? brain.convictionLabels[r.conviction] : null,
        latencyMs: ruled ? null : r ? r.latencyMs : null,
        tokens: r && r.ok && !ruled ? r.inputTokens : null,
        decidedBy, fallbackReason,
        jevUsd: Number(costUsd.toFixed(6)),
        action: describeAction(risk.action),
        vetoedBy: risk.vetoedBy,
        forcedBy: risk.forcedBy,
        status,
        jev: jevStatus,
        ...this.liveChip(id),
      },
      now,
    );

    if (risk.action.kind !== "none") await this.execute(id, risk.action, decisionId, executionCtx, proposal?.conviction ?? 0, epoch);
    db.saveBee(bee, now);
  }

  // ---------- protection while benched or waiting for a new signal bar ----------

  private async decideBenched(id: BeeId, now: number, waitingStatus?: string): Promise<void> {
    const { db } = this.d;
    const epoch = this.exitEpoch[id] ?? 0;
    const bee = this.bees[id];
    const ctx = this.ctx(id, now);
    const brain = this.brain(id);
    const risk = applyRisk({
      ctx,
      // This path may reduce risk but must never force an entry or rebalance while waiting.
      brain: waitingStatus ? { ...brain, neverForce: true, rebalance: undefined } : brain,
      proposal: null,
      jev: "no_options",
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
    });
    if (risk.capTripped) {
      db.insertCap(id, now, risk.capTripped, risk.status);
      this.d.bus.emit("cap", { bee: id, cap: risk.capTripped, detail: risk.status }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${risk.status}`);
    }
    bee.cap = risk.cap;
    const prev = this.last[id];
    const status = waitingStatus && !risk.cap && !risk.forcedBy ? waitingStatus : risk.status;
    this.last[id] = { choice: null, top3: waitingStatus ? [] : prev?.top3 ?? [], confidence: null, latencyMs: null, status, ts: now };
    if (risk.action.kind !== "none") {
      const decisionId = db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: risk.action, vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status,
      });
      this.d.bus.emit("decision", {
        bee: id, choice: null, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null,
        jevUsd: 0, action: describeAction(risk.action), vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status, jev: "no_options",
        ...this.liveChip(id),
      }, now);
      await this.execute(id, risk.action, decisionId, ctx, 0, epoch);
    } else if (now - (this.lastPulseAt[id] ?? 0) >= PULSE_MS) {
      // Keep benched bees in the stream: a live row with the position's P&L ticking, no Jev call behind it.
      this.lastPulseAt[id] = now;
      const p = bee.position;
      this.d.bus.emit("decision", {
        bee: id, choice: waitingStatus ? (p ? `HOLDING ${p.coin}` : "WAITING") : p ? `RIDING ${p.coin}` : "BENCHED", probabilities: [], confidence: null, conviction: null, latencyMs: null,
        tokens: null, jevUsd: 0, action: "hold", vetoedBy: null, forcedBy: null, status, jev: waitingStatus ? "no_options" : "benched", pulse: true,
        ...this.liveChip(id),
      }, now);
    }
    db.saveBee(bee, now);
  }

  /** The bee's money right now, for the stream: open P&L (or total P&L when flat) and how it moved since its last row. */
  private liveChip(id: BeeId) {
    const b = this.bees[id];
    const p = b.position;
    const value = p ? b.uplUsd : b.equityUsd - this.d.cfg.cats[id].startEquityUsd;
    const prev = this.lastChipUsd[id];
    this.lastChipUsd[id] = value;
    return {
      live: {
        coin: p?.coin ?? null,
        side: p?.side ?? null,
        valueUsd: Number(value.toFixed(2)),
        kind: p ? "open" : "total",
        deltaUsd: prev === undefined ? 0 : Number((value - prev).toFixed(2)),
      },
    };
  }

  /**
   * DRY RUN ONLY, one-shot (flag file `resume-last-dry` in the data volume): a benched bee that is sitting flat
   * re-opens the last position it held (same coin, side and size, at today's price) and rides it. Not a trade
   * toward its cap. Refused outright in demo/live.
   */
  private async resumeLast(now: number): Promise<void> {
    if (this.d.cfg.mode !== "dry") return;
    for (const id of BEES) {
      const bee = this.bees[id];
      if (bee.position || (bee.cap !== "trade_cap" && bee.cap !== "fee_budget")) continue;
      const last = this.d.db.raw
        .prepare(`SELECT inst_id AS instId, side, contracts FROM orders WHERE bee = ? AND reduce_only = 0 AND state = 'filled' ORDER BY id DESC LIMIT 1`)
        .get(id) as { instId: string; side: "buy" | "sell"; contracts: number } | undefined;
      if (!last) continue;
      const decisionId = this.d.db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: { kind: "open", instId: last.instId, side: last.side === "buy" ? "long" : "short" }, vetoedBy: null, forcedBy: "resume_last",
        status: "benched: back into its last position to ride it",
      });
      const ok = await this.order(id, decisionId, last.instId, last.side, last.contracts, false, "resume_last");
      const p = (this.bees[id] as BeeState).position; // re-read: order() just filled it
      if (!ok || !p) continue;
      const ctx = this.ctx(id, this.now());
      const inst = ctx.view.instruments.get(last.instId);
      p.stopPx = this.brain(id).stopFor(last.instId, p.side, p.entryPx, ctx);
      p.initialStopPx = p.stopPx;
      const notional = inst ? positionNotional(p, p.entryPx, inst.ctVal) : 0;
      p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
      this.d.db.saveBee(bee, now);
      log.info("resumed last position", { bee: id, coin: p.coin, side: p.side });
    }
  }

  // ---------- closing the experiment ----------

  private beginClose(now: number) {
    this.closedAt = now;
    for (const id of BEES) this.exitEpoch[id] = (this.exitEpoch[id] ?? 0) + 1;
    this.d.db.setMeta("experiment_closed_at", String(now));
    log.info("experiment close requested: closing every position, no more Jev calls");
    this.d.bus.emit("status", { event: "experiment_closing" }, now);
    this.d.alerts.send("experiment close requested: closing all positions");
  }

  /** Close whatever each bee holds (reduce-only market, through the normal ledger), then idle. */
  private async windDown(now: number): Promise<void> {
    await Promise.all(
      BEES.map(async (id) => {
        const bee = this.bees[id];
        const p = bee.position;
        if (!p || now < (this.closeRetryAt[id] ?? 0)) return;
        const decisionId = this.d.db.insertDecision({
          bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
          conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
          action: { kind: "close", reason: "experiment_closed" }, vetoedBy: null, forcedBy: "experiment_closed", status: "experiment closed: closing position",
        });
        await this.execute(id, {kind:"close",reason:"experiment_close"}, decisionId, this.ctx(id,now), 0);
        const ok = !bee.position;
        if (!ok) this.closeRetryAt[id] = now + 10_000;
        this.d.db.saveBee(bee, now);
      }),
    ).catch((err) => log.error("close failed", { err: safeError(err) }));
    if (!this.closeAnnounced && BEES.every((id) => !this.bees[id].position)) {
      this.closeAnnounced = true;
      this.d.db.setMeta("experiment_flat_at", String(now));
      this.lastReconAt = 0; // confirm flat against OKX on the next tick
      this.d.bus.emit("status", { event: "experiment_closed" }, now);
      this.d.alerts.send("experiment closed: every bee is flat");
    }
  }

  // ---------- execution ----------

  /** True when code alone closes this bee's position this tick (stop, time stop, loss stop, retire). Pure. */
  private deterministicExit(id: BeeId, now: number): boolean {
    if (!this.bees[id].position) return false;
    const pre = applyRisk({
      ctx: this.ctx(id, now),
      brain: this.brain(id),
      proposal: null,
      jev: "no_options",
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
    });
    return pre.action.kind === "close" && pre.forcedBy !== null;
  }

  /**
   * The deterministic exit pass, on its own timer and independent of the tick: a tick blocked on ANY bee's chooser call
   * (the tick waits for all three) never delays ANY bee's stop. Every bee with an open position is covered (choosing,
   * benched, rules-only hold, or already decided this tick): re-read tickers, re-mark (trail, profit lock), and fire a
   * stop, time stop, daily loss stop or retire at once. A bee whose order lock is held is skipped this round; the
   * holder is already acting on it. Firing bumps the bee's epoch, so its in-flight chooser answer and any queued
   * execution from before are dropped.
   */
  async exitWatch(): Promise<void> {
    if (this.stopped || this.watchingExits || this.closedAt !== null || this.d.feed.lastRefreshAt === 0) return;
    if (!BEES.some((id) => this.bees[id]?.position)) return;
    this.watchingExits = true;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("ticker refresh failed (exit watch)", { err: safeError(err) });
      }
      if (this.stopped || this.closedAt !== null) return;
      const now = this.now();
      for (const id of BEES) {
        if (!this.bees[id]?.position || this.executing.has(id)) continue;
        this.markBee(id, now);
        if (!this.deterministicExit(id, now)) continue;
        const ctx = this.ctx(id, now), brain = this.brain(id), cfg = this.d.cfg;
        const key = brain.decisionKey?.(ctx);
        if (key) {
          const revision = createHash("sha256").update(JSON.stringify({
            version: strategyVersion(cfg), style: brain.id, strategy: brain.strategy,
            parameters: cfg.strategies[id], limits: cfg.cats[id], exits: cfg.exits[id],
            rules: cfg.slots[id].rules, coins: cfg.slots[id].coins,
          })).digest("hex").slice(0,16);
          this.bees[id].strategyDecisionKey = `${revision}:${key}`;
        }
        this.exitEpoch[id] = (this.exitEpoch[id] ?? 0) + 1;
        await this.decideBenched(id, now);
      }
    } finally {
      this.watchingExits = false;
    }
  }

  /**
   * Execute under the bee's order lock. `epoch` is the bee's exit epoch when the decision was taken: if the exit watch
   * has fired since, the decision was for a position that is gone, so it is dropped (the decision row stays recorded).
   */
  private async execute(id: BeeId, action: Action, decisionId: number, ctx: BeeContext, conviction: number, epoch?: number): Promise<void> {
    const prev = this.beeLock[id] ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prev.then(() => mine);
    this.beeLock[id] = chain;
    await prev;
    this.executing.add(id);
    try {
      if (this.stopped) return;
      if (epoch !== undefined && (this.exitEpoch[id] ?? 0) !== epoch) {
        log.info("stale decision dropped: an exit fired since it was taken", { bee: id, decisionId, action: action.kind });
        return;
      }
      await this.executeAction(id, action, decisionId, ctx, conviction);
    } finally {
      this.executing.delete(id);
      release();
      if (this.beeLock[id] === chain) delete this.beeLock[id];
    }
  }

  private async executeAction(id: BeeId, action: Action, decisionId: number, ctx: BeeContext, _conviction: number): Promise<void> {
    const bee = this.bees[id];
    const p = bee.position;
    switch (action.kind) {
      case "close":
        if (p) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, action.reason);
        return;
      case "trim": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const n = action.reason === "profit_take" ? takeProfitContracts(this.ctx(id, this.now()))
          : inst ? roundToLot(p.contracts * action.fraction, inst) : 0;
        if (n > 0 && inst && n >= inst.minSz) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", n, true, action.reason ?? "trim");
        else log.info("trim rounds to zero, skipped", { bee: id });
        return;
      }
      case "add": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const s = ctx.view.stats.get(p.instId);
        const n = inst && s ? contractsFor(action.notionalUsd, inst, s.mid) : 0;
        if (n > 0) {
          const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "buy" : "sell", n, false, "add");
          const q = this.bees[id].position;
          // An add raises the average entry; don't let it turn the position into a loser: stop to at least the new average.
          if (ok && q && this.brain(id).protectAdds) ratchetStop(q, q.entryPx);
        } else log.info("add rounds to zero contracts, skipped", { bee: id });
        return;
      }
      case "switch":
        if (p) {
          const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "switch_close");
          if (!ok || this.bees[id].position) return; // A partial close is not a completed switch.
        }
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
      case "open":
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
    }
  }

  private async openPosition(id: BeeId, decisionId: number, instId: string, side: Side, notionalUsd: number): Promise<void> {
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!inst || !s) return;
    const contracts = contractsFor(notionalUsd, inst, s.mid);
    if (contracts <= 0) {
      log.info("order rounds to zero contracts, skipped", { bee: id, coin: inst.coin, notionalUsd });
      return;
    }
    const ok = await this.order(id, decisionId, instId, side === "long" ? "buy" : "sell", contracts, false, "open");
    const bee = this.bees[id];
    if (!ok || !bee.position) return;
    bee.tradesToday++;
    const ctx = this.ctx(id, this.now());
    const p = bee.position;
    p.stopPx = this.brain(id).stopFor(instId, side, p.entryPx, ctx);
    p.initialStopPx = p.stopPx;
    const notional = positionNotional(p, p.entryPx, inst.ctVal);
    p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
    if (s.trend) p.entryScore = s.trend.score;
  }

  /** Record the order, send it, apply the fill. Returns true when it filled. */
  private async order(id: BeeId, decisionId: number, instId: string, side: "buy" | "sell", contracts: number, reduceOnly: boolean, purpose: string): Promise<boolean> {
    const { db, bus, exec } = this.d;
    const now = this.now();
    const inst = this.d.feed.view().instruments.get(instId);
    if (!inst) return false;
    // After the exchange rejects a new order, this bee opens nothing for ORDER_REJECT_PAUSE_MS (it used to resend
    // every tick). Closes (reduceOnly) are never paused: stops must always try.
    if (!reduceOnly && now < (this.orderPauseUntil[id] ?? 0)) {
      log.info("new orders paused after an exchange rejection", { bee: id, coin: inst.coin, purpose, untilS: Math.round(((this.orderPauseUntil[id] ?? 0) - now) / 1000) });
      return false;
    }
    const clOrdId = `${id.slice(0, 2)}${now.toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
    const orderId = db.insertOrder({ decisionId, bee: id, ts: now, clOrdId, instId, side, contracts, reduceOnly, purpose });
    bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, clOrdId, state: "sent" }, now);
    const res = await exec.market(id, { instId, side, contracts, reduceOnly, clOrdId });
    if (!res.ok) {
      db.updateOrder(orderId, res.state, null, `${res.error.code} ${res.error.message}`);
      bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, state: res.state, error: res.error });
      log.warn("order failed", { bee: id, coin: inst.coin, purpose, err: res.error });
      if (res.state === "unknown") this.lastReconAt = 0; // reconcile on the next tick
      if (!reduceOnly) {
        this.orderPauseUntil[id] = now + ORDER_REJECT_PAUSE_MS;
        this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${inst.coin} ${purpose} order rejected (${res.error.code} ${res.error.message}); new orders paused ${ORDER_REJECT_PAUSE_MS / 60_000} min`);
      }
      return false;
    }
    db.updateOrder(orderId, "filled", res.ordId, null);
    const bee = this.bees[id];
    const realised = applyFill(bee, { instId, coin: inst.coin, side, contracts: res.contracts, px: res.avgPx, feeUsd: res.feeUsd, ctVal: inst.ctVal, ts: res.ts });
    if (purpose === "trim" && res.contracts > 0 && bee.position) {
      bee.position.trendTrimmed = true;
      if (this.d.cfg.strategyEngine === "upstream") bee.position.entryScore = this.d.feed.view().stats.get(instId)?.trend?.score ?? bee.position.entryScore;
    }
    if (purpose === "profit_take" && res.contracts > 0 && bee.position) bee.position.profitTaken = true;
    const notionalUsd = res.contracts * inst.ctVal * res.avgPx;
    db.insertFill({ orderId, bee: id, ts: res.ts, instId, side, contracts: res.contracts, px: res.avgPx, notionalUsd, feeUsd: res.feeUsd, realisedUsd: realised, slippageUsd: res.slippageUsd ?? 0 });
    bee.slippageUsd += res.slippageUsd ?? 0;
    mark(bee, res.avgPx, inst.ctVal);
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
      const bee = this.bees[id];
      const p = bee.position;
      const s = p ? view.stats.get(p.instId) : undefined;
      const inst = p ? view.instruments.get(p.instId) : undefined;
      if (!p || !s || !inst || s.fundingPct === null) continue;
      const amount = -(p.side === "long" ? 1 : -1) * (s.fundingPct / 100) * positionNotional(p, s.mid, inst.ctVal);
      if (this.d.db.insertFunding(id, now, p.instId, amount, `sim-${id}-${slot}`)) {
        applyFunding(bee, amount);
        this.d.bus.emit("funding", { bee: id, coin: p.coin, amountUsd: Number(amount.toFixed(4)) }, now);
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
        if (this.d.db.insertFunding(id, b.ts, b.instId, b.amountUsd, b.billId)) {
          const p = this.bees[id].position;
          let positionAmount = 0;
          if (p && b.instId === p.instId && b.ts >= p.openedAt) {
            const laterFills = this.d.db.raw.prepare(`SELECT side, contracts FROM fills
              WHERE bee=? AND inst_id=? AND ts>? ORDER BY ts,id`).all(id, p.instId, b.ts) as Array<{side:"buy"|"sell";contracts:number}>;
            positionAmount = fundingForRemainingPosition(b.amountUsd, p.contracts, p.side, laterFills);
          }
          applyFunding(this.bees[id], b.amountUsd, positionAmount);
          this.d.bus.emit("funding", { bee: id, coin: b.instId?.split("-")[0] ?? null, amountUsd: b.amountUsd }, b.ts);
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
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX positions`);
        continue;
      }
      const theirs = ex[0];
      const ours = bee.position;
      const oursSigned = ours ? (ours.side === "long" ? 1 : -1) * ours.contracts : 0;
      const theirSigned = theirs?.pos ?? 0;
      const sameInst = (ours?.instId ?? null) === (theirs?.instId ?? null);
      let ok = ex.length <= 1 && sameInst && Math.abs(oursSigned - theirSigned) < 1e-9;
      let detail = ok ? "match" : `ours ${ours ? `${ours.side} ${ours.contracts} ${ours.coin}` : "flat"} vs OKX ${theirs ? `${theirs.pos} ${theirs.instId.split("-")[0]}` : "flat"}`;

      // Fees to the cent on our recent filled orders.
      const rows = this.d.db.raw
        .prepare(`SELECT o.ord_id AS ordId, o.inst_id AS instId, f.fee_usd AS fee FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.bee = ? AND o.ord_id IS NOT NULL ORDER BY o.id DESC LIMIT 50`)
        .all(id) as Array<{ ordId: string; instId: string; fee: number }>;
      if (rows.length) {
        const theirFees = await this.d.exec.feesFor(id, [...new Set(rows.map((r) => r.instId))], new Set(rows.map((r) => r.ordId)));
        if (theirFees) {
          const ourSum = rows.filter((r) => theirFees.has(r.ordId)).reduce((a, r) => a + r.fee, 0);
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
          const keepStop = ours && sameInst && ours.side === side ? ours.stopPx : null;
          bee.position = {
            instId: theirs.instId,
            coin: theirs.instId.split("-")[0]!,
            side,
            contracts: Math.abs(theirs.pos),
            entryPx: theirs.avgPx,
            openedAt: ours?.openedAt ?? now,
            stopPx: keepStop ?? this.brain(id).stopFor(theirs.instId, side, theirs.avgPx, this.ctx(id, now)),
            riskUsd: ours?.riskUsd ?? (inst ? Math.abs(theirs.pos) * inst.ctVal * theirs.avgPx * 0.01 : 0),
          };
          const np = bee.position;
          np.initialStopPx = keepStop !== null && ours ? (ours.initialStopPx ?? ours.stopPx) : np.stopPx;
          np.peakPx = keepStop !== null && ours ? (ours.peakPx ?? null) : null;
          // A matching position reduced outside our ledger retains proportional known costs.
          // Unknown additions/new entry basis use the explicit estimated-cost fallback.
          if (ours && sameInst && ours.side === side) {
            np.openedAt = ours.openedAt;
            np.profitTaken = ours.profitTaken;
            if (!np.profitTaken && np.contracts < ours.contracts) {
              // An ambiguous order may have filled at the exchange. Do not repeat a profit
              // partial after reconciliation adopts that reduction without a local fill.
              const uncertainProfit = this.d.db.raw.prepare(`SELECT 1 FROM orders
                WHERE bee=? AND inst_id=? AND purpose='profit_take' AND state='unknown' AND ts>=? LIMIT 1`)
                .get(id, theirs.instId, ours.openedAt);
              if (uncertainProfit) np.profitTaken = true;
            }
            np.trendTrimmed = ours.trendTrimmed;
            np.entryScore = ours.entryScore;
            if (np.entryPx === ours.entryPx && np.contracts <= ours.contracts) {
              const ratio = np.contracts / ours.contracts;
              if (ours.entryFeesUsd !== undefined) np.entryFeesUsd = ours.entryFeesUsd * ratio;
              if (ours.fundingAccruedUsd !== undefined) np.fundingAccruedUsd = ours.fundingAccruedUsd * ratio;
              np.exitPeakPx = ours.exitPeakPx;
              np.exitPeakNetPerUnit = ours.exitPeakNetPerUnit;
            }
          } else np.openedAt = now;
          if (inst && np.initialStopPx !== null && np.initialStopPx !== undefined) np.riskUsd = sizedRiskUsd(np.contracts, inst.ctVal, np.entryPx, np.initialStopPx);
          bee.flatSince = null;
        }
      }
      this.d.db.insertRecon(id, now, ok, { detail });
      if (!ok) diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    const ok = diffs.length === 0;
    const was = this.recon.ok;
    this.recon = { ok, detail: ok ? "books match OKX" : diffs.join(" | "), ts: now };
    this.d.bus.emit("recon", { ok, detail: this.recon.detail }, now);
    if (!ok && was !== false) this.d.alerts.send(`reconciliation mismatch: ${this.recon.detail}`);
  }

  /** Momentum bees: who is #1 on the hourly rank, and for how many ranks in a row. */
  private rankBoozyHourly() {
    const now = this.now();
    for (const id of BEES) {
      if (this.d.cfg.slots[id].style !== "boozy") continue;
      const bee = this.bees[id];
      if (Math.floor(now / 3_600_000) === Math.floor(bee.top1.rankedAt / 3_600_000)) continue;
      // Each Momentum bee's own ranking: a coin-restricted bee only ranks its own coins.
      const topId = this.brain(id).universe(this.ctx(id, now))[0];
      if (!topId) continue;
      const coin = coinOf(topId);
      bee.top1 = { coin, streak: coin === bee.top1.coin ? bee.top1.streak + 1 : 1, rankedAt: now };
    }
  }

  private brains: Partial<Record<BeeId, BeeBrain>> = {};
  private brainOverlay: Partial<Record<BeeId, number | null>> = {};
  private brainsVersion = -1;

  /**
   * The slot's style brain, narrowed to the owner's coins and carrying the owner's rules (bees/custom.ts). While the
   * Beekeeper has a rewrite live for the bee, its rules stand in for the owner's (lab/brain.ts).
   */
  private brain(id: BeeId): BeeBrain {
    const lab = this.d.lab;
    if (lab && lab.version !== this.brainsVersion) {
      this.brainsVersion = lab.version;
      for (const b of BEES) {
        const overlay = lab.overlay(b)?.id ?? null;
        if (this.brains[b] && (this.brainOverlay[b] ?? null) === overlay) continue;
        if (this.brains[b]) log.info("bee brain updated by the Beekeeper", { bee: b, overlay });
        delete this.brains[b];
        this.brainOverlay[b] = overlay;
      }
    }
    const s = this.d.cfg.slots[id];
    return (this.brains[id] ??= customBrain(brainsFor(this.d.cfg)[s.style], liveRules(s, lab?.overlay(id) ?? null)));
  }

  private knobs(id: BeeId) {
    return this.d.cfg.bees[this.d.cfg.slots[id].style];
  }

  private checkJevOutage(now: number) {
    const since = this.d.jev.downSince;
    if (since === null) {
      if (this.jevDownAlerted) this.d.alerts.send("Jev is back");
      this.jevDownAlerted = false;
    } else if (!this.jevDownAlerted && now - since > 5 * 60_000) {
      this.jevDownAlerted = true;
      this.d.alerts.send("Jev unreachable for over 5 minutes: all bees holding");
    }
  }

  private sizeMult(now: number): number {
    const { cfg } = this.d;
    if (cfg.mode !== "live" || this.liveStartedAt === null) return 1;
    return now - this.liveStartedAt < cfg.risk.liveRampHours * 3_600_000 ? cfg.risk.liveSizeMultiplier : 1;
  }

  // ---------- read-only views for the dashboard ----------

  private publicBee(id: BeeId) {
    const b = this.bees[id];
    const view = this.d.feed.view();
    const p = b.position;
    const inst = p ? view.instruments.get(p.instId) : undefined;
    const mid = p ? view.tickers.get(p.instId)?.mid : undefined;
    const start = this.d.cfg.cats[id].startEquityUsd;
    const knobs = this.knobs(id);
    const r2 = (x: number) => Number(x.toFixed(2));
    return {
      bee: id,
      equityUsd: r2(b.equityUsd),
      pnlUsd: r2(b.equityUsd - start),
      pnlPct: r2(((b.equityUsd - start) / start) * 100),
      position: p
        ? {
            coin: p.coin,
            side: p.side,
            sizeUsd: inst && mid ? r2(positionNotional(p, mid, inst.ctVal)) : null,
            entryPx: p.entryPx,
            markPx: mid ?? null,
            stopPx: p.stopPx,
            uplUsd: r2(b.uplUsd),
            minutesHeld: Math.round(minutesSince(p.openedAt, this.now())),
          }
        : null,
      flatMinutes: p ? null : Math.round(minutesSince(b.flatSince, this.now())),
      tradesToday: b.tradesToday,
      entriesUsed: entriesUsed(b),
      maxTradesPerDay: knobs.maxTradesPerDay,
      feesTodayUsd: r2(b.feesTodayUsd),
      feeBudgetUsd: knobs.feeBudgetUsdDay,
      cap: b.cap,
      totals: { feesUsd: r2(b.totals.feesUsd), fundingUsd: r2(b.totals.fundingUsd), jevUsd: Number(b.totals.jevUsd.toFixed(4)), realisedUsd: r2(b.totals.realisedUsd), decisions: b.totals.decisions, orders: b.totals.orders },
      maxNotionalUsd: r2(maxNotionalUsd(this.ctx(id, this.now()))),
      last: this.last[id] ?? null,
    };
  }

  snapshot() {
    const bees = BEES.map((id) => this.publicBee(id));
    const sum = (f: (b: (typeof bees)[number]) => number) => Number(bees.reduce((a, b) => a + f(b), 0).toFixed(4));
    const view = this.d.feed.view();
    return {
      ts: this.now(),
      mode: this.d.cfg.mode,
      startedAt: this.experimentStartedAt,
      closed: this.closedAt === null ? null : { at: this.closedAt, flat: BEES.every((id) => !this.bees[id].position) },
      startEquityUsd: this.d.cfg.risk.startEquityUsd,
      tickMs: this.d.cfg.tickMs,
      bees,
      leaderboard: [...bees].sort((a, b) => b.equityUsd - a.equityUsd).map((b) => ({ bee: b.bee, equityUsd: b.equityUsd })),
      totals: { feesUsd: sum((b) => b.totals.feesUsd), fundingUsd: sum((b) => b.totals.fundingUsd), jevUsd: sum((b) => b.totals.jevUsd), pnlUsd: sum((b) => b.pnlUsd) },
      jev: { spentTodayUsd: Number(this.d.jev.spentTodayUsd.toFixed(4)), dailyCapUsd: this.d.cfg.jev.dailyUsdCap, capTripped: this.d.jev.capTripped, down: this.d.jev.downSince !== null },
      recon: this.recon,
      market: {
        refreshedAt: view.ts,
        universe: view.gated.map((i) => i.split("-")[0]),
        spreadBlocked: view.spreadBlocked.map((i) => ({ coin: i.split("-")[0], spreadBp: Number((view.tickers.get(i)?.spreadBp ?? 0).toFixed(1)) })),
        attention: view.newsAvailable ? "news" : "volume",
      },
    };
  }

  health() {
    const age = this.now() - this.d.feed.lastRefreshAt;
    return { ok: this.d.feed.lastRefreshAt > 0 && age < 5 * this.d.cfg.dataRefreshMs, mode: this.d.cfg.mode, closed: this.closedAt !== null, flat: BEES.every((id) => !this.bees[id].position), marketAgeMs: age, uptimeS: Math.round((this.now() - this.startedAt) / 1000) };
  }
}

function fundingSlot(ms: number): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const slotHour = [...FUNDING_HOURS_UTC].reverse().find((x) => h >= x) ?? 0;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slotHour);
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case "none":
      return "hold";
    case "close":
      return `close (${a.reason})`;
    case "trim":
      return `trim ${Math.round(a.fraction * 100)}%`;
    case "add":
      return `add $${a.notionalUsd.toFixed(0)}`;
    case "open":
      return `${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
    case "switch":
      return `switch to ${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
  }
}
