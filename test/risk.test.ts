import { applyRisk } from "../src/risk.js";
import { describe, expect, it } from "vitest";
import { contractsFor } from "../src/exec/sizing.js";
import { maxNotionalUsd } from "../src/bees/common.js";
import { NOW, position } from "./fixtures.js";
import { riskFixture } from "./risk-fixture.js";

describe("restored source risk behavior", () => {
  it("Dark waits without a qualifying momentum signal; Good also waits for an accepted model entry", () => {
    const t = riskFixture(), m = riskFixture("mochi");
    t.s.ret1hPct = 0; t.b.flatSince = NOW - 86400000;
    expect(t.run(null).action.kind).toBe("none");
    m.s.trend!.score = -9;
    expect(m.run(null)).toMatchObject({action:{kind:"none"},forcedBy:null});
    expect(m.run(null,false).action.kind).toBe("none");
  });
  it.each(["tiger","mochi"] as const)("%s uses stop-risk sizing, lot floors and explicit account caps", id=>{
    const h=riskFixture(id), result=h.run();
    expect(result.action.kind).toBe("open");
    if(result.action.kind!=="open") throw Error(result.status);
    expect(result.action.notionalUsd).toBeLessThanOrEqual(maxNotionalUsd(h.ctx));
    expect(result.action.notionalUsd).toBeGreaterThan(0);
    expect(result.action.notionalUsd).toBeLessThan(100);
    h.cfg.cats[id].maxNotionalPct=50;
    const limited=h.run().action;
    expect(limited.kind).toBe("open");
    if(limited.kind==="open") expect(limited.notionalUsd).toBeLessThanOrEqual(50);
    expect(contractsFor(9.9999999999,{ctVal:1,lotSz:1,minSz:1},10)).toBe(0);
  });
  it("enforces exchange minimums without rounding up",()=>{
    const h=riskFixture();h.v.instruments.get(h.s.instId)!.minSz=1000;
    expect(h.run().vetoedBy).toMatch(/below_min_size/);
  });
  it.each(["tiger","mochi"] as const)("%s loss stop works while the model is unavailable",id=>{
    const h=riskFixture(id);h.b.equityUsd=100*(1-h.cfg.cats[id].dailyLossStopPct/100);
    h.b.position=position(h.s,{stopPx:90});
    expect(h.run(null,false)).toMatchObject({action:{kind:"close"},forcedBy:"loss_stop"});
  });
  it("caps suppress both forcing and rebalance but never suppress stops",()=>{
    for(const kind of ["entries","fees"]){
      const h=riskFixture("mochi");
      if(kind==="entries")h.b.tradesToday=h.cfg.cats.mochi.maxTradesPerDay;
      else h.b.feesTodayUsd=1;
      expect(h.run(null).action.kind).toBe("none");
      h.b.position=position(h.s,{contracts:10,stopPx:90});
      expect(h.run(null).action.kind).toBe("none");
      h.b.position.stopPx=101;
      expect(h.run(null,false).forcedBy).toBe("stop");
    }
  });
  it("allows winner adds and one deterioration trim, but never auto-rebalances",()=>{
    const h=riskFixture("mochi");h.b.position=position(h.s,{contracts:1,stopPx:99,entryScore:9});h.ctx.uplR=2;
    const choose=(label:string)=>h.run({...h.proposal,label,intent:h.brain.menu(h.ctx)[label]!.intent});
    expect(choose("ADD_TO_WINNER").action.kind).toBe("add");
    h.s.trend!.score=6;
    expect(choose("TRIM_HALF").action.kind).toBe("trim");
    expect(h.run(null)).toMatchObject({action:{kind:"none"},forcedBy:null});
    expect(h.run(null,false).action.kind).toBe("none");
  });
  it("discretionary cooldown applies to winner adds",()=>{
    const h=riskFixture("mochi");h.b.position=position(h.s,{contracts:1,stopPx:99});h.ctx.uplR=2;
    h.b.lastOrderAt=NOW-1000;
    const menu=h.brain.menu(h.ctx);
    expect(h.run({...h.proposal,label:"ADD_TO_WINNER",intent:menu.ADD_TO_WINNER!.intent}).vetoedBy).toMatch(/cooldown/);
  });
  it("source risk holds new exposure when the full market refresh is stale",()=>{
    const h=riskFixture();
    const result=applyRisk({ctx:h.ctx,brain:h.brain,proposal:h.proposal,jev:"ok",sizeMult:1,dataAgeMs:999999,maxDataAgeMs:180000});
    expect(result.action.kind).toBe("none");expect(result.vetoedBy).toBe("stale_market_data");
  });
});
