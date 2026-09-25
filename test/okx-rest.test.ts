import { describe, expect, it } from "vitest";
import { OkxApiError, RateLimitError } from "../src/okx/kit/errors.js";
import { buildQueryString } from "../src/okx/kit/public-client.js";
import { createPublicApi, PUBLIC_TTL_MS } from "../src/okx/public.js";
import { createOkxPublicRest, OKX_PUBLIC_LIMITS, type RestOpts } from "../src/okx/rest.js";

interface Call {
  url: string;
  method: string;
  headers: Headers;
}

/** A fetch stand-in that records every call and answers from a script of responses (the last one repeats). */
function mockFetch(answers: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return a();
  }) as typeof globalThis.fetch;
  return { fn, calls };
}
const ok = (data: unknown, status = 200) => () => new Response(JSON.stringify({ code: "0", msg: "", data }), { status });
const okxErr = (code: string, msg: string, status = 200) => () => new Response(JSON.stringify({ code, msg, data: [] }), { status });

function rest(fetch: typeof globalThis.fetch, extra: Partial<RestOpts> = {}) {
  const sleeps: number[] = [];
  let t = 1_000_000;
  const r = createOkxPublicRest({
    apiBase: "https://eea.okx.com/",
    timeoutMs: 1000,
    fetch,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    ...extra,
  });
  return { r, sleeps, advance: (ms: number) => (t += ms) };
}

// Newest first, as OKX sends them: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
const CANDLES = [
  ["1790340300000", "101", "103", "100", "102", "5", "0.05", "5100", "0"],
  ["1790339400000", "100", "102", "99", "101", "7", "0.07", "7070", "1"],
];

describe("kit public client (vendored)", () => {
  it("builds the query string like the kit (drops undefined/null, joins arrays)", () => {
    expect(buildQueryString({ instId: "BTC-USD_UM_XPERP-310404", bar: "15m", limit: 100, after: undefined, x: null })).toBe("instId=BTC-USD_UM_XPERP-310404&bar=15m&limit=100");
    expect(buildQueryString({ a: ["x", "y"] })).toBe("a=x%2Cy");
    expect(buildQueryString(undefined)).toBe("");
  });
});

