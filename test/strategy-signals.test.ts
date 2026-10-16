import { describe, expect, it } from "vitest";
import { trendBreakoutSignal } from "../src/market/strategy-signals.js";
import { computeStats, MarketFeed } from "../src/market/data.js";
import { activeEntryBlockers } from "../src/bees/active-bizzy.js";
import { trendEntryBlockers } from "../src/bees/active-breezy.js";
import { entryDiagnostics } from "../src/cats.js";
import { strategyParameters } from "../src/strategy-parameters.js";
import { loadConfig } from "../src/config.js";
import type { Candle } from "../src/market/types.js";
import type { PublicApi } from "../src/okx/public.js";
import { NOW, position } from "./fixtures.js";
import { riskFixture } from "./risk-fixture.js";

const bars = (minutes:number,count=200,now=NOW): Candle[] => Array.from({length:count},(_,i)=>({
  ts:Math.floor(now/(minutes*60000))*minutes*60000-(count-i)*minutes*60000,
  o:100+i,h:101+i,l:99+i,c:100+i,confirmed:true,volUsd:1e6,
}));

describe("causal strategy signals",()=>{
  it("requires a confirmed breakout beyond the preceding channel with an aligned hourly regime",()=>{
    const c15=bars(15),hourly=bars(60);
    const neutral=trendBreakoutSignal(c15,hourly,NOW)!;
    expect(neutral).toMatchObject({regime:"long",side:null,entryHigh:299});
    c15.at(-1)!.c=c15.at(-1)!.h=302;
    const signal=trendBreakoutSignal(c15,hourly,NOW)!;
    expect(signal).toMatchObject({regime:"long",side:"long",entryHigh:299,close:302});
    const spike={...c15.at(-1)!,ts:NOW,c:99999,h:99999,confirmed:false};
    expect(trendBreakoutSignal([...c15,spike],[...hourly,spike],NOW)).toEqual(signal);
    expect(trendBreakoutSignal([...c15,{...spike,confirmed:true}],hourly,NOW)).toEqual(signal);
    const falling=hourly.map((c,i)=>({...c,o:500-i,h:501-i,l:499-i,c:500-i}));
    expect(trendBreakoutSignal(c15,falling,NOW)).toMatchObject({regime:"short",side:null});
    const cshort=c15.map((c,i)=>({...c,o:500-i,h:501-i,l:499-i,c:500-i}));
    cshort.at(-1)!.c=cshort.at(-1)!.l=298;
    expect(trendBreakoutSignal(cshort,falling,NOW)).toMatchObject({regime:"short",side:"short"});
  });
  it("rejects missing or duplicate bars, invalid OHLC, stale closes and insufficient hourly warmup",()=>{
    const c15=bars(15),hourly=bars(60);
    for(const invalid of [c15.slice(-40),c15.filter((_,i)=>i!==190),[...c15.slice(0,-1),c15.at(-2)!],
      c15.map((c,i)=>i===199?{...c,l:0}:c)]) expect(trendBreakoutSignal(invalid,hourly,NOW)).toBeNull();
    expect(trendBreakoutSignal(c15,hourly.slice(-100),NOW)).toBeNull();
    expect(trendBreakoutSignal(c15,hourly.slice(0,-1),NOW)).toBeNull();
    expect(trendBreakoutSignal(c15,hourly,NOW+15*60000)).toBeNull();
  });
  it("keeps completed-bar returns, ATR and MACD unchanged when only the live quote changes",()=>{
    const h=riskFixture(),inst=h.v.instruments.get(h.s.instId)!,quote=h.v.tickers.get(h.s.instId)!;
    const c15=bars(15),hourly=bars(60),a=computeStats(inst,quote,c15,hourly);
    const unfinished={...c15.at(-1)!,ts:NOW,c:9999,h:9999,confirmed:false};
    const b=computeStats(inst,{...quote,last:500,mid:500,bid:499,ask:501},[...c15,unfinished],[...hourly,unfinished]);
    for(const key of ["ret1hPct","ret24hPct","ret7dPct","atr14Pct","macdHistPct","rsi14"] as const) expect(b[key]).toBe(a[key]);
    expect(b.mid).toBe(500);
    expect(a.ret1hPct).toBeCloseTo((299/295-1)*100);
  });
  it("measures OI over one hour even when two hours of samples exist",async()=>{
    const h=riskFixture();let now=NOW-2*3600000,oi=100;
    const api:PublicApi={instruments:async()=>[...h.v.instruments.values()],tickers:async()=>h.v.tickers,
      openInterest:async()=>new Map([[h.s.instId,oi]]),funding:async()=>({rate:0,nextFundingTime:now+3600000}),fundingHistory:async()=>[],
      candles:async(_id,bar)=>bars(bar==="15m"?15:bar==="4H"?240:60,400,now)};
    const feed=new MarketFeed(api,{min24hVolUsd:0,allowNonCrypto:false,spreadGateBps:10,trendCoins:[]},null,()=>[]);
    await feed.refresh(now);now+=3600000;oi=200;await feed.refresh(now);
    now+=3600000;oi=300;await feed.refresh(now);
    expect(feed.view().stats.get(h.s.instId)!.oiChg1hPct).toBe(50);
  });
});

