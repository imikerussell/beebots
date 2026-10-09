import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CONVICTION, type DecisionAsk } from "../src/decision.js";
import { Jev } from "../src/jev.js";
import { LmStudio } from "../src/lmstudio.js";
import {
  createDecisionProvider,
  decisionConfiguration,
} from "../src/providers.js";
import { Db } from "../src/db.js";
const ask: DecisionAsk = {
  strategy: "Test",
  state: { mode: "PAPER", price: 100 },
  menu: {
    WAIT: { desc: "Stay in cash", intent: { kind: "hold" } },
    LONG_BTC: {
      desc: "Long",
      intent: {
        kind: "open",
        instId: "BTC",
        side: "long",
        sizeFrac: 1,
        setup: "strict",
      },
    },
  },
  convictionLabels: CONVICTION,
};
const response = () => ({
  model: "jev-1.13.0",
  answers: {
    action: {
      type: "choice",
      choice: "WAIT",
      probabilities: { WAIT: 0.8, LONG_BTC: 0.2 },
      confidence: 0.6,
    },
    conviction: {
      type: "score",
      score: 2,
      legend: Object.fromEntries(CONVICTION.map((v, i) => [String(i), v])),
      probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
      confidence: 1,
    },
  },
  usage: { input_tokens: 1000, output_tokens: 0 },
});
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
async function mock(
  handler: () => unknown | Promise<unknown> = response,
  status = 200,
) {
  const requests: Array<{
    path: string;
    auth?: string;
    body: Record<string, unknown>;
  }> = [];
  const s = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push({
      path: req.url!,
      auth: req.headers.authorization,
      body: JSON.parse(body),
    });
    const value = await handler();
    if (!res.destroyed) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    }
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  const origin = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const fetcher: typeof fetch = (url, init) => {
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    return fetch(`${origin}/v1/systemone`, init);
  };
  return { requests, fetcher };
}
const config = () =>
  loadConfig({ DECISION_PROVIDER: "jev", TYPESAFE_API_KEY: "mock-key" });
