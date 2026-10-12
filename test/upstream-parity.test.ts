import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyRisk } from "../src/risk.js";
import { applyRisk as sourceRisk } from "./reference/upstream-risk.js";
import { riskFixture } from "./risk-fixture.js";
import { NOW, position } from "./fixtures.js";
import type { Proposal } from "../src/risk.js";

describe("pinned upstream trading behavior (6d3fe0d)",()=>{
  it("keeps source brains and adapter intact except the documented Bizzy universe expansion",()=>{
    const hashes={bizzy:"b595b0b93309e468b849c9f2e95c21cfe7efd871f5f69b984c5a111b4f1cd895",breezy:"d4887163d4045d829ad751efa54f36d1638302e4ee4d8fd4220142a158e60886",custom:"bf22c06af263ffb2f68e5735ffc1fc0c5bb21ecd670cbeee861a1f2f0151435a"};
    for (const [name, hash] of Object.entries(hashes)) {
      let source = readFileSync(new URL(`../src/bees/${name}.ts`, import.meta.url), "utf8");
      if (name === "bizzy") source = source.replace(/export const BIZZY_BREAKOUT_COINS = .* as const;/, 'export const BIZZY_BREAKOUT_COINS = ["BTC", "ETH", "SOL", "HYPE"] as const;')
        .replace("when an allowed coin breaks above", "when BTC, ETH, SOL or HYPE breaks above");
      expect(createHash("sha256").update(source).digest("hex")).toBe(hash);
    }
  });
  it.each(["tiger","mochi"] as const)("%s risk actions match the frozen source oracle for valid market inputs",id=>{
    for(const scenario of ["entry","weak","flat","outage","cap","fee","loss","retired","stop","hold","add","flip","trim","cooldown","stale"]){
      const h=riskFixture(id);
      h.brain.entryGate = undefined; // Compare legacy gates with a nonbinding stop-risk budget.
      h.cfg.cats[id].stopRiskPct = 100;
      h.brain.protectiveExit = undefined;
      let proposal:Proposal|null=h.proposal;
      if(["hold","add","flip","trim","cooldown","stop"].includes(scenario)){
        h.b.position=position(h.s,{contracts:10,stopPx:90,entryScore:9});
        h.ctx.uplR=2;
        if(scenario==="trim")h.s.trend!.score=6;
        if(scenario==="stop")h.b.position.stopPx=101;
        if(scenario==="cooldown")h.b.lastOrderAt=NOW-1000;
        const menu=h.brain.menu(h.ctx),label=scenario==="add"?"ADD_TO_WINNER":scenario==="flip"||scenario==="cooldown"?"SHORT_BTC":scenario==="trim"?"TRIM_HALF":id==="tiger"?"HOLD":"HOLD_WINNER";
        if(!menu[label])continue;
        proposal={...h.proposal,label,intent:menu[label]!.intent};
      }
      if(scenario==="weak")proposal={...h.proposal,prob:0.2,conviction:0};
      if(scenario==="flat"||scenario==="outage")proposal=null;
      if(scenario==="cap")h.b.tradesToday=h.ctx.knobs.maxTradesPerDay;
      if(scenario==="fee")h.b.feesTodayUsd=10;
      if(scenario==="loss")h.b.equityUsd=90;
      if(scenario==="retired")h.b.equityUsd=30;
      const modelStatus=scenario==="outage"?"unreachable":proposal?"ok":"no_options";
      const input={ctx:h.ctx,brain:h.brain,proposal,sizeMult:1,dataAgeMs:scenario==="stale"?999999:0,maxDataAgeMs:180000};
      const source=sourceRisk({...input,jev:modelStatus}),actual=applyRisk({...input,jev:modelStatus});
      expect(actual,scenario).toEqual(source);
    }
  });
});
