// Catfolio's application adapter. Engine owns every trading tick, menu, cap and order.
import { Engine, type EngineDeps as SourceDeps } from "./engine.js";
import type { EngineJev, EngineResult, EngineStore, EngineOverlay } from "./engine-ports.js";
import { BEES, type BeeId } from "./config.js";
import { CatCoach, coachRevision } from "./coach.js";
import { catBrain, entryDiagnostics } from "./cats.js";
import { entriesUsed, positionNotional } from "./bees/common.js";
import type { BeeContext } from "./bees/types.js";
import { RUBRIC_VERSION, strategyVersion, type DecisionProvider, type DecisionResult, type DecisionAsk } from "./decision.js";
import { decisionConfiguration } from "./providers.js";
import { EventBus } from "./events.js";
import type { Db, DecisionRow } from "./db.js";
import { log } from "./log.js";
import { safeError } from "./redact.js";
import { buildSnapshot } from "./snapshot.js";

export interface CatfolioEngineDeps extends Omit<SourceDeps, "jev" | "db" | "lab"> {
  db: Db;
  provider: DecisionProvider;
  coachFetch?: typeof fetch;
}

/** Translate the selected provider to the original Jev protocol, without choosing a move. */
export class ProviderBridge implements EngineJev {
  downSince: number | null = null;
  constructor(private provider: DecisionProvider, private now: () => number, private revision: () => string) {}
  get spentTodayUsd() { return this.provider.status().estimatedSpentTodayUsd ?? 0; }
  get capTripped() {
    const status = this.provider.status();
    return status.provider !== "gemini" && status.dailyUsdCap !== undefined && this.spentTodayUsd >= status.dailyUsdCap;
  }
  async decide(ask: DecisionAsk): Promise<EngineResult> {
    const revision = this.revision();
    let r: DecisionResult;
    try { r = await this.provider.decide(ask); }
    catch { r = { ok:false as const, reason:"provider_exception", latencyMs:0 }; }
    if (revision !== this.revision()) r = {ok:false,reason:"rules_changed_during_request",latencyMs:r.latencyMs,costUsd:r.costUsd};
    if (r.ok && (!Object.hasOwn(ask.menu,r.choice) || !Number.isFinite(r.probabilities[r.choice])))
      r = {ok:false,reason:"invalid_provider_choice",latencyMs:r.latencyMs};
    if (r.ok) { this.downSince = null; return {...r,costUsd:r.costUsd ?? 0}; }
    if (r.reason !== "daily_cap") this.downSince ??= this.now();
    return r;
  }
}

/** Track loop progress and drain shutdown without changing the source trading algorithm. */
class TrackedEngine extends Engine {
  private pending = new Map<"decisions" | "market" | "exits", Promise<void>>();
  private progress = {
    decisions: { startedAt: 0, completedAt: 0 },
    market: { startedAt: 0, completedAt: 0 },
    exits: { startedAt: 0, completedAt: 0 },
  };
  constructor(private observedDeps: SourceDeps) { super(observedDeps); }
  beforeTick?: () => void;
  private track(kind: "decisions" | "market" | "exits", run: () => Promise<void>): Promise<void> {
    // A skipped overlapping invocation must not mask a hung original invocation.
    if (this.pending.has(kind)) return Promise.resolve();
    const now = this.observedDeps.now ?? Date.now;
    this.progress[kind].startedAt = now();
    const task = Promise.resolve().then(run).finally(() => {
      this.progress[kind].completedAt = now();
      this.pending.delete(kind);
    });
    this.pending.set(kind, task);
    return task;
  }
  override tick(): Promise<void> {
    return this.track("decisions", () => { this.beforeTick?.(); return super.tick(); });
  }
  override refreshMarket(): Promise<void> { return this.track("market", () => super.refreshMarket()); }
  override exitWatch(): Promise<void> { return this.track("exits", () => super.exitWatch()); }
  async drain() { await Promise.allSettled(this.pending.values()); }
  loopHealth(stopped: boolean) {
    const { cfg } = this.observedDeps;
    const now = (this.observedDeps.now ?? Date.now)();
    // Failed requests still count as progress. Only stuck loops need a restart.
    const stallMs = Math.max(600_000, 20 * cfg.okx.cliTimeoutMs,
      2 * (cfg.decisionProvider === "gemini" ? cfg.gemini.timeoutMs : cfg.decisionProvider === "jev" ? cfg.jev.timeoutMs : cfg.local.timeoutMs));
    const loop = (kind: "decisions" | "market" | "exits", interval: number) => {
      const running = this.pending.has(kind), { startedAt, completedAt } = this.progress[kind];
      return { running, startedAt: startedAt || null, completedAt: completedAt || null,
        stalled: now - ((running ? startedAt : completedAt) || this.startedAt) > stallMs + (running ? 0 : interval) };
    };
    const loops = { decisions: loop("decisions", cfg.tickMs), market: loop("market", cfg.dataRefreshMs), exits: loop("exits", Math.min(cfg.tickMs, 2000)) };
    const reasons = [
      ...(stopped ? ["engine_stopped"] : []),
      ...(loops.decisions.stalled ? ["decision_loop_stalled"] : []),
      ...(loops.exits.stalled && BEES.some(id => this.bees[id]?.position) ? ["protective_loop_stalled"] : []),
      ...(loops.market.stalled ? ["market_loop_stalled"] : []),
    ];
    return { live: reasons.length === 0, reasons, loops, stallMs };
  }
}