describe("explicit Jev selection, mock HTTP only", () => {
  it("routes Vercel choice/score requests with only the gateway credential and records the route", async () => {
    const cfg = loadConfig({
      DECISION_PROVIDER: "jev", JEV_TRANSPORT: "vercel",
      AI_GATEWAY_API_KEY: "gateway-test-key", TYPESAFE_API_KEY: "wrong-route-key",
    });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer gateway-test-key" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "typesafe-ai/jev", questions: { action: { type: "choice" }, conviction: { type: "score" } },
      });
      return Response.json({ ...response(), model: "typesafe-ai/jev" });
    });
    const p = createDecisionProvider(cfg, undefined, fetcher);
    expect(await p.decide(ask)).toMatchObject({ ok: true, model: "typesafe-ai/jev", costUsd: 0.000042 });
    expect(p.status()).toMatchObject({ provider: "Jev cloud (Vercel)", connected: true });
    expect(decisionConfiguration(cfg)).toMatchObject({ transport: "vercel", origin: "https://ai-gateway.vercel.sh/typesafe" });
    expect(JSON.stringify(decisionConfiguration(cfg))).not.toContain("gateway-test-key");
    expect(fetcher).toHaveBeenCalledTimes(1);
    p.close();
  });
  it("never substitutes a direct key for a missing gateway key or accepts the wrong route's model", async () => {
    const cfg = loadConfig({ DECISION_PROVIDER: "jev", JEV_TRANSPORT: "vercel", TYPESAFE_API_KEY: "direct-key" });
    const fetcher = vi.fn<typeof fetch>();
    const p = createDecisionProvider(cfg, undefined, fetcher);
    expect(await p.decide(ask)).toMatchObject({ ok: false, reason: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => loadConfig({ DECISION_PROVIDER: "jev", JEV_TRANSPORT: "vercel", JEV_MODEL: "jev-1.13.0" })).toThrow(/Vercel/);
    expect(() => loadConfig({ JEV_TRANSPORT: "unknown" })).toThrow(/JEV_TRANSPORT/);
    p.close();
  });
  it("defaults to local without a Jev key; switches explicitly without changing paper safety or identities", () => {
    const local = loadConfig({});
    expect(createDecisionProvider(local)).toBeInstanceOf(LmStudio);
    const jev = config();
    expect(createDecisionProvider(jev)).toBeInstanceOf(Jev);
    expect(jev.mode).toBe("dry");
    expect(Object.keys(jev.cats)).toEqual(["tiger", "mochi"]);
    expect(() => loadConfig({ DECISION_PROVIDER: "automatic" })).toThrow();
    expect(() =>
      loadConfig({ DECISION_PROVIDER: "jev", JEV_MODEL: "jev-latest" }),
    ).toThrow(/Pin/);
    expect(JSON.stringify(decisionConfiguration(jev))).not.toContain(
      "mock-key",
    );
  });
  it("sends the same typed choice/score to the hosted endpoint and estimates its cost", async () => {
    const m = await mock(),
      p = createDecisionProvider(config(), undefined, m.fetcher);
    const r = await p.decide(ask);
    expect(r).toMatchObject({
      ok: true,
      model: "jev-1.13.0",
      conviction: 2,
      costUsd: 0.000042,
    });
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0]).toMatchObject({
      path: "/v1/systemone",
      auth: "Bearer mock-key",
      body: {
        state: ask.state,
        questions: {
          action: {
            type: "choice",
            criteria: { WAIT: "Stay in cash", LONG_BTC: "Long" },
          },
          conviction: { type: "score", criteria: CONVICTION },
        },
      },
    });
    expect(m.requests[0]!.body).not.toHaveProperty("temperature");
    expect(p.status()).toMatchObject({
      provider: "Jev cloud",
      connected: true,
      requests: 1,
      estimatedSpentTodayUsd: 0.000042,
    });
  });
  it("fails closed without a cloud key and never falls back to the local server", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const p = createDecisionProvider(
      loadConfig({ DECISION_PROVIDER: "jev" }),
      undefined,
      fetcher,
    );
    expect(await p.decide(ask)).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])(
    "fails closed on HTTP %i, without fallback or automatic retry",
    async (status) => {
      const m = await mock(() => ({ error: "failure" }), status),
        p = createDecisionProvider(config(), undefined, m.fetcher);
      expect(await p.decide(ask)).toMatchObject({ ok: false });
      expect(m.requests).toHaveLength(1);
      if (status === 429 || status === 500) {
        await p.decide(ask);
        expect(m.requests).toHaveLength(1);
      }
    },
  );
  it("rejects malformed scores and accounts for reported tokens even on invalid answers", async () => {
    const m = await mock(() => {
        const r = response();
        r.answers.conviction.score = 10;
        return r;
      }),
      p = createDecisionProvider(config(), undefined, m.fetcher);
    expect(await p.decide(ask)).toMatchObject({ ok: false, costUsd: 0.000042 });
    expect(p.status().estimatedSpentTodayUsd).toBe(0.000042);
  });
  it("restores its daily estimate on restart and leaves the local provider free of billing gates", async () => {
    const db = new Db(":memory:"),
      m = await mock(),
      cfg = config();
    cfg.jev.dailyUsdCap = 0.00004;
    const p = createDecisionProvider(cfg, db, m.fetcher);
    expect((await p.decide(ask)).ok).toBe(true);
    const resumed = createDecisionProvider(cfg, db, m.fetcher);
    expect((await resumed.decide(ask)).ok).toBe(false);
    expect(m.requests).toHaveLength(1);
    expect(resumed.status().estimatedSpentTodayUsd).toBe(0.000042);
    const local = createDecisionProvider(loadConfig({}), db, m.fetcher);
    expect(local.status().provider).toBe("Local inference");
    expect(
      await local.decide({ ...ask, menu: { WAIT: ask.menu.WAIT! } }),
    ).toMatchObject({ ok: true, source: "rules" });
    db.close();
  });
  it("checks queued calls against the budget after the preceding response is charged", async () => {
    const m = await mock(),
      cfg = config();
    cfg.jev.dailyUsdCap = 0.00004;
    const p = createDecisionProvider(cfg, undefined, m.fetcher),
      results = await Promise.all([p.decide(ask), p.decide(ask)]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(m.requests).toHaveLength(1);
  });
  it("aborts slow cloud requests at the deadline", async () => {
    const m = await mock(async () => {
      await new Promise((r) => setTimeout(r, 120));
      return response();
    });
    const cfg = config();
    cfg.jev.timeoutMs = 30;
    const p = createDecisionProvider(cfg, undefined, m.fetcher);
    expect(await p.decide(ask)).toMatchObject({ ok: false, reason: "timeout" });
    expect(p.status().connected).toBe(false);
  });
  it("resets its cloud budget on the next UTC day", async () => {
    const m = await mock(),
      cfg = config();
    cfg.jev.dailyUsdCap = 0.00004;
    let now = Date.UTC(2026, 9, 9);
    const p = new Jev(cfg.jev, undefined, m.fetcher, () => now);
    expect((await p.decide(ask)).ok).toBe(true);
    expect((await p.decide(ask)).ok).toBe(false);
    now += 86400000;
    expect((await p.decide(ask)).ok).toBe(true);
    expect(m.requests).toHaveLength(2);
  });
});
