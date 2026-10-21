import { afterEach, describe, expect, it, vi } from "vitest";
import { CatfolioEngine } from "../src/catfolio-engine.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { Gemini } from "../src/gemini.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import type { MarketFeed } from "../src/market/data.js";
import type { Alerts } from "../src/alerts.js";
import { coin, NOW, position, trend, view } from "./fixtures.js";
const cleanup: Array<()=>Promise<void>> = [];
afterEach(async()=>{for(const close of cleanup.splice(0)) await close();});
const response = (choice: string) => new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({choice,confidence:0.9,conviction:2})}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10}}));
async function harness(fetcher: typeof fetch = async()=>response("WAIT"), env: Record<string,string> = {}) {
  let now=NOW;
  const cfg=loadConfig({DECISION_PROVIDER:"gemini",GEMINI_API_KEY:"fixture-key",TIGER_COOLDOWN_MINUTES:"0",MOCHI_COOLDOWN_MINUTES:"0",COACH_ENABLED:"false",...env});
  const s=coin("BTC",{ret1hPct:1,breakout:{dayOpen:95,prevRange:5,trigger:99},trend:trend({score:0})});
  const v=view([s]), db=new Db(":memory:"), bus=new EventBus(db);
  const provider=new Gemini(cfg.gemini,db,fetcher,()=>now);
  const feed={lastRefreshAt:now,view:()=>v,refresh:async()=>{feed.lastRefreshAt=now;},refreshTickers:async()=>{v.tickers.get(s.instId)!.ts=now;}} as unknown as MarketFeed;
  const engine=new CatfolioEngine({cfg,db,bus,provider,feed,exec:new SimExecutor(()=>v,cfg.risk.takerFeeRate,()=>now,cfg.paperSlippageBps),alerts:{send:()=>{}} as unknown as Alerts,now:()=>now});
  await engine.start(); cleanup.push(async()=>{await engine.stop();db.close();});
  const mark=(price:number)=>{Object.assign(s,{mid:price,last:price,bid:price*0.99995,ask:price*1.00005}); Object.assign(v.tickers.get(s.instId)!,{mid:price,last:price,bid:s.bid,ask:s.ask,ts:now});};
  return {cfg,s,v,db,bus,provider,engine,feed,mark,advance:(ms:number)=>{now+=ms;}};
}

