import { afterEach, describe, expect, it, vi } from "vitest";
import { BIZZY_BREAKOUT_COINS } from "../src/bees/bizzy.js";
import { CatCoach, CoachAnswer, COACH_EVIDENCE_WINDOW_MS, COACH_INTERVAL_MS, coachValues } from "../src/coach.js";
import { loadConfig, type BeeId } from "../src/config.js";
import { Db } from "../src/db.js";
import { catBrain } from "../src/cats.js";
import { trainerDisplayName, trainerPlaybook } from "../src/coach-prompt.js";
import { riskFixture } from "./risk-fixture.js";
import { startServer } from "../src/server.js";
import { EventBus } from "../src/events.js";
import { Visitors } from "../src/visitors.js";
import { NOW } from "./fixtures.js";
import { STRATEGY_VERSION } from "../src/decision.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
const answer = {
  idea: "Patient breakout confirmation",
  rules: "Pick an offered LONG or SHORT when r1h_pct > 0 and fund_z < 1.5. Pick WAIT when confirmation is weak. Pick CLOSE when momentum fails.",
  coins: "ETH,BTC", reason: "Recent waits justify comparing trend strength before choosing an offered entry.",
  quip: "DARK Wall-E, sharpen your signals before sharpening your claws.",
  note: "Your cat has more patience than evidence so far. Test this idea without mistaking a short sample for an edge.",
};
function observations(db: Db, cat: BeeId, now: number, count = 31) {
  const barMs = (cat === "tiger" ? 15 : 240) * 60_000;
  for (let i = 0; i < count; i++) db.insertDecision({
    bee: cat, ts: now - count * barMs + i * barMs, stateHash: null, stateJson: null,
    menuJson: JSON.stringify({ WAIT: {} }), choice: "WAIT", probabilities: { WAIT: 1 }, confidence: 1, conviction: 0,
    latencyMs: 5, inputTokens: 10, jevCostUsd: 0, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "WAIT",
    auditJson: JSON.stringify({ source: "model_request", strategyVersion: STRATEGY_VERSION, entryDiagnostics: [{ coin: "BTC", blockers: ["minTrendScore"] }] }),
  });
}
const envelope = (a: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(a) }, finish_reason: "stop" }] }));
function harness(options: { answer?: unknown; seed?: boolean; enabled?: boolean; autoApply?: boolean; hasPosition?: () => boolean; startAt?: number } = {}) {
  let now = options.startAt ?? NOW;
  // Existing automatic-path fixtures opt in explicitly; production defaults to advisory.
  const config = () => loadConfig({ AI_GATEWAY_API_KEY: "private-gateway-key", COACH_ADMIN_TOKEN: "owner-secret-12345678901234567890", COACH_ENABLED: options.enabled === false ? "false" : "true", COACH_AUTO_APPLY: options.autoApply === false ? "false" : "true" });
  const cfg = config(), db = new Db(":memory:"); cleanups.push(() => db.close());
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const data = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    return envelope(options.answer ?? { ...answer, quip: `${data.cat.name}, sharpen your signals before sharpening your claws.` });
  });
  const changed = vi.fn();
  const deps = { cfg, db, fetch: fetcher as unknown as typeof fetch, now: () => now, context: () => ({ position: options.hasPosition?.() ? {coin:"BTC",side:"long"} : null }),
    universe: () => ({ coins: [{ coin: "BTC", marketEligible: true }] }), closed: () => false, changed };
  const coach = new CatCoach(deps);
  if (options.seed !== false) observations(db, "tiger", now);
  return { cfg, config, db, fetcher, coach, deps, changed, advance: (ms: number) => { now += ms; }, now: () => now };
}
describe("rules and coins trainer", () => {
  it("sends both scorecards, the observable vocabulary and real universe without secrets or fabricated viewer cats", async () => {
    const h = harness(); await h.coach.tick();
    const payload = JSON.parse(String(h.fetcher.mock.calls[0]![1].body));
    const data = JSON.parse(payload.messages[1].content);
    expect(payload.response_format.json_schema.schema.required).toEqual(["idea", "rules", "coins", "reason", "quip", "note", "parameterChanges"]);
    expect(data.cat).toMatchObject({ name: "DARK Wall-E", allowedCoins: [...BIZZY_BREAKOUT_COINS] });
    expect(data.scorecard).toHaveLength(2); expect(data.viewerCats).toBeNull();
    expect(data.universe.coins[0]).toMatchObject({ coin: "BTC", marketEligible: true });
    expect(JSON.stringify(payload)).not.toContain("private-gateway-key");
    expect(payload.messages[0].content).toContain("4 hours");
    const f = riskFixture();
    expect(Object.keys(trainerPlaybook(f.cfg)[0]!.observables).sort()).toEqual(Object.keys(f.brain.coinSnapshot(f.s, f.ctx)).sort());
  });
  it("automatically applies validated rules/coins, persists on restart and restores originals without orders", async () => {
    const h = harness(), original = coachValues(h.cfg, "tiger"), limits = structuredClone(h.cfg.cats);
    await h.coach.tick(); const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("accepted");
    expect(coachValues(h.cfg, "tiger")).toMatchObject({ rules: answer.rules, coins: ["BTC", "ETH"] });
    expect(h.cfg.cats).toEqual(limits); expect(h.changed).toHaveBeenCalledWith("tiger");
    expect(() => h.coach.resolve(entry.id, "accept")).toThrow(/no longer/);
    const newCfg = h.config(), restarted = new CatCoach({ ...h.deps, cfg: newCfg });
    expect(newCfg.slots.tiger.rules).toBe(answer.rules);
    restarted.reset("tiger"); expect(coachValues(newCfg, "tiger")).toEqual(original);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it("approved coins filter the actual menu and rules reach Jev without bypassing fixed gates", async () => {
    const h = harness({ answer: { ...answer, coins: "ETH" } }); await h.coach.tick();
    const f = riskFixture(); f.cfg.slots.tiger = h.cfg.slots.tiger;
    let brain = catBrain("tiger", f.cfg);
    expect(brain.strategy).toContain(answer.rules);
    expect(brain.menu(f.ctx).LONG_BTC).toBeUndefined();
    f.cfg.slots.tiger.coins = ["BTC"]; brain = catBrain("tiger", f.cfg);
    expect(brain.menu(f.ctx).LONG_BTC).toBeDefined();
    f.s.ret1hPct = 0;
    expect(brain.menu(f.ctx).LONG_BTC).toBeUndefined();
  });
  it("treats empty coins as all baseline-allowed coins, even after a previous restriction", async () => {
    const h = harness({ answer: { ...answer, coins: "" } });
    h.cfg.slots.tiger.coins = ["BTC"];
    await h.coach.tick();
    expect(h.cfg.slots.tiger.coins).toEqual([...BIZZY_BREAKOUT_COINS]);
  });
  it("uses a rolling 4-hour minimum cooldown and requires fresh bar evidence after a change across restart", async () => {
    const h = harness({ startAt: Date.UTC(2026, 8, 24, 1) });
    await Promise.all([h.coach.tick(), h.coach.tick()]);
    h.advance(COACH_INTERVAL_MS - 1); observations(h.db, "tiger", h.now());
    await new CatCoach({ ...h.deps, cfg: h.config() }).tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.advance(1); await h.coach.tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.advance(COACH_INTERVAL_MS); observations(h.db,"tiger",h.now());
    await h.coach.tick(); expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().entries.map(e => e.day)).toEqual(["2026-09-24", "2026-09-24"]);
  });
  it("waits for fresh evidence after applying changes and records an unchanged review without rewriting", async () => {
    const h = harness(); await h.coach.tick();
    expect(h.coach.state().cats[0]?.nextReviewAt).toBe(h.now() + COACH_INTERVAL_MS);
    h.advance(COACH_INTERVAL_MS - 1); observations(h.db, "tiger", h.now()); await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.advance(COACH_INTERVAL_MS + 1); observations(h.db,"tiger",h.now()); await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("no_change");
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.coach.state().cats[0]?.acceptedCount).toBe(1);
  });
  it("allows rules/coins coaching while positioned, without placing an order", async () => {
    const h = harness({hasPosition:()=>true}); await h.coach.tick();
    const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("accepted");
    expect(h.cfg.slots.tiger.rules).toBe(answer.rules);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it.each(["settings", "closed", "stopped"])("expires a review if %s changes during the request", async (change) => {
    const h = harness();
    h.fetcher.mockImplementationOnce(async () => {
      if (change === "settings") h.cfg.slots.tiger.rules += " Extra rule.";
      if (change === "closed") h.deps.closed = () => true;
      if (change === "stopped") void h.coach.stop();
      return envelope(answer);
    });
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("expired");
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.cfg.slots.tiger.rules).not.toBe(answer.rules);
  });
  it("counts rules-only waiting observations and reports empty-menu waits and blockers", async () => {
    const h = harness();
    h.db.raw.prepare("UPDATE decisions SET choice=NULL, menu_json='{}', audit_json=?").run(JSON.stringify({source:"rules",strategyVersion:STRATEGY_VERSION,entryDiagnostics:[{coin:"BTC",blockers:["breakout_not_reached"]}]}));
    await h.coach.tick();
    const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("accepted");
    expect(entry.evidence).toMatchObject({summary:{decisions:31,waits:31,waitOnly:31},blockers:[{reason:"breakout_not_reached",decisions:31}]});
  });
  it("runs automatically without an owner token", async () => {
    const h = harness(); h.cfg.coach.adminToken = undefined;
    await h.coach.tick(); expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(h.coach.state()).toMatchObject({automatic:true,approvalMessage:null});
  });
  it("expires manual-era pending suggestions on upgrade without applying them", async () => {
    const h = harness(); await h.coach.tick();
    h.db.raw.exec("DELETE FROM coach_rule_overrides; UPDATE coach_reviews SET status='pending',resolved_at=NULL;");
    h.db.setMeta("coach_automation_version", "0");
    const cfg = h.config(), coach = new CatCoach({...h.deps,cfg});
    expect(coach.state().entries[0]?.status).toBe("expired");
    expect(cfg.slots.tiger.rules).not.toBe(answer.rules);
  });
  it.each([
    { coins: "BTC,NOTACOIN" }, { coins: "BTC,BTC" }, { coins: "btc" }, { quip: null },
    { rules: "One sentence." }, { rules: "Pick WAIT. Pick LONG_BTC. Pick HOLD. Pick CLOSE. Pick WAIT again." },
    { rules: "Pick LONG_BTC above $100. Pick WAIT otherwise." }, { rules: "Pick WAIT 👀. Pick CLOSE." },
    { rules: "A".repeat(401) }, { quip: 123 }, { note: "One sentence." },
    { stopRiskPct: 10 },
  ])("rejects invalid proposals without mutating settings: %j", async (patch) => {
    const h = harness({ answer: { ...answer, ...patch } }), before = structuredClone(h.cfg);
    await h.coach.tick(); expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(h.cfg).toEqual(before);
    const attempts = h.fetcher.mock.calls.length;
    expect(attempts).toBeLessThanOrEqual(2);
    await h.coach.tick(); expect(h.fetcher).toHaveBeenCalledTimes(attempts);
  });
  it("allows coin-only updates and applies each cat's own coin whitelist", async () => {
    const h = harness({ answer: { ...answer, rules: loadConfig({}).slots.tiger.rules } });
    await h.coach.tick(); expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(h.cfg.slots.tiger.coins).toEqual(["BTC", "ETH"]);
    const good = harness({ seed: false, answer: { ...answer, quip: "Good Wall-E, mind those paws.", coins: "SOL" } });
    observations(good.db, "mochi", good.now()); await good.coach.tick();
    expect(good.coach.state().entries[0]?.status).toBe("failed");
  });
  it("requires observations, reports progress and supports separate reviews for both cats", async () => {
    const h = harness({ seed: false }); await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    observations(h.db, "tiger", h.now(), 10);
    expect(h.coach.state().cats[0]).toMatchObject({ phase: "gathering", observations: 10, observedMinutes: 150 });
    observations(h.db, "tiger", h.now(), 30); observations(h.db, "mochi", h.now());
    await h.coach.tick(); expect(h.coach.state().entries.map(e => e.status)).toEqual(["accepted", "accepted"]);
    expect(h.coach.state().cats[0]?.phase).toBe("scheduled");
  });
  it("requires an hour even if decisions are frequent and respects disabled coaching", async () => {
    const h = harness(); h.db.raw.prepare("UPDATE decisions SET ts=?").run(h.now() - 20 * 60000);
    await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().cats[0]?.observations).toBe(1);
    expect(h.coach.state().cats[0]?.nextReviewAt).toBe(h.now() + 40 * 60000);
    const off = harness({ enabled: false }); await off.coach.tick(); expect(off.fetcher).not.toHaveBeenCalled();
    expect(off.coach.state().cats[0]?.phase).toBe("paused");
  });
  it("can review Good after 30 distinct four-hour observations within seven days", async () => {
    const h = harness({seed:false,autoApply:false});
    observations(h.db,"mochi",h.now(),29);
    await h.coach.tick();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().cats[1]).toMatchObject({phase:"gathering",observations:29});
    // The overlapping 29 observations remain one episode each; the earlier thirtieth completes the sample.
    observations(h.db,"mochi",h.now(),30);
    await h.coach.tick();
    expect(h.coach.state()).toMatchObject({evidenceWindowMs:7*24*3600000});
    expect(h.coach.state().entries[0]).toMatchObject({cat:"mochi",status:"advisory",evidence:{summary:{decisions:30}}});
    expect(h.coach.state().cats[1]?.observedMinutes).toBe(30*240);
  });
  it("excludes old samples and protection pulses without counting duplicate bar decisions twice", async () => {
    const h = harness({seed:false,autoApply:false});
    observations(h.db,"tiger",h.now()-COACH_EVIDENCE_WINDOW_MS-1);
    observations(h.db,"tiger",h.now(),29);
    observations(h.db,"tiger",h.now(),29);
    const latest = h.db.raw.prepare("SELECT MAX(id) AS id FROM decisions").get() as {id:number};
    observations(h.db,"tiger",h.now(),31);
    h.db.raw.prepare("UPDATE decisions SET audit_json=json_set(audit_json,'$.source','protection') WHERE id>?").run(latest.id);
    await h.coach.tick();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().cats[0]?.observations).toBe(29);
  });
  it("does not use between-bar profit reviews as new entry-strategy evidence", async () => {
    const h = harness({seed:false,autoApply:false});
    observations(h.db,"tiger",h.now(),29);
    const latest = h.db.raw.prepare("SELECT MAX(id) AS id FROM decisions").get() as {id:number};
    observations(h.db,"tiger",h.now(),35);
    h.db.raw.prepare("UPDATE decisions SET audit_json=json_set(audit_json,'$.decisionKind','profit_review'), choice='CLOSE_PROFIT' WHERE id>?").run(latest.id);
    await h.coach.tick();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().cats[0]?.observations).toBe(29);
  });
  it("requires 30 new Good signal bars after an applied change and again after reset", async () => {
    const h = harness({seed:false}); observations(h.db,"mochi",h.now(),30);
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(h.coach.state().cats[1]?.observations).toBe(0);
    h.advance(COACH_INTERVAL_MS); observations(h.db,"mochi",h.now(),1);
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.coach.state().cats[1]).toMatchObject({phase:"gathering",observations:1});
    h.advance(30 * COACH_INTERVAL_MS); observations(h.db,"mochi",h.now(),30);
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().entries[0]?.status).toBe("no_change");
    h.coach.reset("mochi");
    expect(h.coach.state().cats[1]?.observations).toBe(0);
    h.advance(COACH_INTERVAL_MS); observations(h.db,"mochi",h.now(),1);
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().cats[1]?.observations).toBe(1);
  });
  it("preserves explicit rule edits on restart over an old overlay", async () => {
    const h = harness(); await h.coach.tick();
    const cfg = h.config(); cfg.slots.tiger.rules = "Pick WAIT. Review the trend.";
    const restarted = new CatCoach({ ...h.deps, cfg });
    expect(cfg.slots.tiger.rules).toBe("Pick WAIT. Review the trend.");
    expect(restarted.state().cats[0]?.activeReviewId).toBeNull();
  });
  it("restores the expanded universe when an overlay was saved against the old four-coin baseline", async () => {
    const h = harness(); await h.coach.tick();
    const baseline = coachValues(h.config(), "tiger"); baseline.coins = ["BTC", "ETH", "SOL", "HYPE"];
    h.db.raw.prepare("UPDATE coach_rule_overrides SET baseline_json=? WHERE cat='tiger'").run(JSON.stringify(baseline));
    const cfg = h.config(), coach = new CatCoach({...h.deps,cfg});
    expect(cfg.slots.tiger.coins).toEqual([...BIZZY_BREAKOUT_COINS]);
    expect(coach.state().cats[0]?.activeReviewId).toBeNull();
    expect(coach.state().entries).toHaveLength(1);
  });
  it("retires both incompatible overlays on the configurable-strategy upgrade", async () => {
    const h = harness(); observations(h.db,"mochi",h.now()); await h.coach.tick();
    h.db.setMeta("coach_strategy_version","catfolio-5-source-engine");
    const cfg = h.config(), restarted = new CatCoach({...h.deps,cfg});
    expect(restarted.state().cats[0]?.activeReviewId).toBeNull();
    expect(cfg.slots.tiger.rules).toContain("LONG or SHORT");
    expect(restarted.state().cats[1]?.activeReviewId).toBeNull();
    expect(cfg.slots.mochi.rules).not.toBe(answer.rules);
  });
  it("preserves legacy history while retiring replacement-engine overlays and pending patches", async () => {
    const h = harness({ seed: false });
    h.db.raw.exec("DROP TABLE coach_reviews; CREATE TABLE coach_reviews(id INTEGER PRIMARY KEY,cat TEXT NOT NULL,day TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,model TEXT NOT NULL,review TEXT,evidence TEXT NOT NULL,revision TEXT NOT NULL,resolved_at INTEGER,UNIQUE(cat,day));");
    const review = { diagnosis: "Legacy", rationale: "Legacy", tradeoff: "Legacy", change: { field: "minTrendScore", from: 3, to: 2 } };
    h.db.raw.prepare("INSERT INTO coach_reviews VALUES(42,'tiger','2026-09-24',?,'pending','old',?,'{}','old',NULL)").run(h.now(), JSON.stringify(review));
    const baseline = { minTrendScore: 3, minActionProbability: 0.55, minConviction: 1 };
    h.db.raw.prepare("INSERT INTO coach_overrides VALUES('tiger',41,?,?)").run(JSON.stringify({ ...baseline, minTrendScore: 2 }), JSON.stringify(baseline));
    h.db.setMeta("coach_strategy_version", "catfolio-3-intraday");
    const restarted = new CatCoach(h.deps);
    expect(restarted.state().entries[0]).toMatchObject({ id: 42, status: "expired", review });
    expect(h.cfg.cats.tiger.minConviction).toBe(1);
    expect(() => restarted.resolve(42, "accept")).toThrow(/no longer/);
    h.advance(2 * COACH_INTERVAL_MS); observations(h.db, "tiger", h.now()); await restarted.tick();
    expect(restarted.state().entries[0]?.status).toBe("accepted");
    expect(restarted.state().entries).toHaveLength(2);
  });
  it("records provider failure safely and closes interrupted reviews on restart", async () => {
    const h = harness(); h.fetcher.mockRejectedValueOnce(new Error("private-gateway-key"));
    await h.coach.tick(); expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(JSON.stringify(h.coach.state())).not.toContain("private-gateway-key");
    h.db.raw.prepare("UPDATE coach_reviews SET status='reviewing'").run();
    const restarted = new CatCoach({ ...h.deps, cfg: h.config() });
    expect(restarted.state().entries[0]?.error).toContain("restarted");
    await restarted.tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[401, "credential"], [402, "credit"], [429, "rate-limited"], [500, "unsuccessful"]])("reports provider HTTP %i safely", async (status, expected) => {
    const h = harness(); h.fetcher.mockResolvedValueOnce(new Response("private-gateway-key", { status: Number(status) }));
    await h.coach.tick(); expect(h.coach.state().entries[0]?.error).toContain(expected);
    expect(JSON.stringify(h.coach.state())).not.toContain("private-gateway-key");
  });
  it("rejects the old threshold schema and enforces exact six-field output", () => {
    expect(CoachAnswer.safeParse(answer).success).toBe(true);
    expect(CoachAnswer.safeParse({ ...answer, change: null }).success).toBe(false);
  });
  it("repairs an invalid field once using the same evidence and applies only the valid replacement", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(envelope({ ...answer, note: "Only one sentence." }));
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    const requests = h.fetcher.mock.calls.map(call => JSON.parse(String(call[1].body)));
    expect(requests[1].messages[1]).toEqual(requests[0].messages[1]);
    expect(requests[1].messages[2].content).toContain("note: Exactly two sentences");
    expect(h.coach.state().entries).toHaveLength(1);
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(h.changed).toHaveBeenCalledTimes(1);
  });
  it("accepts fenced JSON and harmless typography without a second request", async () => {
    const h = harness();
    const formatted = { ...answer, rules: "Pick LONG_BTC when r1h_pct ≥ 0.5.\nPick WAIT otherwise.", quip: "DARK Wall-E, you’re patient—now check your signals." };
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: `\`\`\`json\n${JSON.stringify(formatted)}\n\`\`\`` } }] })));
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(h.cfg.slots.tiger.rules).toBe("Pick LONG_BTC when r1h_pct >= 0.5. Pick WAIT otherwise.");
  });
  it.each([
    "DARK Wall-E, " + "watch your signals carefully. ".repeat(5),
    "tiger, do better.", "", "🐈🐾",
    '“DARK Wall-E, café first… then #signals 🐾.”',
  ])("repairs a cosmetic quip without retrying or changing the proposed strategy: %s", async (quip) => {
    const h = harness({ answer: { ...answer, quip } });
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("accepted");
    const review = CoachAnswer.parse(entry.review);
    expect(review.quip).toContain("DARK Wall-E");
    expect(review.quip.length).toBeLessThanOrEqual(90);
    expect(review.quip).not.toMatch(/[^\x20-\x7E]|["#]/);
    expect(review).toEqual({ ...answer, quip: review.quip });
    expect(coachValues(h.cfg, "tiger")).toMatchObject({rules:answer.rules, coins:["BTC","ETH"]});
    const restarted = new CatCoach({...h.deps, cfg:h.config()});
    expect(restarted.state().entries[0]?.review).toEqual(review);
  });
  it("preserves a valid quip and cleans punctuation without replacing its text", async () => {
    const h = harness(); await h.coach.tick();
    expect(CoachAnswer.parse(h.coach.state().entries[0]?.review).quip).toBe(answer.quip);
    const formatted = harness({answer:{...answer,quip:'“DARK Wall-E, café first… then #signals 🐾.”'}});
    await formatted.coach.tick();
    expect(CoachAnswer.parse(formatted.coach.state().entries[0]?.review).quip).toBe("DARK Wall-E, cafe first... then signals.");
  });
  it("keeps a custom trainer name compatible with the caption limit and required characters", async () => {
    const h = harness();
    h.cfg.slots.tiger.name = '“Café #Cat” ' + "Very Long Name ".repeat(10);
    const name = trainerDisplayName(h.cfg, "tiger");
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name).not.toMatch(/[^\x20-\x7E]|["#]/);
    h.fetcher.mockResolvedValueOnce(envelope({...answer,quip:"Wrong cat."}));
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(CoachAnswer.parse(h.coach.state().entries[0]?.review).quip).toContain(name);
  });
  it("still rejects invalid strategy fields when the quip is repaired", async () => {
    const h = harness({answer:{...answer,quip:"🐈",rules:"Pick WAIT."}}), before=coachValues(loadConfig({}),"tiger");
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(h.coach.state().entries[0]?.error).toContain("rules:");
    expect(coachValues(h.cfg,"tiger")).toEqual(before);
    expect(h.changed).not.toHaveBeenCalled();
  });
  it("does not lose a valid strategy repair when the replacement quip is still too long", async () => {
    const h = harness({answer:{...answer,quip:"DARK Wall-E, " + "take a careful look. ".repeat(10)}});
    h.fetcher.mockResolvedValueOnce(envelope({...answer,note:"Only one sentence."}));
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(CoachAnswer.parse(h.coach.state().entries[0]?.review).quip).toBe("DARK Wall-E, keep your paws on the evidence.");
    expect(h.cfg.slots.tiger.rules).toBe(answer.rules);
    expect(h.changed).toHaveBeenCalledTimes(1);
  });
  it("retries truncated output with more room and never applies the incomplete proposal", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null } }] })));
    await h.coach.tick();
    const requests = h.fetcher.mock.calls.map(call => JSON.parse(String(call[1].body)));
    expect(requests).toHaveLength(2);
    expect(requests[1].max_tokens).toBeGreaterThan(requests[0].max_tokens);
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(h.changed).toHaveBeenCalledTimes(1);
  });
  it("preserves precise safe failure details across restart after one unsuccessful repair", async () => {
    const h = harness({ answer: { ...answer, note: "One sentence.", "private-gateway-key": "secret provider body" } });
    const before = coachValues(h.cfg, "tiger");
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    const state = new CatCoach({ ...h.deps, cfg: h.config() }).state();
    expect(state.entries[0]).toMatchObject({ status: "failed", review: null });
    expect(state.entries[0]?.error).toContain("note: Exactly two sentences");
    expect(state.entries[0]?.error).toContain("automatic repair attempt also failed");
    expect(JSON.stringify(state)).not.toMatch(/private-gateway-key|secret provider body/);
    expect(String(h.fetcher.mock.calls[1]![1].body)).not.toMatch(/private-gateway-key|secret provider body/);
    expect(coachValues(h.cfg, "tiger")).toEqual(before);
    expect(h.changed).not.toHaveBeenCalled();
  });
  it.each([
    ["length", null, "output limit", 2],
    ["stop", "{broken", "not valid JSON", 2],
    ["content_filter", null, "completed review message", 1],
  ])("reports the specific %s response failure without saving raw text", async (finish, content, error, attempts) => {
    const h = harness();
    h.fetcher.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] })));
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(Number(attempts));
    expect(h.coach.state().entries[0]?.error).toContain(String(error));
    expect(h.changed).not.toHaveBeenCalled();
  });
  it("checks the coin whitelist after repairing formatting", async () => {
    const h = harness({ answer: { ...answer, coins: "BTC,NOTACOIN" } });
    h.fetcher.mockResolvedValueOnce(envelope({ ...answer, note: "One sentence." }));
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(h.changed).not.toHaveBeenCalled();
  });
  it("expires a malformed response instead of requesting a repair after settings change", async () => {
    const h = harness();
    h.fetcher.mockImplementationOnce(async () => {
      h.cfg.slots.tiger.rules += " Keep waiting.";
      return envelope({ ...answer, note: "One sentence." });
    });
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.coach.state().entries[0]?.status).toBe("expired");
    expect(h.changed).not.toHaveBeenCalled();
  });
  it("excludes retired, unidentified and future observations from readiness and the review evidence", async () => {
    const h = harness();
    h.db.raw.exec(`UPDATE decisions SET audit_json=json_set(audit_json,'$.strategyVersion','catfolio-3-intraday'), status='old_strategy';
      INSERT INTO orders(decision_id,bee,ts,cl_ord_id,inst_id,side,contracts,reduce_only,purpose,state)
      SELECT id,bee,ts,'old-order','BTC','buy',1,0,'open','filled' FROM decisions ORDER BY id LIMIT 1;`);
    observations(h.db, "tiger", h.now());
    h.db.raw.exec("UPDATE decisions SET audit_json=json_remove(audit_json,'$.strategyVersion') WHERE status!='old_strategy'");
    await h.coach.tick();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().cats[0]?.observations).toBe(0);
    observations(h.db, "tiger", h.now() + COACH_EVIDENCE_WINDOW_MS + 24 * 3600000);
    await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    observations(h.db, "tiger", h.now());
    h.db.raw.prepare(`UPDATE decisions SET audit_json=json_set(audit_json,'$.entryDiagnostics',json(?)) WHERE json_extract(audit_json,'$.strategyVersion')=?`).run(JSON.stringify([{coin:"BTC",blockers:["momentum_not_confirmed"]}]), STRATEGY_VERSION);
    h.db.raw.prepare(`INSERT INTO orders(decision_id,bee,ts,cl_ord_id,inst_id,side,contracts,reduce_only,purpose,state)
      SELECT id,bee,ts,'current-order','BTC','buy',1,0,'open','filled' FROM decisions WHERE ts<=? AND json_extract(audit_json,'$.strategyVersion')=? ORDER BY id DESC LIMIT 1`).run(h.now(), STRATEGY_VERSION);
    await h.coach.tick();
    const evidence = h.coach.state().entries[0]?.evidence;
    expect(evidence).toMatchObject({ strategyVersions:[STRATEGY_VERSION], excludedObservations:62,
      summary:{decisions:31,waits:31}, entries:{count:1}, blockers:[{reason:"momentum_not_confirmed",decisions:31}] });
    expect(JSON.stringify(evidence)).not.toMatch(/minTrendScore|old_strategy/);
  });
  it("excludes both legacy strategies from current trainer evidence", async () => {
    const h = harness(); observations(h.db,"mochi",h.now());
    h.db.raw.exec("UPDATE decisions SET audit_json=json_set(audit_json,'$.strategyVersion','catfolio-5-source-engine')");
    await h.coach.tick();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().entries).toHaveLength(0);
    expect(h.coach.state().cats[0]?.observations).toBe(0);
    expect(h.coach.state().cats[1]?.observations).toBe(0);
  });
  it("publishes automatic decisions and still requires owner authorization to restore originals", async () => {
    const h = harness(); await h.coach.tick();
    const server = startServer({ profile: () => ({}), engine: { db: h.db, bus: new EventBus(h.db), visitors: new Visitors(h.db), snapshot: () => ({}), health: () => ({ ok: true }), coach: h.coach, coachAdminToken: h.cfg.coach.adminToken } }, 0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
    const state = await (await fetch(`${url}/coach`)).text();
    expect(state).not.toContain("private-gateway-key"); expect(state).not.toContain(h.cfg.coach.adminToken);
    const post = (token?: string) => fetch(`${url}/coach/reset`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ cat: "tiger" }) });
    expect((await post()).status).toBe(401); expect((await post("wrong")).status).toBe(401);
    expect(h.cfg.slots.tiger.rules).toBe(answer.rules);
    expect((await post(h.cfg.coach.adminToken)).status).toBe(200); expect(h.cfg.slots.tiger.rules).not.toBe(answer.rules);
    expect((await post(h.cfg.coach.adminToken)).status).toBe(409);
    expect((await fetch(`${url}/coach/reset`, { method: "OPTIONS" })).status).toBe(405);
  });
});