export class CatfolioEngine {
  readonly core: Engine;
  readonly coach: CatCoach;
  private source: TrackedEngine;
  private now: () => number;
  private trainerTimer?: NodeJS.Timeout;
  private stopped = false;
  private lastDecision = new Map<BeeId, {id:number;row:DecisionRow;diagnostics:unknown}>();
  constructor(private d: CatfolioEngineDeps) {
    this.now = d.now ?? Date.now;
    const versions = {tiger:0,mochi:0};
    let version = 0;
    const lab = {
      get version() { return version; },
      overlay: (id:BeeId): EngineOverlay => ({id:versions[id],rules:d.cfg.slots[id].rules,coins:d.cfg.slots[id].coins}),
    };
    this.coach = new CatCoach({cfg:d.cfg,db:d.db,now:this.now,fetch:d.coachFetch,
      closed:()=>this.stopped || !!this.source?.snapshot().closed || !!d.closeRequested?.(),
      changed:id=>{ versions[id]=++version; },
      context:id=>({account:this.publicCat(id),diagnostics:entryDiagnostics(id,this.ctx(id)),marketUpdatedAt:d.feed.lastRefreshAt,
        jevState:buildSnapshot(catBrain(id,d.cfg),this.ctx(id)).state,menu:catBrain(id,d.cfg).menu(this.ctx(id))}),
      universe:()=>({refreshedAt:d.feed.lastRefreshAt,coins:[...d.feed.view().instruments.values()].map(i=>({coin:i.coin,marketEligible:d.feed.view().gated.includes(i.instId),indicatorsUpdatedAt:d.feed.view().stats.get(i.instId)?.refreshedAt ?? null}))}),
    });
    const bridge = new ProviderBridge(d.provider,this.now,()=>BEES.map(id=>coachRevision(d.cfg,id)).join("/"));
    const db = this.store();
    const bus = new EventBus(null);
    bus.subscribe((_line,event)=>{
      const {type,ts,...data}=event;
      if(type==="equity")d.bus.emit(type,{bees:BEES.map(id=>this.publicCat(id))},ts);
      else if(type==="decision"){
        const id=data.bee as BeeId, record=this.lastDecision.get(id), pulse=!!data.pulse;
        const row=pulse?undefined:record?.row;
        d.bus.emit(type,{...data,decisionId:pulse?null:record?.id,
          action:row?.action ?? {kind:"none"},probabilities:row?.probabilities ?? null,
          confidence:row?.confidence ?? null,latencyMs:row?.latencyMs ?? null,
          source:row?.decidedBy === "code" ? "code" : row?.jevError?"model":data.jev==="ok"&&!data.required?"model":"rules",
          decidedBy:row?.decidedBy ?? data.decidedBy ?? null, fallbackReason:row?.fallbackReason ?? data.fallbackReason ?? null,
          probabilityKind:d.cfg.decisionProvider === "gemini" ? "self_reported" : "distribution",
          error:row?.jevError ?? null,provider:d.cfg.decisionProvider,model:decisionConfiguration(d.cfg).model,
          entryDiagnostics:pulse?[]:record?.diagnostics ?? [],pnlUsd:this.bees[id].equityUsd-d.cfg.cats[id].startEquityUsd},ts);
      }else d.bus.emit(type,data,ts);
    });
    this.source = new TrackedEngine({...d,db,bus,jev:bridge,lab});
    this.source.beforeTick = () => { for (const id of BEES) this.metrics(id,this.now()); };
    this.core=this.source;
  }
  get bees() { return this.source.bees; }
  get startedAt() { return this.source.startedAt; }
  private ctx(id:BeeId):BeeContext {
    const bee=this.bees[id];
    return {bee,view:this.d.feed.view(),cfg:this.d.cfg,knobs:this.d.cfg.cats[id],now:this.now(),uplR:bee.position&&bee.position.riskUsd>0?bee.uplUsd/bee.position.riskUsd:null};
  }
  private metrics(id:BeeId,now:number) {
    const b=this.bees[id];
    if(b.position && b.metricsAt)b.exposedMs+=Math.max(0,now-b.metricsAt);
    b.metricsAt=now;b.peakEquityUsd=Math.max(b.peakEquityUsd,b.equityUsd);
    b.maxDrawdownPct=Math.max(b.maxDrawdownPct,100*(b.peakEquityUsd-b.equityUsd)/b.peakEquityUsd);
  }
  private store():EngineStore {
    const db=this.d.db;
    return {
      raw:db.raw,getMeta:db.getMeta.bind(db),setMeta:db.setMeta.bind(db),loadBee:db.loadBee.bind(db),
      saveBee:(bee,now)=>{this.metrics(bee.id,now);db.saveBee(bee,now);},
      insertOrder:db.insertOrder.bind(db),updateOrder:db.updateOrder.bind(db),insertFill:db.insertFill.bind(db),
      insertFunding:db.insertFunding.bind(db),insertEquity:db.insertEquity.bind(db),insertRecon:db.insertRecon.bind(db),insertCap:db.insertCap.bind(db),pruneEvents:db.pruneEvents.bind(db),
      insertDecision:row=>{
        const ctx=this.ctx(row.bee),brain=catBrain(row.bee,this.d.cfg),diagnostics=ctx.bee.position?[]:entryDiagnostics(row.bee,ctx);
        const state=row.stateJson?JSON.parse(row.stateJson):null;
        const request = row.auditJson ? JSON.parse(row.auditJson) : {};
        const recordedMenu = row.menuJson ? JSON.parse(row.menuJson) : null;
        const menu = recordedMenu && !Array.isArray(recordedMenu) ? recordedMenu : brain.menu(ctx);
        const audit={at:row.ts,source:row.decidedBy === "code" ? "code" : ["gemini","jev","lmstudio"].includes(row.decidedBy ?? "") ? "model_request" : state?.utc?(row.latencyMs === null || row.inputTokens === 0 ? "rules" : "model_request"):"protection",strategyVersion:strategyVersion(this.d.cfg),rubricVersion:RUBRIC_VERSION,
          decisionKind:request.decisionKind ?? "protection",
          entryDiagnostics:diagnostics,strategy:request.requestStrategy ?? brain.strategy,rubric:brain.convictionLabels,state,
          menu,account:ctx.bee,market:{ts:ctx.view.ts,instruments:[...ctx.view.instruments],tickers:[...ctx.view.tickers],stats:[...ctx.view.stats]},
          config:{...decisionConfiguration(this.d.cfg),limits:this.d.cfg.cats[row.bee],exits:this.d.cfg.exits[row.bee],risk:this.d.cfg.risk,strategyParameters:this.d.cfg.strategies[row.bee],slippageBps:this.d.cfg.paperSlippageBps,
            sourceStyle:brain.id,coachRules:this.d.cfg.slots[row.bee].rules,allowedCoins:this.d.cfg.slots[row.bee].coins,
            openGate:brain.entryGate?.(ctx) ?? (brain.openGate?{minConviction:brain.openGate.minConviction,minProb:brain.openGate.minProb(ctx)}:null)}};
        const saved={...row,latencyMs:row.inputTokens===0?null:row.latencyMs,menuJson:JSON.stringify(menu),auditJson:JSON.stringify(audit)};
        const id=db.insertDecision(saved);this.lastDecision.set(row.bee,{id,row:saved,diagnostics});return id;
      },
    };
  }
  async start() {
    const {cfg,db}=this.d;
    const signature=JSON.stringify({identities:BEES,total:cfg.totalStartEquityUsd,allocations:BEES.map(id=>cfg.cats[id].allocationPct),mode:cfg.mode});
    const stored=db.getMeta("allocation");
    if(stored && stored!==signature)throw Error("Persisted capital/mode is incompatible. Preserve history and select a new DB_PATH.");
    if(stored && BEES.some(id=>!db.loadBee(id)))throw Error("Incomplete persisted Catfolio accounts; refusing replacement funds");
    db.setMeta("allocation",signature);db.setMeta("product","catfolio-1");
    if(cfg.mode==="dry")db.raw.prepare("UPDATE orders SET state='rejected',error='interrupted paper order; no committed fill' WHERE state IN ('sent','unknown')").run();
    await this.source.start();
    for(const id of BEES){this.bees[id].metricsAt=this.now();db.saveBee(this.bees[id],this.now());}
    const train=async()=>{try{await this.coach.tick();}catch(err){log.warn("trainer tick failed",{err:safeError(err)});}finally{if(!this.stopped)this.trainerTimer=setTimeout(()=>void train(),60000);}};
    this.trainerTimer=setTimeout(()=>void train(),60000);
  }
  async stop() {
    this.stopped=true;clearTimeout(this.trainerTimer);this.source.stop();this.d.provider.close?.();
    await this.coach.stop();await this.source.drain();
    for(const id of BEES)if(this.bees[id])this.d.db.saveBee(this.bees[id],this.now());
  }
  tick() { return this.stopped?Promise.resolve():this.source.tick(); }
  refreshMarket() { return this.source.refreshMarket(); }
  reconcile() { return this.source.reconcile(); }
  resetEntryLimit(id: BeeId) { return this.source.resetEntryLimit(id); }
  private publicCat(id:BeeId) {
    const b=this.bees[id],p=b.position,view=this.d.feed.view(),inst=p?view.instruments.get(p.instId):undefined,mid=p?view.tickers.get(p.instId)?.mid:undefined,start=this.d.cfg.cats[id].startEquityUsd;
    const last=this.source.snapshot().bees.find(b=>b.bee===id)?.last;
    return {bee:id,name:this.d.cfg.slots[id].name,allocatedUsd:start,equityUsd:b.equityUsd,cashUsd:b.cashUsd,uplUsd:b.uplUsd,
      pnlUsd:b.equityUsd-start,pnlPct:100*(b.equityUsd/start-1),maxDrawdownPct:b.maxDrawdownPct,exposedMs:b.exposedMs,
      exposureUsd:p&&inst&&mid?positionNotional(p,mid,inst.ctVal):0,position:p?{...p,markPx:mid??null}:null,
      tradesToday:b.tradesToday,entriesUsed:entriesUsed(b),maxTradesPerDay:this.d.cfg.cats[id].maxTradesPerDay,totals:b.totals,slippageUsd:b.slippageUsd,cap:b.cap,
      last:last?{decidedBy:last.decidedBy, fallbackReason:last.fallbackReason, choice:last.choice,status:last.status,vetoedBy:this.lastDecision.get(id)?.row.vetoedBy ?? null,latencyMs:last.latencyMs,ts:last.ts}:null};
  }
  snapshot() {
    const source=this.source.snapshot();
    return {...source,mode:this.d.cfg.mode==="dry"?"PAPER":this.d.cfg.mode.toUpperCase(),cats:BEES.map(id=>this.publicCat(id)),
      configurationWarnings:this.d.cfg.configurationWarnings,totalStartEquityUsd:this.d.cfg.totalStartEquityUsd,decisionIntervalMs:this.d.cfg.tickMs,protectiveIntervalMs:Math.min(this.d.cfg.tickMs,2000),strategyEngine:this.d.cfg.strategyEngine,
      inference:this.d.provider.status(),coach:this.coach.state(),ownerControlsEnabled:!!this.d.cfg.coach.adminToken};
  }
  health() {
    const ready = this.source.health(), progress = this.source.loopHealth(this.stopped);
    return { ...ready, ...progress, ok: ready.ok && progress.live,
      reasons: [...progress.reasons, ...(!ready.ok ? ["market_data_stale"] : [])],
      marketError: this.d.feed.view().refreshError ?? null, inference: this.d.provider.status() };
  }
}
