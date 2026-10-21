import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { Gemini } from "../src/gemini.js";
import { decisionConfiguration } from "../src/providers.js";
import { redact, redactString } from "../src/redact.js";
import type { DecisionAsk } from "../src/decision.js";
const NOW = Date.UTC(2026,9,21,12);
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const database = () => { const db = new Db(":memory:"); databases.push(db); return db; };
const config = (env: Record<string,string> = {}) => loadConfig({ DECISION_PROVIDER:"gemini", GEMINI_API_KEY:"fixture-key", ...env });
const ask = (key = "tiger", state = 1): DecisionAsk => ({key, strategy:"Use only the offered menu", state:{me:{pos:"flat"},value:state},
  menu:{LONG_BTC:{desc:"strict setup",intent:{kind:"open",instId:"BTC",side:"long",sizeFrac:0.5,setup:"strict"}},WAIT:{desc:"keep cash",intent:{kind:"hold"}}},
  convictionLabels:["weak","fair","strong","overwhelming"],
});
const response = (choice = "LONG_BTC", usage: unknown = {promptTokenCount:100,candidatesTokenCount:8,thoughtsTokenCount:5}) => new Response(JSON.stringify({
  candidates:[{content:{parts:[{text:"private thought",thought:true},{text:JSON.stringify({choice,confidence:0.8,conviction:2})}]}}], usageMetadata:usage,
}));

