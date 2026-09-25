// In-process public market data, on the OKX Agent Trade Kit's own public REST client (vendored in ./kit, MIT).
// Replaces one `okx market ...` child process per call (50-80 MB and a Node start-up each) with a plain GET.
//
// On top of the kit client:
// - a short TTL cache plus in-flight sharing: identical requests (same path + query + demo flag) made at the same
//   time, or within `ttlMs`, go to OKX once;
// - per-endpoint token buckets sized under OKX's published public limits (the kit's own defaults assume one call
//   per process, so they are too loose for a loop that fires 60+ candle requests at once);
// - backoff on 429 / 50011 / 50061 (rate limited) and one retry on a network error or a "busy, retry" code.
// Private (signed) calls do not come through here: they still go through the kit CLI (okx/cli.ts).

import { log } from "../log.js";
import { NetworkError, OkxMcpError, RateLimitError } from "./kit/errors.js";
import { buildQueryString, OkxPublicClient, RETRYABLE_OKX_CODES, type QueryParams } from "./kit/public-client.js";
import { RateLimiter, type RateLimitConfig } from "./kit/rate-limiter.js";

export { OkxMcpError };

/**
 * Buckets per OKX endpoint (docs: rate limit per IP, per 2 s). A bucket of capacity C refilling at R/s lets at most
 * C + 2R requests through in any 2 s window; every one here stays at or under 75% of OKX's limit.
 */
export const OKX_PUBLIC_LIMITS: Record<string, RateLimitConfig> = {
  "/api/v5/market/candles": { key: "public:candles", capacity: 10, refillPerSecond: 10 }, // OKX 40 / 2 s
  "/api/v5/market/tickers": { key: "public:tickers", capacity: 5, refillPerSecond: 5 }, // OKX 20 / 2 s
  "/api/v5/public/instruments": { key: "public:instruments", capacity: 5, refillPerSecond: 5 }, // OKX 20 / 2 s
  "/api/v5/public/open-interest": { key: "public:open-interest", capacity: 5, refillPerSecond: 5 }, // OKX 20 / 2 s
  "/api/v5/public/funding-rate": { key: "public:funding-rate", capacity: 5, refillPerSecond: 5 }, // OKX 20 / 2 s per instId
  "/api/v5/public/funding-rate-history": { key: "public:funding-rate-history", capacity: 2, refillPerSecond: 2 }, // OKX 10 / 2 s per instId
};
const DEFAULT_LIMIT: RateLimitConfig = { key: "public:other", capacity: 3, refillPerSecond: 3 };

export interface RestOpts {
  apiBase: string;
  timeoutMs: number;
  /** Max requests in flight at once (the old CLI path allowed 6 child processes). */
  maxConcurrent?: number;
  /** Rate-limited retries before giving up (default 3: waits ~1 s, 2 s, 4 s). */
  maxRateLimitRetries?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface GetOpts {
  /** Serve a copy younger than this from cache. 0 = only share an identical request already in flight. */
  ttlMs: number;
  /** x-simulated-trading: 1 (OKX demo market). */
  demo: boolean;
}

export interface OkxPublicRest {
  get<T>(path: string, query: QueryParams, opts: GetOpts): Promise<T>;
  /** Counters for logs and tests: requests actually sent to OKX, cache/in-flight hits, retries. */
  readonly stats: { sent: number; shared: number; retries: number; rateLimited: number };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createOkxPublicRest(opts: RestOpts): OkxPublicRest {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const maxConcurrent = opts.maxConcurrent ?? 8;
  const maxRlRetries = opts.maxRateLimitRetries ?? 3;
  const client = new OkxPublicClient(
    { baseUrl: opts.apiBase.replace(/\/+$/, ""), timeoutMs: opts.timeoutMs, userAgent: opts.userAgent ?? "beebots (okx-agent-trade-kit core 1.4.8)", site: "eea" },
    opts.fetch,
  );
  const cache = new Map<string, { at: number; data: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  /** After a rate-limit answer, every request to that endpoint waits until this time. */
  const coolUntil = new Map<string, number>();
  const stats = { sent: 0, shared: 0, retries: 0, rateLimited: 0 };
  // The kit's token bucket, one per endpoint. It was written for one call per process: two waiters on the same empty
  // bucket both sleep for the same token and the loser throws. So waiters queue per bucket and take turns.
  const limiter = new RateLimiter(30_000, false);
  const turns = new Map<string, Promise<void>>();
  const takeToken = (limit: RateLimitConfig): Promise<void> => {
    const prev = turns.get(limit.key) ?? Promise.resolve();
    const mine = prev.then(() => limiter.consume(limit));
    const settled = mine.catch(() => undefined);
    turns.set(limit.key, settled);
    void settled.then(() => {
      if (turns.get(limit.key) === settled) turns.delete(limit.key);
    });
    return mine;
  };

  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < maxConcurrent) {
        active++;
        resolve();
      } else queue.push(() => (active++, resolve()));
    });
  const release = () => {
    active--;
    queue.shift()?.();
  };

  async function send<T>(path: string, query: QueryParams, demo: boolean): Promise<T> {
    const limit = OKX_PUBLIC_LIMITS[path] ?? DEFAULT_LIMIT;
    let rlTries = 0;
    let otherTries = 0;
    for (;;) {
      const wait = (coolUntil.get(path) ?? 0) - now();
      if (wait > 0) await sleep(wait);
      await takeToken(limit);
      await acquire();
      try {
        stats.sent++;
        const r = await client.publicGet<T>(path, query, undefined, demo);
        return r.data;
      } catch (err) {
        const code = err instanceof OkxMcpError ? err.code : undefined;
        if (err instanceof RateLimitError) {
          stats.rateLimited++;
          if (rlTries >= maxRlRetries) throw err;
          const backoff = 1000 * 2 ** rlTries + Math.floor(Math.random() * 250);
          rlTries++;
          coolUntil.set(path, Math.max(coolUntil.get(path) ?? 0, now() + backoff));
          stats.retries++;
          log.warn("okx public rate limited, backing off", { path, backoffMs: backoff, attempt: rlTries });
          continue;
        }
        if ((err instanceof NetworkError || (code !== undefined && RETRYABLE_OKX_CODES.has(code))) && otherTries < 1) {
          otherTries++;
          stats.retries++;
          await sleep(500);
          continue;
        }
        throw err;
      } finally {
        release();
      }
    }
  }

  return {
    stats,
    get<T>(path: string, query: QueryParams, o: GetOpts): Promise<T> {
      const key = `${o.demo ? "demo" : "live"} ${path}?${buildQueryString(query)}`;
      const hit = cache.get(key);
      if (hit && o.ttlMs > 0 && now() - hit.at < o.ttlMs) {
        stats.shared++;
        return Promise.resolve(hit.data as T);
      }
      const pending = inflight.get(key);
      if (pending) {
        stats.shared++;
        return pending as Promise<T>;
      }
      const p = send<T>(path, query, o.demo)
        .then((data) => {
          if (o.ttlMs > 0) cache.set(key, { at: now(), data });
          return data;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      // Keep the cache small: drop anything older than a minute.
      if (cache.size > 500) for (const [k, v] of cache) if (now() - v.at > 60_000) cache.delete(k);
      return p;
    },
  };
}
