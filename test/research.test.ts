import { describe, expect, it } from "vitest";
import { BAR_MS, runBacktest, type BacktestConfig, type ResearchBar } from "../src/research/backtest.js";
import { aggregateHourly } from "../src/research/compare.js";
import { missingIntervals } from "../src/research/fetch-history.js";
import type { Candle } from "../src/market/types.js";
const candle = (i: number, o = 100, h = o + 0.1, l = o - 0.1, c = o): Candle => ({ ts: i*BAR_MS,o,h,l,c,volUsd:1_000_000,confirmed:true });
const bar = (i: number, signal = false, overrides: Partial<ResearchBar> = {}): ResearchBar => ({candle:candle(i),ready:true,exitLong:false,exitShort:false,
  signal:signal?{side:"long",rank:1,atrPct:1,sizeFrac:1,signalClose:100}:null,...overrides});
const config = (overrides: Partial<BacktestConfig> = {}): BacktestConfig => ({name:"test",start:0,end:4*BAR_MS,initialEquity:250,riskPct:100,maxNotionalPct:50,
  stopAtrMult:2,maxHoldMinutes:1440,cooldownMinutes:0,maxEntriesPerDay:8,feeBudgetUsdDay:100,dailyLossStopPct:100,feeBps:0,slippageBps:0,halfSpreadBps:0,costMultiple:1,...overrides});