describe("Gemini configuration and adapter", () => {
  it("selects Argon strategies with a Gemini key, preserving explicitly selected legacy providers", () => {
    expect(loadConfig({GEMINI_API_KEY:"key"})).toMatchObject({decisionProvider:"gemini",strategyEngine:"upstream",gemini:{model:"gemini-4-argon",dailyUsdCap:3,minIntervalMs:60000}});
    expect(loadConfig({})).toMatchObject({decisionProvider:"lmstudio",strategyEngine:"catfolio"});
    expect(loadConfig({GEMINI_API_KEY:"key",DECISION_PROVIDER:"jev"}).decisionProvider).toBe("jev");
    expect(config({STRATEGY_ENGINE:"catfolio"}).strategyEngine).toBe("catfolio");
  });
  it.each(["GEMINI_USD_PER_MTOK","GEMINI_USD_PER_MTOK_OUT"])("rejects invalid %s without echoing the value", field => {
    for (const value of ["0","-1","not-a-price"]) {
      expect(() => config({[field]:value})).toThrow(field);
      expect(() => config({[field]:value})).not.toThrow(`not-a-price`);
    }
  });
  it("never publishes the key and redacts Google's header and key format", () => {
    expect(JSON.stringify(decisionConfiguration(config()))).not.toContain("fixture-key");
    expect(redact({"x-goog-api-key":"secret-value"})).toEqual({"x-goog-api-key":"[redacted]"});
    expect(redactString("x-goog-api-key: fixture-key")).not.toContain("fixture-key");
    expect(redactString("AIza"+"a".repeat(35))).toBe("[redacted]");
  });
  it("uses the Gemini header, menu schema and output-inclusive accounting", async () => {
    const fetcher = vi.fn(async () => response());
    const db = database(), p = new Gemini(config().gemini,db,fetcher,()=>NOW);
    const result = await p.decide(ask());
    expect(result).toMatchObject({ok:true,source:"model",decidedBy:"gemini",choice:"LONG_BTC",conviction:2,costUsd:0.00066});
    const [url, init] = fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent");
    expect(url).not.toContain("fixture-key");
    expect(init.headers).toMatchObject({"x-goog-api-key":"fixture-key"});
    expect(init.body).not.toContain("fixture-key");
    expect(JSON.parse(String(init.body))).toMatchObject({generationConfig:{responseMimeType:"application/json",maxOutputTokens:1024,responseSchema:{properties:{choice:{enum:["LONG_BTC","WAIT"]}}}}});
    expect(db.chooserSpendSince(NOW-1)).toBeCloseTo(0.00066);
    expect(p.status()).toMatchObject({provider:"gemini",requests:1,connected:true,reservedUsd:0,probabilityKind:"self_reported"});
  });
  it("exposes missing-key fallback as CODE without sending a request", async () => {
    const fetcher = vi.fn(), p = new Gemini(config({GEMINI_API_KEY:""}).gemini,database(),fetcher,()=>NOW);
    expect(await p.decide(ask())).toMatchObject({ok:true,source:"code",decidedBy:"code",fallbackReason:"no_key",choice:"LONG_BTC"});
    expect(fetcher).not.toHaveBeenCalled();
    expect(p.status()).toMatchObject({connected:false,requests:0});
  });
  it("reserves spend before sending and refuses overlapping calls that do not fit", async () => {
    let release!: (r:Response)=>void;
    const fetcher = vi.fn(() => new Promise<Response>(r => {release=r;}));
    const db = database(), cfg = config({GEMINI_DAILY_USD_CAP:"0.03"}), p = new Gemini(cfg.gemini,db,fetcher,()=>NOW);
    const first = p.decide(ask("tiger"));
    expect(db.raw.prepare("SELECT settled FROM chooser_spend").get()).toMatchObject({settled:0});
    expect(await p.decide(ask("mochi"))).toMatchObject({ok:true,source:"code",fallbackReason:"reservation"});
    expect(fetcher).toHaveBeenCalledTimes(1);
    release(response()); await first;
    expect(db.raw.prepare("SELECT settled FROM chooser_spend").get()).toMatchObject({settled:1});
    expect(p.status().reservedUsd).toBe(0);
  });
  it("restores unsettled reservations after a restart", async () => {
    const db = database(); db.reserveChooserSpend(NOW,"tiger",0.029);
    const fetcher=vi.fn(), p = new Gemini(config({GEMINI_DAILY_USD_CAP:"0.03"}).gemini,db,fetcher,()=>NOW);
    expect(await p.decide(ask())).toMatchObject({source:"code",fallbackReason:"reservation"});
    expect(p.status().estimatedSpentTodayUsd).toBe(0.029);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["timeout","error","off_menu"])("charges unknown billing and marks %s fallback", async reason => {
    const db = database();
    const fetcher = vi.fn(async () => {
      if (reason === "timeout") throw new DOMException("timed out", "TimeoutError");
      if (reason === "error") return new Response("bad",{status:429});
      return response("NOT_ON_MENU");
    });
    const p = new Gemini(config().gemini,db,fetcher,()=>NOW), result = await p.decide(ask());
    expect(result).toMatchObject({ok:true,source:"code",fallbackReason:reason,choice:"LONG_BTC"});
    expect(result.costUsd).toBeGreaterThan(0);
    expect(db.chooserSpendSince(NOW-1)).toBeCloseTo(result.costUsd!);
    expect(p.status()).toMatchObject({failures:1,connected:false,reservedUsd:0});
  });
  it("paces each cat independently and refreshes an identical snapshot after the interval", async () => {
    let now=NOW;
    const fetcher=vi.fn(async()=>response()), p=new Gemini(config().gemini,database(),fetcher,()=>now);
    await p.decide(ask());
    expect(await p.decide(ask())).toMatchObject({source:"model",costUsd:0,inputTokens:0});
    expect(await p.decide(ask("tiger",2))).toMatchObject({source:"code",fallbackReason:"paced",choice:"WAIT"});
    await p.decide(ask("mochi")); expect(fetcher).toHaveBeenCalledTimes(2);
    now+=60000; await p.decide(ask()); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not count a previous day's in-flight call against the new UTC day", async () => {
    let now=Date.UTC(2026,9,21,23,59,59), release!: (r:Response)=>void;
    const db=database(), p=new Gemini(config().gemini,db,()=>new Promise<Response>(r=>{release=r;}),()=>now);
    const first=p.decide(ask()); now+=2000;
    expect(p.status().estimatedSpentTodayUsd).toBe(0);
    release(response()); await first;
    expect(p.status().estimatedSpentTodayUsd).toBe(0);
    expect(db.chooserSpendSince(Date.UTC(2026,9,22))).toBe(0);
  });
  it("never lowers the budget with invalid token counts", async () => {
    const p=new Gemini(config().gemini,database(),async()=>response("WAIT",{promptTokenCount:-10,candidatesTokenCount:-100}),()=>NOW);
    const result=await p.decide(ask()); expect(result.costUsd).toBeGreaterThan(0.02);
    expect(p.status().estimatedSpentTodayUsd).toBeGreaterThan(0.02);
  });
  it("cancels an active request on close without returning an executable fallback", async () => {
    const db=database();
    const fetcher: typeof fetch = async (_url,init) => new Promise((_r,reject)=>init?.signal?.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError"))));
    const p=new Gemini(config().gemini,db,fetcher,()=>NOW), pending=p.decide(ask()); p.close();
    expect(await pending).toMatchObject({ok:false,reason:"provider_closed"});
    expect(db.chooserSpendSince(NOW-1)).toBeGreaterThan(0);
  });
});
