import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { trainerPlaybook, trainerPrompt } from "../src/coach-prompt.js";
import { strategyParameters } from "../src/strategy-parameters.js";

describe("upstream migration configuration",()=>{
  it("prints effective file settings and reference differences without leaking credentials",()=>{
    const dir=mkdtempSync(join(tmpdir(),"catfolio-config-"));
    try {
      const path=join(dir,"settings.env");
      writeFileSync(path,"DECISION_PROVIDER=gemini\nSTRATEGY_ENGINE=upstream\nGEMINI_API_KEY=do-not-print-this-fixture\nTIGER_MAX_ENTRIES_PER_DAY=9\n");
      const text=execFileSync(process.execPath,["--import","tsx","src/tools/effective-config.ts",path,"--diff","strategies/ARGON_INTENDED.json"],{encoding:"utf8"});
      const output=JSON.parse(text);
      expect(text).not.toContain("do-not-print-this-fixture");
      expect(output).toMatchObject({source:"file-simulation",settings:{strategyEngine:"upstream",chooser:{apiKeyPresent:true}}});
      expect(output.differences).toContainEqual({path:"bees.bizzy.maxTradesPerDay",actual:9,intended:4});
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it("only gives the upstream trainer moves and parameters used by the active engine",()=>{
    const cfg=loadConfig({STRATEGY_ENGINE:"upstream"});
    expect(strategyParameters(cfg,"tiger")).toEqual({});
    expect(strategyParameters(cfg,"mochi")).toEqual({minActionProbability:0.55});
    expect(trainerPlaybook(cfg)[0]!.moves).toContain("FADE_LONG_<coin>");
    expect(trainerPrompt(cfg)).toContain("does NOT read free-text rules");
    expect(trainerPrompt(cfg)).not.toContain("Dark Wall-E uses its configured momentum");
  });
});
