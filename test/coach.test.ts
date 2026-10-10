import { afterEach, describe, expect, it, vi } from "vitest";
import { CatCoach, coachValues } from "../src/coach.js";
import { CATS, loadConfig, type BeeId } from "../src/config.js";
import { Db } from "../src/db.js";
import { catBrain, entryDiagnostics } from "../src/cats.js";
import { riskFixture } from "./risk-fixture.js";
import { startServer } from "../src/server.js";
import { EventBus } from "../src/events.js";
import { Visitors } from "../src/visitors.js";
import { NOW } from "./fixtures.js";
const DAY = 86400000;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
function observations(db: Db, cat: BeeId, now: number, count = 31, blockers = ["minTrendScore"]) {
  for (let i = 0; i < count; i++) db.insertDecision({
    bee: cat, ts: now - 3600000 + i * 60000, stateHash: null, stateJson: null,
    menuJson: JSON.stringify({ WAIT: {} }), choice: "WAIT", probabilities: { WAIT: 1 }, confidence: 1, conviction: 0,
    latencyMs: 5, inputTokens: 10, jevCostUsd: 0, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "WAIT",
    auditJson: JSON.stringify({ source: "model_request", entryDiagnostics: [{ coin: "BTC", blockers }] }),
  });
}
function harness(options: { answer?: unknown; seed?: boolean; enabled?: boolean; hasPosition?: () => boolean } = {}) {
  let now = NOW;
  const cfg = loadConfig({ AI_GATEWAY_API_KEY: "private-gateway-key", COACH_ADMIN_TOKEN: "owner-secret-12345678901234567890", COACH_ENABLED: options.enabled === false ? "false" : "true" });
  const db = new Db(":memory:"); cleanups.push(() => db.close());
  const answer = options.answer ?? { diagnosis: "31 waits; the trend score blocked entry.", rationale: "Try one point lower while keeping the remaining setup checks.", tradeoff: "Weaker trends can increase false signals. Profitability is unproven.", change: { field: "minTrendScore", from: 3, to: 2 } };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }] })));
  const changed = vi.fn();
  const deps = { cfg, db, fetch: fetcher as unknown as typeof fetch, now: () => now, context: () => ({ position: null }), closed: () => false, hasPosition: options.hasPosition, changed };
  const coach = new CatCoach(deps);
  if (options.seed !== false) observations(db, "tiger", now);
  return { cfg, db, fetcher, coach, deps, changed, advance: (ms: number) => { now += ms; }, now: () => now };
}
describe("daily cat coach", () => {
  it("uses the real entry gates for explanations and keeps absent breakouts blocked", () => {
    const h = riskFixture(); h.s.trend!.score = 2;
    expect(entryDiagnostics("tiger", h.ctx)[0]!.blockers).toContain("minTrendScore");
    expect(h.brain.menu(h.ctx).LONG_BTC).toBeUndefined();
    h.cfg.cats.tiger.minTrendScore = 2;
    expect(catBrain("tiger", h.cfg).menu(h.ctx).LONG_BTC).toBeDefined();
    h.s.confirmed15m!.close = 98;
    expect(entryDiagnostics("tiger", h.ctx)[0]!.blockers).toContain("breakout_not_confirmed");
    expect(catBrain("tiger", h.cfg).menu(h.ctx).LONG_BTC).toBeUndefined();
  });
  it("makes an evidenced proposal without changing settings, then accepts once and restores on restart", async () => {
    const h = harness(); await h.coach.tick();
    const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("pending"); expect(h.cfg.cats.tiger.minTrendScore).toBe(3);
    expect(entry.evidence).toMatchObject({ summary: { decisions: 31, waits: 31, waitOnly: 31 }, blockers: [{ reason: "minTrendScore", decisions: 31 }] });
    const payload = JSON.parse((h.fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(JSON.stringify(payload)).not.toContain("private-gateway-key");
    expect(payload.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "cat_coach_review", strict: true } });
    expect((h.fetcher.mock.calls[0] as unknown as [string])[0]).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    const capital = h.cfg.cats.tiger.stopRiskPct;
    h.coach.resolve(entry.id, "accept");
    expect(h.cfg.cats.tiger.minTrendScore).toBe(2); expect(h.cfg.cats.tiger.stopRiskPct).toBe(capital);
    expect(h.cfg.cats.mochi.minTrendScore).toBe(6);
    expect(() => h.coach.resolve(entry.id, "accept")).toThrow(/no longer/);
    const newCfg = loadConfig({});
    const restarted = new CatCoach({ ...h.deps, cfg: newCfg });
    expect(newCfg.cats.tiger.minTrendScore).toBe(2);
    restarted.reset("tiger"); expect(newCfg.cats.tiger.minTrendScore).toBe(3);
    expect(restarted.state().entries[0]!.status).toBe("rolled_back");
    expect(h.db.raw.prepare("SELECT * FROM orders").all()).toHaveLength(0);
  });
  it("declines without changing anything and never calls twice per day, including concurrent ticks and restarts", async () => {
    const h = harness(); await Promise.all([h.coach.tick(), h.coach.tick()]);
    const before = coachValues(h.cfg, "tiger");
    h.coach.resolve(h.coach.state().entries[0]!.id, "decline");
    await new CatCoach(h.deps).tick(); await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(coachValues(h.cfg, "tiger")).toEqual(before);
    h.advance(13 * 3600000); observations(h.db, "tiger", h.now()); await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(1); // crossed UTC midnight, but not 24 hours
    h.advance(11 * 3600000); observations(h.db, "tiger", h.now()); await h.coach.tick();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it("expires old suggestions and refuses proposals against changed settings or an open position", async () => {
    const h = harness(); await h.coach.tick(); const id = h.coach.state().entries[0]!.id;
    h.cfg.cats.tiger.minConviction = 2;
    expect(() => h.coach.resolve(id, "accept")).toThrow(/Settings changed/);
    h.advance(DAY); expect(() => h.coach.resolve(id, "accept")).toThrow(/no longer/);
    expect(h.coach.state().entries[0]!.status).toBe("expired");
    const held = harness({ hasPosition: () => true }); await held.coach.tick();
    expect(held.coach.state().entries[0]!.status).toBe("failed");
  });
  it.each([
    { field: "stopRiskPct", from: 1, to: 10 }, { field: "minTrendScore", from: 3, to: 1 },
    { field: "minTrendScore", from: 3, to: 2.5 }, { field: "minActionProbability", from: 0.55, to: 0.1 },
    { field: "minConviction", from: 1, to: 0 }, // no conviction veto evidence
  ])("rejects invalid or unsupported changes: %j", async (change) => {
    const h = harness({ answer: { diagnosis: "Waits", rationale: "Make more trades", tradeoff: "Risk", change } });
    await h.coach.tick(); expect(h.coach.state().entries[0]!.status).toBe("failed");
    expect(h.cfg.cats.tiger.minTrendScore).toBe(3);
    await h.coach.tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires sufficient evidence and supports a no-change review for each cat", async () => {
    const h = harness({ seed: false, answer: { diagnosis: "Waiting is justified", rationale: "No confirmed setup", tradeoff: "Missed trades are possible", change: null } });
    await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    observations(h.db, "tiger", h.now(), 5); await h.coach.tick(); expect(h.fetcher).not.toHaveBeenCalled();
    for (const cat of CATS) observations(h.db, cat, h.now());
    await h.coach.tick(); expect(h.coach.state().entries.map((e) => e.status)).toEqual(["no_change", "no_change"]);
  });
  it("does not call when disabled and preserves explicit environment threshold changes on restart", async () => {
    const off = harness({ enabled: false }); await off.coach.tick(); expect(off.fetcher).not.toHaveBeenCalled();
    const h = harness(); await h.coach.tick(); h.coach.resolve(h.coach.state().entries[0]!.id, "accept");
    const cfg = loadConfig({ TIGER_MIN_TREND_SCORE: "5" });
    const restarted = new CatCoach({ ...h.deps, cfg });
    expect(cfg.cats.tiger.minTrendScore).toBe(5); expect(restarted.state().cats[0]!.activeReviewId).toBeNull();
  });
  it("keeps provider failures visible without leaking errors or retrying the same day", async () => {
    const h = harness(); h.fetcher.mockRejectedValueOnce(new Error("private-gateway-key"));
    await h.coach.tick();
    expect(h.coach.state().entries[0]!.status).toBe("failed");
    expect(JSON.stringify(h.coach.state())).not.toContain("private-gateway-key");
    await new CatCoach(h.deps).tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("closes interrupted reviews on restart without making another paid request", async () => {
    const h = harness(); await h.coach.tick();
    h.db.raw.prepare("UPDATE coach_reviews SET status='reviewing'").run();
    const restarted = new CatCoach(h.deps);
    expect(restarted.state().entries[0]!.status).toBe("failed");
    await restarted.tick(); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("prevents daily suggestions from cumulatively relaxing past the original bounds", async () => {
    const h = harness(); await h.coach.tick(); h.coach.resolve(h.coach.state().entries[0]!.id, "accept");
    h.advance(DAY); observations(h.db, "tiger", h.now());
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      diagnosis: "Trend still blocked", rationale: "Another point", tradeoff: "False signals", change: { field: "minTrendScore", from: 2, to: 1 },
    }) } }] })));
    await h.coach.tick(); expect(h.coach.state().entries[0]!.status).toBe("failed");
    expect(h.cfg.cats.tiger.minTrendScore).toBe(2);
  });
  it("accepts probability changes only when that threshold caused recorded vetoes", async () => {
    const h = harness({ answer: { diagnosis: "Action probability was below the gate", rationale: "Small threshold adjustment", tradeoff: "Less confident entries", change: { field: "minActionProbability", from: 0.55, to: 0.5 } } });
    h.db.raw.prepare(`UPDATE decisions SET choice='LONG_BTC', probabilities_json=?, conviction=3, vetoed_by='weak_or_invalid_conviction', audit_json=?`).run(
      JSON.stringify({ WAIT: 0.48, LONG_BTC: 0.52 }),
      JSON.stringify({ source: "model_request", entryDiagnostics: [], config: { limits: h.cfg.cats.tiger } }),
    );
    await h.coach.tick(); const entry = h.coach.state().entries[0]!;
    expect(entry.status).toBe("pending"); expect(entry.evidence).toMatchObject({ summary: { weakProbability: 31, weakConviction: 0 } });
    h.coach.resolve(entry.id, "accept"); expect(h.cfg.cats.tiger.minActionProbability).toBe(0.5);
  });
  it("requires owner authorization for mutations, serves no secrets, and applies an authenticated dashboard approval", async () => {
    const h = harness(); await h.coach.tick(); const id = h.coach.state().entries[0]!.id;
    const server = startServer({ profile: () => ({}), engine: { db: h.db, bus: new EventBus(h.db), visitors: new Visitors(h.db), snapshot: () => ({}), health: () => ({ ok: true }), coach: h.coach, coachAdminToken: h.cfg.coach.adminToken } }, 0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    // Shut the listener before its database.
    cleanups.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
    const state = await (await fetch(`${url}/coach`)).text();
    expect(state).not.toContain("private-gateway-key"); expect(state).not.toContain(h.cfg.coach.adminToken);
    const post = (token?: string) => fetch(`${url}/coach/accept`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ id }) });
    expect((await post()).status).toBe(401); expect((await post("wrong")).status).toBe(401);
    expect(h.cfg.cats.tiger.minTrendScore).toBe(3);
    expect((await post(h.cfg.coach.adminToken)).status).toBe(200);
    expect(h.cfg.cats.tiger.minTrendScore).toBe(2);
    expect((await post(h.cfg.coach.adminToken)).status).toBe(409);
    expect((await fetch(`${url}/coach/accept`, { method: "OPTIONS" })).status).toBe(405);
  });
});