describe("in-process public market data", () => {
  it("GETs the same endpoint and params the CLI used, never HEAD, no auth headers", async () => {
    const m = mockFetch([ok(CANDLES)]);
    const api = createPublicApi("https://eea.okx.com", false, rest(m.fn).r);
    await api.candles("BTC-USD_UM_XPERP-310404", "1H", 200);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.method).toBe("GET");
    expect(m.calls[0]!.url).toBe("https://eea.okx.com/api/v5/market/candles?instId=BTC-USD_UM_XPERP-310404&bar=1H&limit=200");
    const h = m.calls[0]!.headers;
    expect(h.get("x-simulated-trading")).toBeNull();
    for (const k of ["OK-ACCESS-KEY", "OK-ACCESS-SIGN", "OK-ACCESS-PASSPHRASE", "Authorization"]) expect(h.get(k)).toBeNull();
    expect(h.get("Accept")).toBe("application/json");
  });

  it("sends x-simulated-trading: 1 only for the demo market", async () => {
    const m = mockFetch([ok([])]);
    await createPublicApi("https://eea.okx.com", true, rest(m.fn).r).tickers();
    expect(m.calls[0]!.headers.get("x-simulated-trading")).toBe("1");
    expect(m.calls[0]!.url).toBe("https://eea.okx.com/api/v5/market/tickers?instType=FUTURES");
  });

  it("parses candles oldest first with the confirm flag, as before", async () => {
    const m = mockFetch([ok(CANDLES)]);
    const c = await createPublicApi("https://eea.okx.com", false, rest(m.fn).r).candles("X", "15m", 100);
    expect(c.map((x) => x.ts)).toEqual([1790339400000, 1790340300000]);
    expect(c[0]).toEqual({ ts: 1790339400000, o: 100, h: 102, l: 99, c: 101, volUsd: 7070, confirmed: true });
    expect(c[1]!.confirmed).toBe(false);
  });

  it("keeps only X-Perps from tickers, instruments and open interest", async () => {
    const tick = { instId: "BTC-USD_UM_XPERP-310404", last: "100", bidPx: "99.9", askPx: "100.1", volCcy24h: "10", open24h: "98", ts: "1" };
    const m = mockFetch([ok([tick, { ...tick, instId: "BTC-USD-261225" }])]);
    const t = await createPublicApi("https://eea.okx.com", false, rest(m.fn).r).tickers();
    expect([...t.keys()]).toEqual(["BTC-USD_UM_XPERP-310404"]);
    expect(t.get("BTC-USD_UM_XPERP-310404")!.vol24hUsd).toBe(1000);

    const m2 = mockFetch([ok([{ instId: "ETH-USD_UM_XPERP-310404", ctVal: "0.01", lotSz: "1", minSz: "1", tickSz: "0.01", state: "live" }, { instId: "ETH-USD-261225" }])]);
    const inst = await createPublicApi("https://eea.okx.com", false, rest(m2.fn).r).instruments();
    expect(inst).toEqual([{ instId: "ETH-USD_UM_XPERP-310404", coin: "ETH", kind: "crypto", ctVal: 0.01, lotSz: 1, minSz: 1, tickSz: 0.01, state: "live" }]);
    expect(m2.calls[0]!.url).toBe("https://eea.okx.com/api/v5/public/instruments?instType=FUTURES");
  });

  it("turns an OKX error code into an error carrying that code", async () => {
    const m = mockFetch([okxErr("51001", "Instrument ID does not exist")]);
    const err = await createPublicApi("https://eea.okx.com", false, rest(m.fn).r).candles("NOPE", "15m", 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OkxApiError);
    expect((err as OkxApiError).code).toBe("51001");
    expect(m.calls).toHaveLength(1); // not retried
  });

  it("maps an HTML/non-JSON HTTP error to its status code", async () => {
    const m = mockFetch([() => new Response("<html>bad gateway</html>", { status: 502 })]);
    const err = await rest(m.fn).r.get("/api/v5/market/tickers", { instType: "FUTURES" }, { ttlMs: 0, demo: false }).catch((e: unknown) => e);
    expect((err as OkxApiError).code).toBe("502");
  });
});

describe("shared cache", () => {
  it("serves identical requests in flight once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = mockFetch([async () => (await gate, ok(CANDLES)())]);
    const api = createPublicApi("https://eea.okx.com", false, rest(m.fn).r);
    const p = Promise.all([api.candles("A", "15m", 100), api.candles("A", "15m", 100), api.candles("A", "15m", 100)]);
    release();
    const [a, b, c] = await p;
    expect(m.calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).not.toBe(b); // each caller gets its own parsed array
  });

  it("serves from cache inside the TTL, refetches after it; different bar/limit/instId/demo are different keys", async () => {
    const m = mockFetch([ok(CANDLES)]);
    const h = rest(m.fn);
    const api = createPublicApi("https://eea.okx.com", false, h.r);
    await api.candles("A", "15m", 100);
    h.advance(PUBLIC_TTL_MS.candles - 1);
    await api.candles("A", "15m", 100);
    expect(m.calls).toHaveLength(1);
    h.advance(2);
    await api.candles("A", "15m", 100);
    expect(m.calls).toHaveLength(2);
    await api.candles("A", "1H", 100);
    await api.candles("A", "15m", 50);
    await api.candles("B", "15m", 100);
    await createPublicApi("https://eea.okx.com", true, h.r).candles("A", "15m", 100);
    expect(m.calls).toHaveLength(6);
    expect(h.r.stats.shared).toBe(1);
  });

  it("keeps every TTL below the engine's refresh cadence, so each cycle still reads fresh data", () => {
    expect(PUBLIC_TTL_MS.tickers).toBeLessThan(1000); // TICK_MS floor is 1000
    for (const k of ["candles", "instruments", "openInterest", "funding"] as const) expect(PUBLIC_TTL_MS[k]).toBeLessThan(15_000); // DATA_REFRESH_MS floor
  });

  it("does not cache failures", async () => {
    const m = mockFetch([okxErr("51001", "x"), ok(CANDLES)]);
    const api = createPublicApi("https://eea.okx.com", false, rest(m.fn).r);
    await expect(api.candles("A", "15m", 100)).rejects.toThrow();
    await expect(api.candles("A", "15m", 100)).resolves.toHaveLength(2);
  });
});

