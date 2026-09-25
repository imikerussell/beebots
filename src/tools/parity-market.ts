// Parity check: public market data via the OLD path (one `okx market ...` CLI child process per call, exactly the
// args the engine used up to 2026-09-25) against the NEW in-process path (kit REST client, okx/rest.ts).
// Public data only, no keys. Exits 1 on any mismatch.
//   pnpm parity                       (live market; PARITY_COINS=BTC,ETH,TRUMP,AAVE by default; DEMO=1 for demo)
import { isDeepStrictEqual } from "node:util";
import { createOkxCli } from "../okx/cli.js";
import { parseCandles, parseInstrument, parseTicker } from "../okx/public.js";
import { createOkxPublicRest } from "../okx/rest.js";

const demo = process.env.DEMO === "1";
const apiBase = process.env.OKX_API_BASE || "https://eea.okx.com";
const coins = (process.env.PARITY_COINS || "BTC,ETH,TRUMP,AAVE").split(",");
const XPERP = "_UM_XPERP-";
const COMBOS = [
  ["15m", 100],
  ["1H", 200],
  ["4H", 300],
] as const;

type Row = Record<string, string>;
const cli = createOkxCli({ site: "eea", timeoutMs: 15_000 });
const oldRun = <T>(args: string[]) => cli.run<T>({ args, demo });
const rest = createOkxPublicRest({ apiBase, timeoutMs: 15_000 });
// ttl 0: every call really goes to OKX (no cache), so this compares wire data.
const newGet = <T>(path: string, query: Record<string, string | number>) => rest.get<T>(path, query, { ttlMs: 0, demo });

let failures = 0;
const fail = (what: string, detail: string) => {
  failures++;
  console.log(`FAIL ${what}: ${detail}`);
};
const typesOf = (r: Row) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v]));

// ---- instruments: static data, must be byte-identical ----
const [oldInst, newInst] = await Promise.all([
  oldRun<Row[]>(["market", "instruments", "--instType", "FUTURES"]),
  newGet<Row[]>("/api/v5/public/instruments", { instType: "FUTURES" }),
]);
if (isDeepStrictEqual(oldInst, newInst)) console.log(`ok   instruments FUTURES: ${newInst.length} rows identical (raw JSON), parsed X-Perps ${newInst.filter((r) => r.instId?.includes(XPERP)).length}`);
else fail("instruments", `old ${oldInst.length} rows vs new ${newInst.length}`);
const parsedOld = oldInst.filter((r) => r.instId?.includes(XPERP)).map(parseInstrument);
const parsedNew = newInst.filter((r) => r.instId?.includes(XPERP)).map(parseInstrument);
if (!isDeepStrictEqual(parsedOld, parsedNew)) fail("instruments parsed", "differ");

// ---- tickers / open interest: live values move between two calls, so compare shape exactly and values where OKX's ts matches ----
async function liveRows(name: string, oldArgs: string[], path: string, query: Record<string, string>, pick: (r: Row) => unknown) {
  const [o, n] = await Promise.all([oldRun<Row[]>(oldArgs), newGet<Row[]>(path, query)]);
  const oIds = o.map((r) => r.instId).join(",");
  const nIds = n.map((r) => r.instId).join(",");
  if (oIds !== nIds) return fail(name, `instId list/order differs (${o.length} vs ${n.length})`);
  let sameTs = 0;
  let equal = 0;
  let pickSame = 0;
  for (let i = 0; i < o.length; i++) {
    if (!isDeepStrictEqual(Object.keys(o[i]!), Object.keys(n[i]!)) || !isDeepStrictEqual(typesOf(o[i]!), typesOf(n[i]!))) return fail(name, `field set/types differ at ${o[i]!.instId}`);
    if (isDeepStrictEqual(pick(o[i]!), pick(n[i]!))) pickSame++;
    if (o[i]!.ts === n[i]!.ts) {
      sameTs++;
      if (isDeepStrictEqual(o[i], n[i]) && isDeepStrictEqual(pick(o[i]!), pick(n[i]!))) equal++;
      else fail(name, `same ts but different values at ${o[i]!.instId}`);
    }
  }
  console.log(`ok   ${name}: ${n.length} rows, same instIds/order/fields/types; ${sameTs} rows with the same OKX ts, ${equal} of them identical; engine-used value equal in ${pickSame}/${n.length}`);
}
await liveRows("tickers FUTURES", ["market", "tickers", "FUTURES"], "/api/v5/market/tickers", { instType: "FUTURES" }, (r) => (r.instId?.includes(XPERP) ? parseTicker(r) : null));
await liveRows("open-interest FUTURES", ["market", "open-interest", "--instType", "FUTURES"], "/api/v5/public/open-interest", { instType: "FUTURES" }, (r) => r.oiUsd);

// ---- candles: every bar/limit the engine uses, for each sample coin ----
const ids = coins.map((c) => parsedNew.find((i) => i.coin === c && i.state === "live")?.instId).filter((x): x is string => !!x);
if (ids.length !== coins.length) fail("coins", `only found ${ids.join(",")} for ${coins.join(",")}`);
for (const instId of ids) {
  for (const [bar, limit] of COMBOS) {
    let note = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [o, n] = await Promise.all([
        oldRun<string[][]>(["market", "candles", instId, "--bar", bar, "--limit", String(limit)]),
        newGet<string[][]>("/api/v5/market/candles", { instId, bar, limit }),
      ]);
      if (isDeepStrictEqual(o, n) && isDeepStrictEqual(parseCandles(o), parseCandles(n))) {
        const types = [...new Set(n.flat().map((v) => typeof v))].join("/");
        const conf = n.filter((r) => r[8] === "1").length;
        console.log(`ok   candles ${instId} ${bar} x${limit}: ${n.length} rows identical raw + parsed (${conf} confirmed, cells ${types}, newest first -> parsed oldest first)${note}`);
        break;
      }
      // The forming candle can tick between two requests; only accept a difference there, and retry for an exact match.
      const confirmedSame = isDeepStrictEqual(o.filter((r) => r[8] === "1"), n.filter((r) => r[8] === "1"));
      if (attempt === 3) fail(`candles ${instId} ${bar}`, confirmedSame ? "only the forming candle differed on 3 tries" : `rows differ (old ${o.length}, new ${n.length})`);
      else note = ` (exact on try ${attempt + 1}; forming candle moved between calls on try ${attempt})`;
    }
  }
}

console.log(`\n${failures === 0 ? "PARITY OK" : `PARITY FAILED (${failures})`}: ${demo ? "demo" : "live"} market, ${apiBase}, coins ${ids.join(", ")}; new-path requests sent ${rest.stats.sent}`);
process.exit(failures === 0 ? 0 : 1);