describe("bounded numeric trainer changes", () => {
  function numericHarness(patch: {field:string;from:number;to:number} = {field:"minConviction",from:1,to:0.75}, options: { trades?: number; grossPerTrade?: number; autoApply?: boolean } = {}) {
    const h=harness({answer:{...answer,parameterChanges:[patch]},autoApply:options.autoApply});
    h.db.raw.exec(`UPDATE decisions SET choice='LONG_BTC', conviction=0.8, probabilities_json='{"LONG_BTC":0.8}',
      vetoed_by='weak_conviction p=0.80 c=0.8',
      audit_json=json_set(audit_json,'$.config.openGate.minConviction',1,'$.config.openGate.minProb',0.55)`);
    h.deps.context=()=>({position:null,diagnostics:[{blockers:[],indicatorsAgeMs:1000,maxIndicatorsAgeMs:180000}]});
    for (let i = 0; i < (options.trades ?? 5); i++) {
      for (const reducing of [false, true]) {
        const ts = h.now() - 900000 + i * 60000 + (reducing ? 30000 : 0);
        const orderId = h.db.insertOrder({decisionId:i+1,bee:"tiger",ts,clOrdId:`numeric-outcome-${i}-${reducing}`,
          instId:"BTC-USDT-SWAP",side:reducing?"sell":"buy",contracts:10,reduceOnly:reducing,purpose:reducing?"close":"open"});
        h.db.updateOrder(orderId,"filled",null,null);
        h.db.insertFill({orderId,bee:"tiger",ts,instId:"BTC-USDT-SWAP",side:reducing?"sell":"buy",contracts:10,
          px:100,notionalUsd:1000,feeUsd:0.1,realisedUsd:reducing?(options.grossPerTrade??2):0});
      }
    }
    return h;
  }
  it("changes a real fractional entry gate, persists it, and restores the owner baseline",async()=>{
    const h=numericHarness();
    const f=riskFixture();f.ctx.cfg=h.cfg;f.ctx.knobs=h.cfg.cats.tiger;
    const proposed={...f.proposal,conviction:0.8};
    expect(f.run(proposed).vetoedBy).toContain("weak_conviction");
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    expect(f.run(proposed).action.kind).toBe("open");
    expect(h.cfg.cats.tiger.minConviction).toBe(0.75);
    expect(h.coach.state().cats[0]?.current.parameters.minConviction).toBe(0.75);
    const cfg=h.config(), restarted=new CatCoach({...h.deps,cfg});
    expect(cfg.cats.tiger.minConviction).toBe(0.75);
    restarted.reset("tiger");
    expect(cfg.cats.tiger.minConviction).toBe(1);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(10); // Only the recorded evidence; coaching places no orders.
  });
  it.each([
    {field:"minConviction",from:1,to:0.5},
    {field:"minConviction",from:0.9,to:0.75},
    {field:"minTrendScore",from:4,to:3},
    {field:"maxLeverage",from:1,to:2},
    {field:"stopRiskPct",from:0.5,to:1},
  ])("rejects unsupported, stale or excessive changes: %j",async patch=>{
    const h=numericHarness(patch), before=structuredClone(h.cfg);
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(h.cfg).toEqual(before);
  });
  it.each(["position", "stale", "missing", "unrelated", "insufficient"])("does not relax a gate with %s evidence",async kind=>{
    const h=numericHarness();
    if(kind==="position")h.deps.context=()=>({position:{coin:"BTC",side:"long"}});
    if(kind==="stale")h.deps.context=()=>({position:null,diagnostics:[{blockers:["stale_indicators"],indicatorsAgeMs:999999,maxIndicatorsAgeMs:180000}]});
    if(kind==="missing")h.deps.context=()=>({position:null});
    if(kind==="unrelated")h.db.raw.exec("UPDATE decisions SET vetoed_by='stale_market_data'");
    if(kind==="insufficient")h.db.raw.exec("DELETE FROM decisions WHERE id > 29");
    await h.coach.tick();
    // Readiness itself prevents a review when there are fewer than 30 observations.
    expect(h.coach.state().entries[0]?.status).not.toBe("accepted");
    expect(h.cfg.cats.tiger.minConviction).toBe(1);
  });
  it("requires completed trades for tightening a gate, not just many decisions",async()=>{
    const h=numericHarness({field:"minConviction",from:1,to:1.25},{trades:0});
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(h.cfg.cats.tiger.minConviction).toBe(1);
  });
  it.each([4, 5])("uses complete round trips, not partial trims or old strategies, for %i-trade evidence", async count => {
    const h = numericHarness({field:"minConviction",from:1,to:1.25},{trades:0});
    let sequence = 0;
    const fill = (decisionId:number, purpose:string, contracts:number, realised:number, orderId?:number) => {
      const ts = h.now() - 120000 + sequence++;
      const reducing = purpose !== "open";
      const id = orderId ?? h.db.insertOrder({decisionId,bee:"tiger",ts,clOrdId:`evidence-${sequence}`,
        instId:"BTC-USDT-SWAP",side:reducing?"sell":"buy",contracts,reduceOnly:reducing,purpose});
      h.db.updateOrder(id,"filled",null,null);
      h.db.insertFill({orderId:id,bee:"tiger",ts,instId:"BTC-USDT-SWAP",side:reducing?"sell":"buy",
        contracts,px:100,notionalUsd:contracts*100,feeUsd:0.1,realisedUsd:realised});
      return id;
    };
    // A split opening fill, trim and final exit are exactly one trade, including every fee.
    for (let i = 0; i < count; i++) {
      const decisionId = i + 3, id = fill(decisionId,"open",4,0);
      fill(decisionId,"open",6,0,id);
      fill(decisionId,"trim",5,1);
      fill(decisionId,"close",5,2);
    }
    h.db.raw.prepare("UPDATE decisions SET audit_json=json_set(audit_json,'$.strategyVersion','old-strategy') WHERE id=2").run();
    fill(2,"open",10,0); fill(2,"close",10,100);
    fill(1,"open",10,0); fill(1,"trim",5,100);
    await h.coach.tick();
    const entry = h.coach.state().entries[0]!;
    expect(entry.evidence).toMatchObject({performance:{closedTrades:count,winners:count,
      netClosedPnlAfterFeesUsd:expect.closeTo(count*2.6,8)}});
    expect(entry.status).toBe(count === 5 ? "accepted" : "failed");
    expect(h.cfg.cats.tiger.minConviction).toBe(count === 5 ? 1.25 : 1);
  });
  it("an explicit environment baseline change supersedes the saved numeric overlay",async()=>{
    const h=numericHarness();await h.coach.tick();
    const cfg=h.config();cfg.cats.tiger.minConviction=1.5;
    const restarted=new CatCoach({...h.deps,cfg});
    expect(cfg.cats.tiger.minConviction).toBe(1.5);
    expect(restarted.state().cats[0]?.activeReviewId).toBeNull();
  });
  it("never accepts more than one numeric change per review",()=>{
    expect(CoachAnswer.safeParse({...answer,parameterChanges:[
      {field:"minConviction",from:1,to:0.75},{field:"minActionProbability",from:0.55,to:0.5}
    ]}).success).toBe(false);
  });

  it.each([0, 4])("does not relax a gate after 31 vetoes with only %i completed trades", async trades => {
    const h = numericHarness(undefined, {trades});
    await h.coach.tick();
    const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("failed");
    expect(entry.evidence).toMatchObject({summary:{weakConviction:31},performance:{closedTrades:trades}});
    expect(h.cfg.cats.tiger.minConviction).toBe(1);
    expect(h.changed).not.toHaveBeenCalled();
  });
  it.each([-1, 0.2])("rejects entry relaxation when five trades have nonpositive net P&L (gross each %s)", async grossPerTrade => {
    const h = numericHarness(undefined, {grossPerTrade});
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(h.cfg.cats.tiger.minConviction).toBe(1);
  });
  it("records a bounded numeric idea as advisory without changing parameters, rules, coins or orders", async () => {
    const h = numericHarness(undefined, {autoApply:false}), before = structuredClone(h.cfg);
    await h.coach.tick();
    expect(h.coach.state().entries[0]).toMatchObject({status:"advisory",review:{parameterChanges:[{field:"minConviction",from:1,to:0.75}]}});
    expect(h.cfg).toEqual(before);
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.db.raw.prepare("SELECT * FROM coach_rule_overrides").all()).toEqual([]);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(10);
  });
  it("does not reuse completed outcomes collected before the last applied change", async () => {
    const h = numericHarness(); await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    const changedAt = h.now();
    h.advance(2 * COACH_INTERVAL_MS); observations(h.db,"tiger",h.now());
    h.fetcher.mockImplementation(async () => envelope({...answer,parameterChanges:[{field:"minConviction",from:0.75,to:0.5}]}));
    await h.coach.tick();
    expect(h.coach.state().entries[0]).toMatchObject({status:"failed",evidence:{since:changedAt,performance:{closedTrades:0}}});
    expect(h.cfg.cats.tiger.minConviction).toBe(0.75);
  });
});

