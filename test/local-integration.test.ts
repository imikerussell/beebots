import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CONVICTION, type DecisionAsk } from "../src/decision.js";
import { LmStudio, validateResponse } from "../src/lmstudio.js";
const ask: DecisionAsk = {
  strategy: "Test strategy",
  state: { BTC: 100, position: null },
  menu: {
    WAIT: { desc: "keep cash", intent: { kind: "hold" } },
    LONG_BTC: {
      desc: "buy",
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
const model = "publisher/Nimble-9B-v3-Q8-instance";
function response() {
  return {
    model,
    answers: {
      action: {
        type: "choice",
        choice: "WAIT",
        probabilities: { WAIT: 0.8, LONG_BTC: 0.2 },
        confidence: 0.6,
      },
      conviction: {
        type: "score",
        score: 1.6,
        legend: Object.fromEntries(CONVICTION.map((v, i) => [i, v])),
        probabilities: { "0": 0.1, "1": 0.3, "2": 0.5, "3": 0.1 },
        confidence: 0.3,
      },
    },
    usage: { input_tokens: 123, output_tokens: 0 },
  };
}
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});
async function mock(
  handler: (body: Record<string, unknown>) => unknown | Promise<unknown>,
  status = 200,
  inventory: unknown = {
    models: [
      {
        type: "decision",
        format: "gguf",
        key: "Bespoke-Nimble-9B-v3",
        loaded_instances: [{ id: model, config: { context_length: 4096 } }],
      },
    ],
  },
) {
  const requests: Array<{
    path: string;
    body: Record<string, unknown>;
    auth: string | undefined;
  }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(inventory));
      return;
    }
    let text = "";
    for await (const c of req) text += String(c);
    const body = JSON.parse(text) as Record<string, unknown>;
    requests.push({ path: req.url!, body, auth: req.headers.authorization });
    const result = await handler(body);
    if (!res.destroyed) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const opts = {
    ...loadConfig({}).local,
    model,
    origin: `http://127.0.0.1:${port}`,
    timeoutMs: 1000,
  };
  return { requests, opts };
}
describe("LM Studio documented systemone contract (mock HTTP, no model or credentials)", () => {
  it("sends typed choice and ordered score; preserves artifact temperatures and actual identifier", async () => {
    const s = await mock(response),
      p = new LmStudio({ ...s.opts, token: "local-test-token" });
    const r = await p.decide(ask);
    expect(r).toMatchObject({
      ok: true,
      choice: "WAIT",
      convictionRaw: 1.6,
      conviction: 1.6,
      model,
      inputTokens: 123,
    });
    expect(s.requests[0]).toMatchObject({
      path: "/v1/systemone",
      auth: "Bearer local-test-token",
      body: {
        model,
        state: ask.state,
        questions: {
          action: {
            type: "choice",
            criteria: { WAIT: "keep cash", LONG_BTC: "buy" },
          },
          conviction: { type: "score", criteria: CONVICTION },
        },
      },
    });
    expect(s.requests[0]!.body).not.toHaveProperty("temperature");
    expect(p.status()).toMatchObject({
      connected: true,
      requests: 1,
      failures: 0,
    });
  });
  it.each([400, 401, 404, 429, 500, 501])(
    "fails closed on HTTP %i without retry/fallback",
    async (status) => {
      const s = await mock(() => ({ error: "not available" }), status),
        p = new LmStudio(s.opts);
      expect(await p.decide(ask)).toMatchObject({ ok: false });
      expect(s.requests).toHaveLength(1);
      expect(p.status().connected).toBe(false);
    },
  );
  it("detects LM Studio's HTTP 200 unexpected endpoint error", async () => {
    const s = await mock(() => ({
      error: "Unexpected endpoint or method. (POST /v1/systemone)",
    }));
    expect(await new LmStudio(s.opts).decide(ask)).toMatchObject({ ok: false });
  });
  it("refuses unloaded or regular chat artifacts before inference", async () => {
    for (const models of [
      [],
      [{ type: "llm", format: "mlx", loaded_instances: [{ id: model }] }],
    ]) {
      const s = await mock(response, 200, { models });
      expect(await new LmStudio(s.opts).decide(ask)).toMatchObject({
        ok: false,
      });
      expect(s.requests).toHaveLength(0);
    }
  });
  it("handles empty, singleton and too-large menus without invalid endpoint calls", async () => {
    const s = await mock(response),
      p = new LmStudio(s.opts);
    expect(await p.decide({ ...ask, menu: {} })).toMatchObject({ ok: false });
    expect(
      await p.decide({ ...ask, menu: { WAIT: ask.menu.WAIT! } }),
    ).toMatchObject({ ok: true, source: "rules", choice: "WAIT" });
    expect(
      await p.decide({ ...ask, menu: { LONG_BTC: ask.menu.LONG_BTC! } }),
    ).toMatchObject({ ok: false });
    expect(
      await p.decide({
        ...ask,
        menu: Object.fromEntries(
          Array.from({ length: 27 }, (_, i) => [String(i), ask.menu.WAIT!]),
        ),
      }),
    ).toMatchObject({ ok: false });
    expect(s.requests).toHaveLength(0);
  });
  it("cancels timed-out requests and times out queued work without sending it", async () => {
    const s = await mock(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return response();
    });
    const p = new LmStudio({ ...s.opts, timeoutMs: 30 });
    const a = p.decide(ask),
      b = p.decide(ask);
    expect(await a).toMatchObject({ ok: false, reason: "timeout" });
    expect(await b).toMatchObject({ ok: false, reason: "timeout" });
    expect(p.status().connected).toBe(false);
  });
  it("bounds shared concurrency and cancellation drains pending requests", async () => {
    let active = 0,
      max = 0;
    const s = await mock(async () => {
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return response();
    });
    const p = new LmStudio({ ...s.opts, concurrency: 1 });
    expect(
      (await Promise.all([p.decide(ask), p.decide(ask)])).every((r) => r.ok),
    ).toBe(true);
    expect(max).toBe(1);
    const a = p.decide(ask),
      b = p.decide(ask);
    p.close();
    expect((await Promise.all([a, b])).every((r) => !r.ok)).toBe(true);
  });
});
describe("runtime response validation", () => {
  const corruptions: Array<[string, (r: ReturnType<typeof response>) => void]> =
    [
      [
        "off menu",
        (r) => {
          r.answers.action.choice = "SELL";
        },
      ],
      [
        "missing probability",
        (r) => {
          delete (
            r.answers.action.probabilities as Partial<Record<string, number>>
          ).WAIT;
        },
      ],
      [
        "NaN probability",
        (r) => {
          r.answers.action.probabilities.WAIT = NaN;
        },
      ],
      [
        "infinite probability",
        (r) => {
          r.answers.action.probabilities.WAIT = Infinity;
        },
      ],
      [
        "negative probability",
        (r) => {
          r.answers.action.probabilities.WAIT = -0.1;
        },
      ],
      [
        "probability over one",
        (r) => {
          r.answers.action.probabilities.WAIT = 1.1;
        },
      ],
      [
        "bad total",
        (r) => {
          r.answers.action.probabilities.WAIT = 0.1;
        },
      ],
      [
        "confidence out of bounds",
        (r) => {
          r.answers.action.confidence = 2;
        },
      ],
      [
        "score confidence missing",
        (r) => {
          r.answers.conviction.confidence = undefined as unknown as number;
        },
      ],
      [
        "score probability missing",
        (r) => {
          delete (
            r.answers.conviction.probabilities as Partial<
              Record<string, number>
            >
          )["2"];
        },
      ],
      [
        "score NaN",
        (r) => {
          r.answers.conviction.score = NaN;
        },
      ],
      [
        "score out of bounds",
        (r) => {
          r.answers.conviction.score = 4;
        },
      ],
      [
        "score inconsistent",
        (r) => {
          r.answers.conviction.score = 2.5;
        },
      ],
      [
        "rubric reordered",
        (r) => {
          (r.answers.conviction.legend as Record<string, string>)["0"] =
            "different";
        },
      ],
      [
        "wrong model",
        (r) => {
          r.model = "another-model";
        },
      ],
      [
        "chat response",
        (r) => {
          r.answers.action.type = "chat";
        },
      ],
    ];
  it.each(corruptions)("rejects %s", (_, change) => {
    const r = response();
    change(r);
    expect(() => validateResponse(r, ask, model, 10)).toThrow();
  });
});