describe("Argon engine integration",()=>{
  it("benches the trainer even when old enable and automatic-change flags remain",async()=>{
    const h=await harness(vi.fn(),{AI_GATEWAY_API_KEY:"fixture-gateway-key",COACH_ENABLED:"true",COACH_AUTO_APPLY:"true"});
    expect(h.cfg.coach).toMatchObject({enabled:false,autoApply:false});
    expect(h.engine.snapshot().coach).toMatchObject({benched:true,enabled:false,autoApply:false,
      message:"Trainer benched. No reviews or strategy changes while the upstream strategies run."});
    expect(h.engine.coach.state().cats.every(cat=>cat.phase === "paused")).toBe(true);
    await h.engine.coach.tick();
    expect(h.db.raw.prepare("SELECT * FROM coach_reviews").all()).toHaveLength(0);
  });
  it("records code fallback without model confidence, while retaining coin restrictions and stop-risk sizing",async()=>{
    const fetcher=vi.fn(), h=await harness(fetcher,{GEMINI_API_KEY:""});
    await h.engine.tick();
    const row=h.db.raw.prepare("SELECT decided_by, fallback_reason, probabilities_json, confidence FROM decisions WHERE bee='tiger' AND choice IS NOT NULL").get();
    expect(row).toMatchObject({decided_by:"code",fallback_reason:"no_key",probabilities_json:null,confidence:null});
    expect(h.engine.bees.tiger.position?.coin).toBe("BTC");
    expect(h.engine.bees.tiger.position!.riskUsd).toBeLessThanOrEqual(h.cfg.cats.tiger.startEquityUsd*h.cfg.cats.tiger.stopRiskPct/100);
    const events=h.db.recentEvents(20,"decision").map(x=>JSON.parse(x));
    expect(events.find(e=>e.bee==="tiger")).toMatchObject({source:"code",decidedBy:"code",fallbackReason:"no_key",confidence:null});
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.engine.snapshot().protectiveIntervalMs).toBe(2000);
  });
  it("runs the code chooser after a zero Gemini budget rather than freezing trading",async()=>{
    const fetcher=vi.fn(),h=await harness(fetcher,{GEMINI_DAILY_USD_CAP:"0"});
    await h.engine.tick();
    expect(h.engine.bees.tiger.position).not.toBeNull();
    expect(h.db.raw.prepare("SELECT fallback_reason FROM decisions WHERE bee='tiger' AND choice IS NOT NULL").get()).toMatchObject({fallback_reason:"cap"});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("closes through the exit watch while Gemini is pending and drops its stale answer",async()=>{
    let release!: (r:Response)=>void;
    const fetcher=vi.fn(()=>new Promise<Response>(r=>{release=r;})),h=await harness(fetcher);
    h.engine.bees.tiger.position=position(h.s,{contracts:20,stopPx:99.5,initialStopPx:99.5,riskUsd:1});
    h.mark(101);
    const pending=h.engine.tick();
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    h.mark(99);
    await h.engine.core.exitWatch();
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT purpose,reduce_only FROM orders").all()).toEqual([{purpose:"stop",reduce_only:1}]);
    release(response("HOLD")); await pending;
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(1);
    expect(h.db.raw.prepare("SELECT vetoed_by,jev_cost_usd FROM decisions WHERE vetoed_by='stale_model_response'").get()).toMatchObject({vetoed_by:"stale_model_response",jev_cost_usd:0.0006});
    expect(h.engine.bees.tiger.totals.jevUsd).toBeCloseTo(0.0006);
  });
  it("does not submit two stop orders when watch and tick overlap",async()=>{
    const h=await harness();
    h.engine.bees.tiger.position=position(h.s,{contracts:20,stopPx:101,initialStopPx:101,riskUsd:1});
    await Promise.all([h.engine.tick(),h.engine.core.exitWatch(),h.engine.core.exitWatch()]);
    expect(h.engine.bees.tiger.position).toBeNull();
    expect(h.db.raw.prepare("SELECT * FROM orders WHERE purpose='stop'").all()).toHaveLength(1);
  });
  it("does not use a stale ticker to trigger the independent price stop",async()=>{
    const h=await harness();
    h.engine.bees.tiger.position=position(h.s,{contracts:20,stopPx:101,initialStopPx:101,riskUsd:1});
    h.advance(h.cfg.maxTickerAgeMs+1); h.feed.refreshTickers=async()=>{};
    await h.engine.core.exitWatch();
    expect(h.engine.bees.tiger.position).not.toBeNull();
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it("keeps the upstream trainer isolated from legacy strategy evidence",async()=>{
    const h=await harness();
    await h.engine.tick();
    const row=h.db.raw.prepare("SELECT audit_json FROM decisions WHERE bee='tiger'").get()!;
    expect(JSON.parse(String(row.audit_json))).toMatchObject({strategyVersion:"catfolio-argon-6cf999a-1",config:{provider:"gemini"}});
    expect(h.db.getMeta("coach_strategy_version")).toBe("catfolio-argon-6cf999a-1");
  });
  it.each(["stale_market_data","stale_indicators","liquidity_gate"])("vetoes code entries on %s",async reason=>{
    const h=await harness(vi.fn(),{GEMINI_API_KEY:""});
    if (reason === "stale_market_data") { h.v.tickers.get(h.s.instId)!.ts=NOW-16000; h.feed.refreshTickers=async()=>{}; }
    if (reason === "stale_indicators") h.s.refreshedAt=NOW-181000;
    if (reason === "liquidity_gate") h.s.vol24hUsd=100;
    await h.engine.tick();
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
    expect(h.db.raw.prepare("SELECT vetoed_by FROM decisions WHERE bee='tiger'").get()).toMatchObject({vetoed_by:reason});
  });
});