describe("advisory trainer policy", () => {
  it("defaults to advisory and records rules/coin suggestions without mutating strategy settings", async () => {
    expect(loadConfig({}).coach.autoApply).toBe(false);
    const h = harness({autoApply:false}), before = structuredClone(h.cfg);
    await h.coach.tick();
    const state = h.coach.state(), entry = state.entries[0]!;
    expect(state).toMatchObject({autoApply:false,automatic:true,approvalMessage:null});
    expect(entry).toMatchObject({status:"advisory",review:{rules:answer.rules,coins:answer.coins}});
    expect(entry.resolvedAt).toBe(h.now());
    expect(state.cats[0]).toMatchObject({activeReviewId:null,acceptedCount:0,phase:"scheduled"});
    expect(h.cfg).toEqual(before);
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.db.raw.prepare("SELECT * FROM coach_rule_overrides").all()).toEqual([]);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toEqual([]);
    expect(() => h.coach.resolve(entry.id,"accept")).toThrow(/Advisory/);
    const payload = JSON.parse(String(h.fetcher.mock.calls[0]![1].body));
    expect(payload.messages[0].content).toContain("Current trainer policy: ADVISORY");
    expect(JSON.parse(payload.messages[1].content).trainerPolicy).toEqual({autoApply:false,mode:"advisory"});
  });
  it("continues scheduled advisory reviews and never replays a suggestion when automatic mode is enabled", async () => {
    const h = harness({autoApply:false}); await h.coach.tick();
    h.advance(COACH_INTERVAL_MS); observations(h.db,"tiger",h.now()); await h.coach.tick();
    expect(h.coach.state().entries.map(entry=>entry.status)).toEqual(["advisory","advisory"]);
    const cfg = h.config(); cfg.coach.autoApply = true;
    const restarted = new CatCoach({...h.deps,cfg});
    expect(cfg.slots.tiger.rules).not.toBe(answer.rules);
    expect(restarted.state().cats[0]?.activeReviewId).toBeNull();
    expect(h.changed).not.toHaveBeenCalled();
  });
  it("retires saved automatic overlays when restarted in advisory mode", async () => {
    const h = harness(); await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("accepted");
    const cfg = h.config(); cfg.coach.autoApply = false;
    const baseline = coachValues(cfg,"tiger"), restarted = new CatCoach({...h.deps,cfg});
    expect(coachValues(cfg,"tiger")).toEqual(baseline);
    expect(restarted.state().entries[0]?.status).toBe("rolled_back");
    expect(restarted.state().cats[0]?.activeReviewId).toBeNull();
    expect(h.db.raw.prepare("SELECT * FROM coach_rule_overrides").all()).toEqual([]);
    const automatic = h.config(); new CatCoach({...h.deps,cfg:automatic});
    expect(coachValues(automatic,"tiger")).toEqual(baseline);
  });
  it("expires an in-flight automatic review when policy changes", async () => {
    const h = harness();
    h.fetcher.mockImplementationOnce(async () => { h.cfg.coach.autoApply = false; return envelope(answer); });
    await h.coach.tick();
    expect(h.coach.state().entries[0]?.status).toBe("expired");
    expect(h.cfg.slots.tiger.rules).not.toBe(answer.rules);
    expect(h.changed).not.toHaveBeenCalled();
  });
});
