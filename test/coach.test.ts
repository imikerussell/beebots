import { afterEach, describe, expect, it, vi } from "vitest";
import { CatCoach, CoachAnswer, COACH_INTERVAL_MS, coachValues } from "../src/coach.js";
import { loadConfig, type BeeId } from "../src/config.js";
import { Db } from "../src/db.js";
import { catBrain } from "../src/cats.js";
import { trainerPlaybook } from "../src/coach-prompt.js";
import { riskFixture } from "./risk-fixture.js";
import { startServer } from "../src/server.js";
import { EventBus } from "../src/events.js";
import { Visitors } from "../src/visitors.js";
import { NOW } from "./fixtures.js";
const DAY = 86400000;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
const answer = {
  idea: "Patient breakout confirmation",
  rules: "Pick an offered BREAKOUT when r1h_pct > 0 and fund_z < 1.5. Pick WAIT when confirmation is weak. Pick CUT_LOSS when the breakout fails.",
  coins: "ETH,BTC", reason: "Recent waits justify comparing trend strength before choosing an offered entry.",
  quip: "DARK Wall-E, sharpen your signals before sharpening your claws.",
  note: "Your cat has more patience than evidence so far. Test this idea without mistaking a short sample for an edge.",
};
function observations(db: Db, cat: BeeId, now: number, count = 31) {
  for (let i = 0; i < count; i++) db.insertDecision({
    bee: cat, ts: now - 3600000 + i * 60000, stateHash: null, stateJson: null,
    menuJson: JSON.stringify({ WAIT: {} }), choice: "WAIT", probabilities: { WAIT: 1 }, confidence: 1, conviction: 0,
    latencyMs: 5, inputTokens: 10, jevCostUsd: 0, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "WAIT",
    auditJson: JSON.stringify({ source: "model_request", entryDiagnostics: [{ coin: "BTC", blockers: ["minTrendScore"] }] }),
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
    expect(data.cat).toMatchObject({ name: "DARK Wall-E", allowedCoins: ["BTC", "ETH", "SOL", "HYPE"] });
    expect(data.scorecard).toHaveLength(2); expect(data.viewerCats).toBeNull();
    expect(data.universe.coins[0]).toMatchObject({ coin: "BTC", marketEligible: true });
    expect(JSON.stringify(payload)).not.toContain("private-gateway-key");
    expect(payload.messages[0].content).toContain("20 hours");
    const f = riskFixture();
    expect(Object.keys(trainerPlaybook(f.cfg)[0]!.observables).sort()).toEqual(Object.keys(f.brain.coinSnapshot(f.s, f.ctx)).sort());
  });
  it("applies only approved rules/coins, persists on restart and restores originals without orders", async () => {
    const h = harness(), original = coachValues(h.cfg, "tiger"), limits = structuredClone(h.cfg.cats);
    await h.coach.tick(); const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("pending"); expect(coachValues(h.cfg, "tiger")).toEqual(original);
    h.coach.resolve(entry.id, "accept");
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
    h.coach.resolve(h.coach.state().entries[0]!.id, "accept");
    const f = riskFixture(); f.cfg.slots.tiger = h.cfg.slots.tiger;
    let brain = catBrain("tiger", f.cfg);
    expect(brain.strategy).toContain(answer.rules);
    expect(brain.menu(f.ctx).BREAKOUT_BTC).toBeUndefined();
    f.cfg.slots.tiger.coins = ["BTC"]; brain = catBrain("tiger", f.cfg);
    expect(brain.menu(f.ctx).BREAKOUT_BTC).toBeDefined();
    f.s.mid = 98;
    expect(brain.menu(f.ctx).BREAKOUT_BTC).toBeUndefined();
  });
  it("treats empty coins as all baseline-allowed coins, even after a previous restriction", async () => {
    const h = harness({ answer: { ...answer, coins: "" } });
    h.cfg.slots.tiger.coins = ["BTC"];
    await h.coach.tick(); h.coach.resolve(h.coach.state().entries[0]!.id, "accept");
    expect(h.cfg.slots.tiger.coins).toEqual(["BTC", "ETH", "SOL", "HYPE"]);
  });
  it("uses a rolling 20-hour cooldown, permits two attempts on one UTC date, and survives restart", async () => {
    const h = harness({ startAt: Date.UTC(2026, 8, 24, 1) });
    await Promise.all([h.coach.tick(), h.coach.tick()]);
    h.coach.resolve(h.coach.state().entries[0]!.id, "decline");
    h.advance(COACH_INTERVAL_MS - 1); observations(h.db, "tiger", h.now());
    await new CatCoach({ ...h.deps, cfg: h.config() }).tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.advance(1); await h.coach.tick(); expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.coach.state().entries.map(e => e.day)).toEqual(["2026-09-24", "2026-09-24"]);
  });
  it("does not replace a pending review at hour 20 and enforces cooldown from approval", async () => {
    const h = harness(); await h.coach.tick();
    h.advance(COACH_INTERVAL_MS); observations(h.db, "tiger", h.now()); await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.coach.resolve(h.coach.state().entries[0]!.id, "accept");
    expect(h.coach.state().cats[0]?.nextReviewAt).toBe(h.now() + COACH_INTERVAL_MS);
    h.advance(COACH_INTERVAL_MS - 1); observations(h.db, "tiger", h.now()); await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("allows rules/coins coaching while positioned, without placing an order", async () => {
    const h = harness({hasPosition:()=>true}); await h.coach.tick();
    const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("pending");
    h.coach.resolve(entry.id,"accept");
    expect(h.cfg.slots.tiger.rules).toBe(answer.rules);
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it("refuses stale proposals and expires them after 24 hours", async () => {
    const h=harness(); await h.coach.tick(); const id=h.coach.state().entries[0]!.id;
    h.cfg.slots.tiger.rules += " Extra rule.";
    expect(()=>h.coach.resolve(id,"accept")).toThrow(/Settings changed/);
    h.advance(DAY);expect(()=>h.coach.resolve(id,"accept")).toThrow(/no longer/);
  });
  it.each([
    { coins: "BTC,DOGE" }, { coins: "BTC,BTC" }, { coins: "btc" }, { quip: "tiger, do better." },
    { rules: "One sentence." }, { rules: "Pick WAIT. Pick LONG_BTC. Pick HOLD. Pick CLOSE. Pick WAIT again." },
    { rules: "Pick LONG_BTC above $100. Pick WAIT otherwise." }, { rules: "Pick WAIT 👀. Pick CLOSE." },
    { rules: "A".repeat(401) }, { quip: "DARK Wall-E, #try harder." }, { note: "One sentence." },
    { stopRiskPct: 10 },
  ])("rejects invalid proposals without mutating settings: %j", async (patch) => {
    const h = harness({ answer: { ...answer, ...patch } }), before = structuredClone(h.cfg);
    await h.coach.tick(); expect(h.coach.state().entries[0]?.status).toBe("failed");
    expect(h.cfg).toEqual(before); await h.coach.tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects unchanged rules and applies each cat's own coin whitelist", async () => {
    const h = harness({ answer: { ...answer, rules: loadConfig({}).slots.tiger.rules } });
    await h.coach.tick(); expect(h.coach.state().entries[0]?.status).toBe("failed");
    const good = harness({ seed: false, answer: { ...answer, quip: "Good Wall-E, mind those paws.", coins: "SOL" } });
    observations(good.db, "mochi", good.now()); await good.coach.tick();
    expect(good.coach.state().entries[0]?.status).toBe("failed");
  });
  it("requires observations, reports progress and supports separate reviews for both cats", async () => {
    const h = harness({ seed: false }); await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    observations(h.db, "tiger", h.now(), 10);
    expect(h.coach.state().cats[0]).toMatchObject({ phase: "gathering", observations: 10, observedMinutes: 60 });
    observations(h.db, "tiger", h.now(), 20); observations(h.db, "mochi", h.now());
    await h.coach.tick(); expect(h.coach.state().entries.map(e => e.status)).toEqual(["pending", "pending"]);
    expect(h.coach.state().cats[0]?.phase).toBe("awaiting_approval");
  });
  it("requires an hour even if decisions are frequent and respects disabled coaching", async () => {
    const h = harness(); h.db.raw.prepare("UPDATE decisions SET ts=?").run(h.now() - 20 * 60000);
    await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.coach.state().cats[0]?.nextReviewAt).toBe(h.now() + 40 * 60000);
    const off = harness({ enabled: false }); await off.coach.tick(); expect(off.fetcher).not.toHaveBeenCalled();
    expect(off.coach.state().cats[0]?.phase).toBe("paused");
  });
  it("preserves explicit rule edits on restart over an old overlay", async () => {
    const h = harness(); await h.coach.tick(); h.coach.resolve(h.coach.state().entries[0]!.id, "accept");
    const cfg = h.config(); cfg.slots.tiger.rules = "Pick WAIT. Review the trend.";
    const restarted = new CatCoach({ ...h.deps, cfg });
    expect(cfg.slots.tiger.rules).toBe("Pick WAIT. Review the trend.");
    expect(restarted.state().cats[0]?.activeReviewId).toBeNull();
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
    expect(restarted.state().entries[0]?.status).toBe("pending");
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
  it("requires owner authorization and applies approval via the dashboard API", async () => {
    const h = harness(); await h.coach.tick(); const id = h.coach.state().entries[0]!.id;
    const server = startServer({ profile: () => ({}), engine: { db: h.db, bus: new EventBus(h.db), visitors: new Visitors(h.db), snapshot: () => ({}), health: () => ({ ok: true }), coach: h.coach, coachAdminToken: h.cfg.coach.adminToken } }, 0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
    const state = await (await fetch(`${url}/coach`)).text();
    expect(state).not.toContain("private-gateway-key"); expect(state).not.toContain(h.cfg.coach.adminToken);
    const post = (token?: string) => fetch(`${url}/coach/accept`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ id }) });
    expect((await post()).status).toBe(401); expect((await post("wrong")).status).toBe(401);
    expect(h.cfg.slots.tiger.rules).not.toBe(answer.rules);
    expect((await post(h.cfg.coach.adminToken)).status).toBe(200); expect(h.cfg.slots.tiger.rules).toBe(answer.rules);
    expect((await post(h.cfg.coach.adminToken)).status).toBe(409);
    expect((await fetch(`${url}/coach/accept`, { method: "OPTIONS" })).status).toBe(405);
  });
});
