import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine.js";
import { Engine as UpstreamEngine } from "./reference/upstream-engine.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import type { Alerts } from "../src/alerts.js";
import type { MarketFeed } from "../src/market/data.js";
import type { DecisionAsk } from "../src/decision.js";
import type { EngineJev } from "../src/engine-ports.js";
import { coin, NOW, position, trend, view } from "./fixtures.js";
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.useRealTimers();});

async function run(Cls:typeof Engine|typeof UpstreamEngine, scenario:string){
  let now=NOW, choice="LONG_BTC", fail=false, close=false;
  const cfg=loadConfig({MOCHI_COOLDOWN_MINUTES:"0",TIGER_COOLDOWN_MINUTES:"0"});
  const btc=coin("BTC",{ret1hPct:1,macdHistPct:0.2,trend:trend({score:9,longOn:9}),breakout:{dayOpen:99,prevRange:2,trigger:100}});
  const eth=coin("ETH",{ret1hPct:-1,macdHistPct:-0.2,trend:trend({score:-8,shortOn:8}),breakout:{dayOpen:99,prevRange:2,trigger:100}});
  const v=view([btc,eth]),db=new Db(":memory:"),calls:DecisionAsk[]=[];
  const feed={lastRefreshAt:now,view:()=>v,refresh:async()=>{feed.lastRefreshAt=now;},refreshTickers:async()=>{for(const t of v.tickers.values())t.ts=now;}} as unknown as MarketFeed;
  const jev:EngineJev={capTripped:false,downSince:null,spentTodayUsd:0,decide:async ask=>{
    calls.push(structuredClone(ask));
    if(fail)return {ok:false,reason:"timeout",latencyMs:1};
    const pick=ask.menu[choice]?choice:Object.keys(ask.menu)[0]!;
    return {ok:true,choice:pick,probabilities:{[pick]:1},confidence:1,conviction:3,convictionRaw:3,inputTokens:2,costUsd:0.001,latencyMs:1,model:"fixture"};
  }};
  const engine=new Cls({cfg,db,feed,jev,exec:new SimExecutor(()=>v,0.0005,()=>now,2),bus:new EventBus(db),alerts:{send:()=>{}} as unknown as Alerts,now:()=>now,closeRequested:()=>close});
  cleanups.push(()=>{engine.stop();db.close();});
  await engine.start();
  const b=engine.bees.mochi;
  if(scenario==="empty") {btc.ret1hPct=0;eth.ret1hPct=0;}
  if(["benched_trade","benched_fee","benched_stop","rollover","resume"].includes(scenario)){
    b.position=position(btc,{contracts:20,stopPx:90,entryScore:9});
    b.cap=scenario==="benched_fee"?"fee_budget":"trade_cap";b.tradesToday=3;
    choice="SHORT_BTC";
    if(scenario==="benched_stop")b.position.stopPx=101;
    if(scenario==="rollover")now+=86400000;
  }
  if(scenario==="hold_only")engine.bees.tiger.position=position(btc,{stopPx:90});
  if(scenario==="short")choice="SHORT_BTC";
  if(scenario==="outage")fail=true;
  if(scenario==="daily_cap")Object.assign(jev,{capTripped:true});
  if(scenario==="stale")feed.lastRefreshAt=now-999999;
  if(scenario==="loss")b.equityUsd=b.cashUsd=90;
  if(scenario==="retire")b.equityUsd=b.cashUsd=30;
  await engine.tick();
  now+=10000;
  if(scenario==="flip")choice="SHORT_BTC";
  else if(scenario==="switch")choice="SWITCH";
  else if(scenario==="trim"){btc.trend!.score=6;choice="TRIM_HALF";}
  else if(scenario==="rebalance"){if(b.position)b.position.contracts=10;choice="HOLD_WINNER";}
  else if(scenario==="stop_outage"){if(b.position)b.position.stopPx=101;fail=true;}
  else if(scenario==="day_close"){now=Math.floor(now/86400000)*86400000+86400000-60000;}
  else if(scenario==="close")close=true;
  else choice="HOLD_WINNER";
  await engine.tick();
  now+=10000;await engine.tick();
  const decisions=db.raw.prepare("SELECT bee,choice,action_json,vetoed_by,forced_by,status FROM decisions ORDER BY id").all();
  const orders=db.raw.prepare("SELECT bee,inst_id,side,contracts,reduce_only,purpose,state FROM orders ORDER BY id").all();
  const books=Object.values(engine.bees).map(b=>({id:b.id,cash:b.cashUsd,equity:b.equityUsd,position:b.position,cap:b.cap,trades:b.tradesToday,fees:b.feesTodayUsd,totals:b.totals}));
  return {calls,decisions,orders,books};
}

describe("whole-engine deterministic replay and intentional source differences",()=>{
  it.each(["entry","empty","hold_only","short","flip","switch","trim","rebalance","benched_trade","benched_fee","benched_stop","rollover","outage","daily_cap","stop_outage","stale","loss","retire","day_close","close"])("replays the same requests, orders and books: %s",async scenario=>{
    expect(await run(Engine,scenario)).toEqual(await run(Engine,scenario));
  });
  it("sizes below the historical source when the stop-risk budget binds", async()=>{
    const current=await run(Engine,"entry"), historical=await run(UpstreamEngine,"entry");
    for (const id of ["tiger","mochi"]) {
      const n=(rows:typeof current.orders)=>Number(rows.find(o=>o.bee===id && o.purpose==="open")!.contracts);
      expect(n(current.orders)).toBeGreaterThan(0);
      expect(n(current.orders)).toBeLessThan(n(historical.orders));
    }
  });
});
