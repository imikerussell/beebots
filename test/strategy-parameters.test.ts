import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { riskFixture } from "./risk-fixture.js";
import { position, NOW } from "./fixtures.js";
import { applyParameters, strategyParameters, tunableParameters } from "../src/strategy-parameters.js";

describe("effective strategy configuration", () => {
  it("accepts continuous conviction thresholds and reports obsolete environment names", () => {
    const cfg = loadConfig({ TIGER_MIN_CONVICTION: "0.75", PROTECTIVE_INTERVAL_MS: "5000", TIGER_MIN_TREND_SCORE: "3" });
    expect(cfg.cats.tiger.minConviction).toBe(0.75);
    expect(cfg.configurationWarnings).toHaveLength(2);
    expect(strategyParameters(cfg,"tiger")).not.toHaveProperty("minTrendScore");
    expect(tunableParameters(cfg,"tiger").map(p=>p.field)).not.toContain("stopRiskPct");
  });
  it.each(["tiger","mochi"] as const)("%s gates use changed values without rebuilding the brain", id => {
    const h = riskFixture(id), proposal = {...h.proposal, conviction:0.8,prob:0.6};
    expect(h.run(proposal).vetoedBy).toContain("weak_conviction");
    applyParameters(h.cfg,id,{minConviction:0.75,minActionProbability:0.55});
    expect(h.run(proposal).action.kind).toBe("open");
    applyParameters(h.cfg,id,{minActionProbability:0.65});
    expect(h.run(proposal).vetoedBy).toContain("weak_conviction");
    expect(h.run({...proposal,conviction:0.74}).action.kind).toBe("none");
  });
  it("Dark momentum thresholds change actual entry eligibility and reported thresholds", () => {
    const h=riskFixture();h.s.ret1hPct=0.2;
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeDefined();
    applyParameters(h.cfg,"tiger",{minMomentumPct:0.3});
    expect(h.brain.menu(h.ctx)).toEqual({});
    applyParameters(h.cfg,"tiger",{minMomentumPct:0.1,momentumAtrMult:0.5});
    expect(h.brain.menu(h.ctx)).toEqual({});
    expect(h.brain.coinSnapshot(h.s,h.ctx).min_move_pct).toBe(0.25);
  });
  it("Good uses its trend threshold and only offers the qualifying direction",()=>{
    const h=riskFixture("mochi");h.s.trend!.score=-3;
    expect(h.brain.menu(h.ctx)).toEqual({});
    applyParameters(h.cfg,"mochi",{minTrendScore:3});
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["SHORT_BTC","WAIT"]);
    expect(h.run(null).action.kind).toBe("none");
  });
  it("Good enforces configurable trim/time exits and never adds back a trimmed position",()=>{
    const h=riskFixture("mochi");h.b.position=position(h.s,{contracts:2,entryScore:9,stopPx:90,openedAt:NOW-60*60000});h.ctx.uplR=2;
    h.s.trend!.score=7;
    expect(h.brain.menu(h.ctx).TRIM_HALF).toBeUndefined();
    applyParameters(h.cfg,"mochi",{trimScoreDrop:2});
    expect(h.brain.menu(h.ctx).TRIM_HALF).toBeDefined();
    h.b.position.trendTrimmed=true;h.s.trend!.score=9;
    expect(h.brain.menu(h.ctx).TRIM_HALF).toBeUndefined();
    expect(h.brain.menu(h.ctx).ADD_TO_WINNER).toBeUndefined();
    expect(h.brain.rebalance).toBeUndefined();
    h.cfg.strategies.mochi.maxHoldMinutes=60;
    expect(h.run(null,false).action).toEqual({kind:"close",reason:"time_stop"});
  });
  it.each(["tiger","mochi"] as const)("%s budgets stop loss plus estimated execution costs below its owner limit", id=>{
    const h=riskFixture(id), a=h.run().action;
    if(a.kind!=="open")throw Error("expected entry");
    const stop=h.brain.stopFor(h.s.instId,"long",h.s.mid,h.ctx)!;
    const fraction=(h.s.mid-stop)/h.s.mid + 2*h.cfg.risk.takerFeeRate + h.s.spreadBp/10000 + 2*h.cfg.paperSlippageBps/10000;
    expect(a.notionalUsd*fraction).toBeCloseTo(h.b.equityUsd*h.cfg.cats[id].stopRiskPct/100);
    h.cfg.cats[id].stopRiskPct/=2;
    const smaller=h.run().action;
    expect(smaller.kind==="open" && smaller.notionalUsd).toBeCloseTo(a.notionalUsd/2);
  });
  it("does not add when the existing stop risk already exceeds the budget",()=>{
    const h=riskFixture("mochi");h.b.position=position(h.s,{contracts:10,stopPx:90});h.ctx.uplR=2;
    const intent=h.brain.menu(h.ctx).ADD_TO_WINNER!.intent;
    expect(h.run({...h.proposal,intent,label:"ADD_TO_WINNER"}).action.kind).toBe("none");
  });
});