describe("rate limits and backoff", () => {
  it("backs off on HTTP 429 and on code 50011, then succeeds", async () => {
    const m = mockFetch([okxErr("50011", "Too Many Requests", 429), okxErr("50011", "Too Many Requests"), ok(CANDLES)]);
    const h = rest(m.fn);
    const c = await createPublicApi("https://eea.okx.com", false, h.r).candles("A", "15m", 100);
    expect(c).toHaveLength(2);
    expect(m.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(2000);
    expect(h.r.stats.rateLimited).toBe(2);
  });

  it("backs off on a bare 429 with no OKX body", async () => {
    const m = mockFetch([() => new Response("Too Many Requests", { status: 429 }), ok([])]);
    const h = rest(m.fn);
    await h.r.get("/api/v5/market/tickers", { instType: "FUTURES" }, { ttlMs: 0, demo: false });
    expect(m.calls).toHaveLength(2);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  it("gives up after the retry budget with a RateLimitError", async () => {
    const m = mockFetch([okxErr("50011", "Too Many Requests", 429)]);
    const h = rest(m.fn, { maxRateLimitRetries: 2 });
    await expect(h.r.get("/api/v5/market/candles", { instId: "A" }, { ttlMs: 0, demo: false })).rejects.toBeInstanceOf(RateLimitError);
    expect(m.calls).toHaveLength(3);
  });

  it("holds other requests to the same endpoint while cooling down", async () => {
    const m = mockFetch([okxErr("50011", "slow down"), ok(CANDLES)]);
    const h = rest(m.fn);
    await h.r.get("/api/v5/market/candles", { instId: "A" }, { ttlMs: 0, demo: false });
    // the retry already waited out the cool-down, so the next one goes straight through
    const before = h.sleeps.length;
    await h.r.get("/api/v5/market/candles", { instId: "B" }, { ttlMs: 0, demo: false });
    expect(h.sleeps.length).toBe(before);
  });

  it("retries a network error once, then surfaces it", async () => {
    const boom = () => Promise.reject(new TypeError("fetch failed"));
    const m1 = mockFetch([boom, ok([])]);
    await rest(m1.fn).r.get("/api/v5/market/tickers", { instType: "FUTURES" }, { ttlMs: 0, demo: false });
    expect(m1.calls).toHaveLength(2);
    const m2 = mockFetch([boom]);
    await expect(rest(m2.fn).r.get("/api/v5/market/tickers", { instType: "FUTURES" }, { ttlMs: 0, demo: false })).rejects.toThrow(/Failed to call OKX/);
    expect(m2.calls).toHaveLength(2);
  });

  it("sizes every bucket at or under 75% of OKX's 2 s public limit", () => {
    const okxPer2s: Record<string, number> = {
      "/api/v5/market/candles": 40,
      "/api/v5/market/tickers": 20,
      "/api/v5/public/instruments": 20,
      "/api/v5/public/open-interest": 20,
      "/api/v5/public/funding-rate": 20,
      "/api/v5/public/funding-rate-history": 10,
    };
    for (const [path, lim] of Object.entries(okxPer2s)) {
      const b = OKX_PUBLIC_LIMITS[path]!;
      expect(b.capacity + 2 * b.refillPerSecond, path).toBeLessThanOrEqual(0.75 * lim);
    }
  });

  it("paces a burst with the kit's token bucket (real clock)", async () => {
    const m = mockFetch([ok(CANDLES)]);
    const r = createOkxPublicRest({ apiBase: "https://eea.okx.com", timeoutMs: 1000, fetch: m.fn });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 12 }, (_, i) => r.get("/api/v5/market/candles", { instId: `C${i}` }, { ttlMs: 0, demo: false })));
    // capacity 10, refill 10/s: requests 11 and 12 wait for ~100-200 ms of refill
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(m.calls).toHaveLength(12);
  });
});