const run = (bars: ResearchBar[], overrides: Partial<BacktestConfig> = {})=>runBacktest(new Map([["BTC",bars]]),config(overrides));
describe("causal research simulation",()=>{
  it("executes after a completed signal at the next open, not the signal close",()=>{
    const result=run([bar(0,true),bar(1,false,{candle:candle(1,105,106,104,105)}),bar(2,false,{candle:candle(2,105,107,104,106)}),bar(3,false,{candle:candle(3,106)})]);
    expect(result.trades).toBe(1);expect(result.closed[0]!.entryTs).toBe(BAR_MS);expect(result.closed[0]!.entryPx).toBe(105);
  });
  it("cannot fill a last-bar signal and skips a missing next open",()=>{
    expect(run([bar(3,true)]).trades).toBe(0);
    expect(run([bar(0,true),bar(2)]).trades).toBe(0);
  });
  it("fills a stop gap at the worse open instead of the stop level",()=>{
    const result=run([bar(0,true),bar(1),bar(2,false,{candle:candle(2,95,96,94,95)}),bar(3)]);
    expect(result.closed[0]!.exitPx).toBe(95);expect(result.closed[0]!.reason).toBe("stop");expect(result.netPnl).toBeCloseTo(-6.25);
  });
  it("activates a close-derived trail next bar without using the current intrabar low",()=>{
    const result=run([bar(0,true),bar(1,false,{candle:candle(1,100,104,99,103),trailLong:102}),bar(2,false,{candle:candle(2,103,104,101,103)}),bar(3)]);
    expect(result.closed[0]!.exitTs).toBe(2*BAR_MS);expect(result.closed[0]!.exitPx).toBe(102);
  });
  it("adds entry and exit fees plus adverse spread/slippage even in a flat market",()=>{
    const result=run([bar(0,true),bar(1),bar(2),bar(3)],{feeBps:5,slippageBps:2,halfSpreadBps:1});
    expect(result.closed[0]!.entryPx).toBeCloseTo(100.03);expect(result.closed[0]!.exitPx).toBeCloseTo(99.97);
    expect(result.netPnl).toBeCloseTo(result.grossPnl-result.fees-result.fundingCost);expect(result.netPnl).toBeLessThan(-0.19);
    const stress=run([bar(0,true),bar(1),bar(2),bar(3)],{feeBps:5,slippageBps:2,halfSpreadBps:1,costMultiple:2});
    expect(stress.netPnl).toBeLessThan(result.netPnl);
  });
  it("charges realized funding to positions carried across settlement, not a new entry at that timestamp",()=>{
    const result=run([bar(0,true),bar(1,false,{fundingRate:0.01}),bar(2,false,{fundingRate:0.01}),bar(3)]);
    expect(result.fundingCost).toBeCloseTo(1.25);expect(result.closed[0]!.netPnl).toBeCloseTo(-1.25);expect(result.netPnl).toBeCloseTo(-1.25);
  });
  it("exits an interrupted market series at the next observed open without inventing missing fills",()=>{
    const result=run([bar(0,true),bar(1),bar(3,false,{candle:candle(3,90)})]);
    expect(result.closed[0]!.reason).toBe("missing_bar_exit_at_next_available_open");expect(result.closed[0]!.exitPx).toBe(90);
  });
  it("limits estimated stop loss plus transaction costs to the configured equity risk",()=>{
    const result=run([bar(0,true),bar(1),bar(2),bar(3)],{riskPct:0.5,feeBps:5,slippageBps:2,halfSpreadBps:1});
    expect(result.closed[0]!.notional).toBeCloseTo(250*0.005/(0.02+0.0016));
    expect(result.closed[0]!.notional).toBeLessThan(125);
  });
  it("rejects cost-infeasible stops and chased entries before spending fees",()=>{
    expect(run([bar(0,true),bar(1),bar(2),bar(3)],{feeBps:50,minStopCostRatio:3}).trades).toBe(0);
    expect(run([bar(0,true),bar(1,false,{candle:candle(1,101)}),bar(2),bar(3)],{maxChaseAtr:0.5}).trades).toBe(0);
  });
  it("rejects a breakout that retraced through its channel before the next open",()=>{
    const signal={side:"long" as const,rank:1,atrPct:1,sizeFrac:1,signalClose:100,entryBoundary:99.5};
    expect(run([bar(0,false,{signal}),bar(1,false,{candle:candle(1,99)}),bar(2),bar(3)]).trades).toBe(0);
  });
  it("flattens a held position after a marked daily loss and stays stopped until UTC reset",()=>{
    const result=run([bar(0,true),bar(1,false,{candle:candle(1,100,100.1,99.7,99.8)}),bar(2,true,{candle:candle(2,99.8)}),bar(3,true)],{dailyLossStopPct:0.05});
    expect(result.trades).toBe(1);expect(result.closed[0]!.exitTs).toBe(2*BAR_MS);expect(result.closed[0]!.reason).toBe("daily_loss_stop");
  });
  it("applies the owner's absolute notional ceiling and separate volatility cap",()=>{
    const signal={side:"long" as const,rank:1,atrPct:1,sizeFrac:1,signalClose:100,volatilityNotionalPct:40};
    const capped=run([bar(0,true),bar(1),bar(2),bar(3)],{maxNotionalPct:194,absoluteNotionalCap:300});
    const vol=run([bar(0,false,{signal}),bar(1),bar(2),bar(3)],{maxNotionalPct:194,absoluteNotionalCap:300});
    expect(capped.closed[0]!.notional).toBe(300);expect(vol.closed[0]!.notional).toBe(100);
  });
  it("rejects a trend entry at or beyond its already active channel stop",()=>{
    const signal={side:"long" as const,rank:1,atrPct:1,sizeFrac:1,signalClose:100,invalidatingStop:100};
    expect(run([bar(0,false,{signal}),bar(1),bar(2),bar(3)]).trades).toBe(0);
  });
  it("respects the daily entry cap and renews it at UTC midnight",()=>{
    const bars=Array.from({length:192},(_,i)=>bar(i,true));
    const result=run(bars,{end:192*BAR_MS,maxEntriesPerDay:1,maxHoldMinutes:15});
    expect(result.trades).toBe(2);expect(result.closed[0]!.entryTs).toBeLessThan(86_400_000);expect(result.closed[1]!.entryTs).toBeGreaterThanOrEqual(86_400_000);
  });
});
describe("research data integrity",()=>{
  it("aggregates only complete contiguous UTC-hour groups",()=>{
    const bars=Array.from({length:8},(_,i)=>candle(i));
    expect(aggregateHourly(bars)).toHaveLength(2);
    expect(aggregateHourly(bars.filter(c=>c.ts!==BAR_MS))).toHaveLength(1);
    expect(aggregateHourly(bars.slice(0,3))).toHaveLength(0);
    expect(aggregateHourly(bars.map((c,i)=>({...c,confirmed:i!==3})))).toHaveLength(1);
  });
  it("reports prefix, interior and suffix missing bars explicitly",()=>{
    const gaps=missingIntervals([candle(1),candle(3)],0,5*BAR_MS,BAR_MS);
    expect(gaps.map(g=>g.missingBars)).toEqual([1,1,1]);
  });
});
