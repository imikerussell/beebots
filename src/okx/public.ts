import { kindOf } from "../market/kinds.js";
import type { Candle, FundingNow, Instrument, Ticker } from "../market/types.js";
import { createOkxPublicRest, type OkxPublicRest } from "./rest.js";

const XPERP = "_UM_XPERP-";
const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));

type Row = Record<string, string>;

export interface PublicApi {
  instruments(): Promise<Instrument[]>;
  tickers(): Promise<Map<string, Ticker>>;
  candles(instId: string, bar: "15m" | "1H" | "4H", limit: number): Promise<Candle[]>;
  openInterest(): Promise<Map<string, number>>;
  funding(instId: string): Promise<FundingNow>;
  fundingHistory(instId: string, limit: number): Promise<number[]>;
}

export function parseInstrument(r: Row): Instrument {
  const coin = r.instId!.split("-")[0]!;
  return {
    instId: r.instId!,
    coin,
    kind: kindOf(coin),
    ctVal: num(r.ctVal),
    lotSz: num(r.lotSz),
    minSz: num(r.minSz),
    tickSz: num(r.tickSz),
    state: r.state ?? "",
  };
}

export function parseTicker(r: Row): Ticker {
  const last = num(r.last);
  const bid = num(r.bidPx);
  const ask = num(r.askPx);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  // volCcy24h is in base currency on X-Perps, so USD volume = base volume x last.
  return {
    instId: r.instId!,
    last,
    bid,
    ask,
    mid,
    spreadBp: bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : Infinity,
    vol24hUsd: num(r.volCcy24h) * last,
    open24h: num(r.open24h),
    ts: num(r.ts),
  };
}

/** OKX returns newest first as string arrays: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]. */
export function parseCandles(rows: string[][]): Candle[] {
  return rows
    .map((r) => ({
      ts: num(r[0]),
      o: num(r[1]),
      h: num(r[2]),
      l: num(r[3]),
      c: num(r[4]),
      volUsd: num(r[7]),
      confirmed: r[8] === "1",
    }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Freshness of the shared cache per call. Every value is shorter than the engine's cadence for that call (tickers every
 * TICK_MS >= 1 s, the rest every DATA_REFRESH_MS >= 15 s), so each engine cycle still reads fresh data; the cache only
 * merges identical requests that land together (e.g. the tick's and the refresh's tickers, or two tools at once).
 */
export const PUBLIC_TTL_MS = { tickers: 900, candles: 10_000, instruments: 10_000, openInterest: 5_000, funding: 10_000 } as const;

/**
 * Public OKX market data, in-process through the kit's public REST client (okx/rest.ts), no child processes.
 * `demo`: read OKX's demo market instead of live. Demo lists its own, smaller set of X-Perps with different
 * expiry suffixes (e.g. BTC ...-310328 in demo vs ...-310404 live), so in MODE=demo the whole feed must come from it.
 * Pass `rest` to share one client (cache, rate-limit buckets) between several feeds.
 */
export function createPublicApi(apiBase: string, demo = false, rest: OkxPublicRest = createOkxPublicRest({ apiBase, timeoutMs: 15_000 })): PublicApi {
  const get = <T>(path: string, query: Record<string, string | number>, ttlMs: number) => rest.get<T>(path, query, { ttlMs, demo });

  return {
    async instruments() {
      const rows = await get<Row[]>("/api/v5/public/instruments", { instType: "FUTURES" }, PUBLIC_TTL_MS.instruments);
      return rows.filter((r) => r.instId?.includes(XPERP)).map(parseInstrument);
    },
    async tickers() {
      const rows = await get<Row[]>("/api/v5/market/tickers", { instType: "FUTURES" }, PUBLIC_TTL_MS.tickers);
      const out = new Map<string, Ticker>();
      for (const r of rows) if (r.instId?.includes(XPERP)) out.set(r.instId, parseTicker(r));
      return out;
    },
    async candles(instId, bar, limit) {
      const rows = await get<string[][]>("/api/v5/market/candles", { instId, bar, limit }, PUBLIC_TTL_MS.candles);
      return parseCandles(rows);
    },
    async openInterest() {
      const rows = await get<Row[]>("/api/v5/public/open-interest", { instType: "FUTURES" }, PUBLIC_TTL_MS.openInterest);
      const out = new Map<string, number>();
      for (const r of rows) if (r.instId?.includes(XPERP)) out.set(r.instId, num(r.oiUsd));
      return out;
    },
    async funding(instId) {
      // The kit CLI refuses X-Perp ids for funding-rate (it wants -SWAP), so this was always a direct GET.
      const [r] = await get<Row[]>("/api/v5/public/funding-rate", { instId }, PUBLIC_TTL_MS.funding);
      return { rate: num(r?.fundingRate), nextFundingTime: num(r?.fundingTime) };
    },
    async fundingHistory(instId, limit) {
      const rows = await get<Row[]>("/api/v5/public/funding-rate-history", { instId, limit }, PUBLIC_TTL_MS.funding);
      return rows.map((r) => num(r.realizedRate ?? r.fundingRate)).filter(Number.isFinite);
    },
  };
}

/**
 * Setup only (no CLI there yet): the crypto coins with a live X-Perp on OKX EEA right now, from the public REST API.
 * Same rules as the engine's universe: `_UM_XPERP-`, live, not TEST, crypto (stocks, commodities and unclassified
 * coins are left out).
 */
export async function fetchXperpCoins(apiBase: string, timeoutMs = 10_000): Promise<string[]> {
  const res = await fetch(`${apiBase}/api/v5/public/instruments?instType=FUTURES`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`OKX answered HTTP ${res.status}`);
  const j = (await res.json()) as { code?: string; data?: Row[] };
  if (j.code !== "0" || !Array.isArray(j.data)) throw new Error("OKX sent no instrument list");
  const coins = j.data
    .filter((r) => r.instId?.includes(XPERP) && r.state === "live")
    .map(parseInstrument)
    .filter((i) => i.kind === "crypto")
    .map((i) => i.coin);
  return [...new Set(coins)].sort();
}