describe("entry cost, timing and research controls",()=>{
  it.each(["tiger","mochi"] as const)("%s rejects a stop dominated by costs and respects its configured ratio",id=>{
    const h=riskFixture(id),blockers=id==="tiger"?activeEntryBlockers:trendEntryBlockers;
    if(id==="tiger")h.s.atr14Pct=0.1;else h.s.trend!.atr4hPct=0.1;
    expect(blockers(h.s,h.ctx)).toContain("move_too_small_after_costs");
    h.cfg.cats[id].minStopCostRatio=0;
    expect(blockers(h.s,h.ctx)).not.toContain("move_too_small_after_costs");
    const d=entryDiagnostics(id,h.ctx)[0]!;
    expect(d.minStopDistancePct).toBe(0);expect(d.roundTripCostPct).toBeCloseTo(0.15);
  });
  it.each(["tiger","mochi"] as const)("%s blocks adverse chasing symmetrically and requires its current completed bar",id=>{
    const h=riskFixture(id),blockers=id==="tiger"?activeEntryBlockers:trendEntryBlockers;
    h.s.mid=102;expect(blockers(h.s,h.ctx)).toContain("price_extended");
    h.s.mid=98;h.s.ret1hPct=-1;h.s.macdHistPct=-0.2;h.s.trend!.score=-9;
    expect(blockers(h.s,h.ctx)).toContain("price_extended");
    h.s.mid=100;
    const candle=id==="tiger"?h.s.confirmed15m!:h.s.confirmed4h!;
    candle.ts-=id==="tiger"?15*60000:4*3600000;
    expect(blockers(h.s,h.ctx)).toContain("missing_confirmed_entry_close");
    h.b.position=position(h.s,{stopPx:90});
    expect(h.brain.protectiveExit!(h.ctx)).toBeNull();
  });
  it("makes the breakout mode independent of momentum gates and rejects a retraced trigger",()=>{
    const h=riskFixture();h.cfg.strategies.tiger.signalMode="trend_breakout";
    const c15=bars(15),hourly=bars(60);c15.at(-1)!.c=c15.at(-1)!.h=302;
    h.s.trendBreakout=trendBreakoutSignal(c15,hourly,NOW)!;
    h.s.confirmed15m!.close=302;h.s.mid=302;h.s.ret1hPct=0;h.s.macdHistPct=-1;
    expect(h.brain.menu(h.ctx).LONG_BTC?.desc).toContain("breakout");
    expect(strategyParameters(h.cfg,"tiger")).not.toHaveProperty("minMomentumPct");
    h.s.mid=298;
    expect(activeEntryBlockers(h.s,h.ctx)).toContain("breakout_retraced");
  });
  it("rejects Good entries already beyond their channel stop in either direction",()=>{
    const h=riskFixture("mochi");h.s.trend!.trailStop=99;h.s.mid=98;
    expect(trendEntryBlockers(h.s,h.ctx)).toContain("trend_stop_crossed");
    expect(h.brain.menu(h.ctx)).toEqual({});
    h.s.mid=100;expect(trendEntryBlockers(h.s,h.ctx)).not.toContain("trend_stop_crossed");
    h.s.trend!.score=-9;h.s.trend!.trailStop=101;h.s.mid=102;
    expect(trendEntryBlockers(h.s,h.ctx)).toContain("trend_stop_crossed");
    h.s.mid=100;expect(trendEntryBlockers(h.s,h.ctx)).not.toContain("trend_stop_crossed");
  });
  it("validates research options without increasing holding limits or risk by default",()=>{
    const c=loadConfig({});expect(c.strategies.tiger.signalMode).toBe("momentum");
    expect(c.strategies.tiger.maxHoldMinutes).toBe(120);expect(c.strategies.mochi.maxHoldMinutes).toBe(360);
    expect(c.coach.autoApply).toBe(false);
    for(const env of [{TIGER_SIGNAL_MODE:"magic"},{TIGER_TREND_FAST_HOURS:"50",TIGER_TREND_SLOW_HOURS:"20"},
      {TIGER_BREAKOUT_BARS:"2.5"},{MOCHI_MAX_ENTRY_CANDIDATES:"3"},{TIGER_MIN_STOP_COST_RATIO:"-1"},
      {COACH_AUTO_APPLY:"yes"}])expect(()=>loadConfig(env)).toThrow();
  });
});
