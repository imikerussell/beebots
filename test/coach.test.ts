import { afterEach, describe, expect, it, vi } from "vitest";
import { BIZZY_BREAKOUT_COINS } from "../src/bees/bizzy.js";
import { CatCoach, CoachAnswer, COACH_INTERVAL_MS, coachValues } from "../src/coach.js";
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
  for (let i = 0; i < count; i++) db.insertDecision({
    bee: cat, ts: now - 3600000 + i * 60000, stateHash: null, stateJson: null,
    menuJson: JSON.stringify({ WAIT: {} }), choice: "WAIT", probabilities: { WAIT: 1 }, confidence: 1, conviction: 0,
    latencyMs: 5, inputTokens: 10, jevCostUsd: 0, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "WAIT",
    auditJson: JSON.stringify({ source: "model_request", strategyVersion: STRATEGY_VERSION, entryDiagnostics: [{ coin: "BTC", blockers: ["minTrendScore"] }] }),
  });
}
const envelope = (a: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(a) }, finish_reason: "stop" }] }));
function harness(options: { answer?: unknown; seed?: boolean; enabled?: boolean; hasPosition?: () => boolean; startAt?: number } = {}) {
  let now = options.startAt ?? NOW;
  const config = () => loadConfig({ AI_GATEWAY_API_KEY: "private-gateway-key", COACH_ADMIN_TOKEN: "owner-secret-12345678901234567890", COACH_ENABLED: options.enabled === false ? "false" : "true" });
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
    expect(payload.response_format.json_schema.schema.required).toEqual(["idea", "rules", "coins", "reason", "quip", "note"]);
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
    expect(coachValues(h.cfg, "tiger")).toEqual({ rules: answer.rules, coins: ["BTC", "ETH"] });
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
  it("uses a rolling 4-hour cooldown, permits two attempts on one UTC date, and survives restart", async () => {
    const h = harness({ startAt: Date.UTC(2026, 8, 24, 1) });
    await Promise.all([h.coach.tick(), h.coach.tick()]);
    h.advance(COACH_INTERVAL_MS - 1); observations(h.db, "tiger", h.now());
    await new CatCoach({ ...h.deps, cfg: h.config() }).tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.advance(1); await h.coach.tick(); expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().entries.map(e => e.day)).toEqual(["2026-09-24", "2026-09-24"]);
  });
  it("waits four hours after applying changes and records an unchanged review without rewriting", async () => {
    const h = harness(); await h.coach.tick();
    expect(h.coach.state().cats[0]?.nextReviewAt).toBe(h.now() + COACH_INTERVAL_MS);
    h.advance(COACH_INTERVAL_MS - 1); observations(h.db, "tiger", h.now()); await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.advance(1); await h.coach.tick();
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
    expect(h.coach.state().cats[0]).toMatchObject({ phase: "gathering", observations: 10, observedMinutes: 60 });
    observations(h.db, "tiger", h.now(), 20); observations(h.db, "mochi", h.now());
    await h.coach.tick(); expect(h.coach.state().entries.map(e => e.status)).toEqual(["accepted", "accepted"]);
    expect(h.coach.state().cats[0]?.phase).toBe("scheduled");
  });
  it("requires an hour even if decisions are frequent and respects disabled coaching", async () => {
    const h = harness(); h.db.raw.prepare("UPDATE decisions SET ts=?").run(h.now() - 20 * 60000);
    await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().cats[0]?.nextReviewAt).toBe(h.now() + 40 * 60000);
    const off = harness({ enabled: false }); await off.coach.tick(); expect(off.fetcher).not.toHaveBeenCalled();
    expect(off.coach.state().cats[0]?.phase).toBe("paused");
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
  it("retires only Dark's old strategy overlay while preserving Good's rules on the active upgrade", async () => {
    const h = harness(); observations(h.db,"mochi",h.now()); await h.coach.tick();
    h.db.setMeta("coach_strategy_version","catfolio-5-source-engine");
    const cfg = h.config(), restarted = new CatCoach({...h.deps,cfg});
    expect(restarted.state().cats[0]?.activeReviewId).toBeNull();
    expect(cfg.slots.tiger.rules).toContain("LONG or SHORT");
    expect(restarted.state().cats[1]?.activeReviewId).not.toBeNull();
    expect(cfg.slots.mochi.rules).toBe(answer.rules);
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
    expect(h.cfg.cats.tiger.minTrendScore).toBe(3);
    expect(() => restarted.resolve(42, "accept")).toThrow(/no longer/);
    h.advance(COACH_INTERVAL_MS); observations(h.db, "tiger", h.now()); await restarted.tick();
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
    expect(coachValues(h.cfg, "tiger")).toEqual({rules:answer.rules, coins:["BTC","ETH"]});
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
    observations(h.db, "tiger", h.now() + 2 * 3600000);
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
  it("retains Good's compatible source-engine observations but excludes Dark's old breakout observations", async () => {
    const h = harness(); observations(h.db,"mochi",h.now());
    h.db.raw.exec("UPDATE decisions SET audit_json=json_set(audit_json,'$.strategyVersion','catfolio-5-source-engine')");
    await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.coach.state().entries[0]?.cat).toBe("mochi");
    expect(h.coach.state().cats[0]?.observations).toBe(0);
    expect(h.coach.state().cats[1]?.observations).toBe(31);
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
