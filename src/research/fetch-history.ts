/** Reproducible public-only OKX X-Perp history download. No exchange keys or model calls. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BIZZY_BREAKOUT_COINS } from "../bees/bizzy.js";
import type { Candle } from "../market/types.js";
import { parseCandles } from "../okx/public.js";

export interface HistoryFile {
  source: string; instId: string; coin: string; bar: "15m" | "4H"; barMs: number;
  fetchedAt: string; requestedStart: string; requestedEndExclusive: string;
  first: string | null; last: string | null; expectedBars: number; actualBars: number;
  gaps: { start: string; endExclusive: string; missingBars: number }[];
  candles: Candle[];
}
export function missingIntervals(candles: Candle[], start: number, end: number, barMs: number): HistoryFile["gaps"] {
  const gaps: HistoryFile["gaps"] = []; let cursor = start;
  for (const candle of candles) {
    if (candle.ts > cursor) gaps.push({ start: new Date(cursor).toISOString(), endExclusive: new Date(candle.ts).toISOString(), missingBars: (candle.ts - cursor) / barMs });
    cursor = candle.ts + barMs;
  }
  if (cursor < end) gaps.push({ start: new Date(cursor).toISOString(), endExclusive: new Date(end).toISOString(), missingBars: (end - cursor) / barMs });
  return gaps;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function publicGet<T>(base: string, path: string, query: Record<string, string>): Promise<T> {
  const url = new URL(path, base); url.search = new URLSearchParams(query).toString();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as { code: string; msg: string; data: T };
      if (result.code !== "0") throw new Error(`OKX ${result.code}: ${result.msg}`);
      return result.data;
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error("unreachable");
}
export async function fetchHistory(base: string, instId: string, bar: "15m" | "4H", start: number, end: number): Promise<HistoryFile> {
  const barMs = bar === "15m" ? 15 * 60_000 : 4 * 3_600_000;
  const byTime = new Map<number, Candle>(); let cursor = end;
  for (;;) {
    const rows = await publicGet<string[][]>(base, "/api/v5/market/history-candles", { instId, bar, limit: "300", after: String(cursor) });
    const candles = parseCandles(rows);
    for (const candle of candles) if (candle.confirmed && candle.ts >= start && candle.ts + barMs <= end) byTime.set(candle.ts, candle);
    const first = candles[0]?.ts;
    if (first === undefined || first <= start) break;
    if (first >= cursor) throw new Error(`Pagination did not advance: ${instId} ${bar}`);
    cursor = first;
    await sleep(150);
  }
  const candles = [...byTime.values()].sort((a, b) => a.ts - b.ts);
  return { source: `${base}/api/v5/market/history-candles`, instId, coin: instId.split("-")[0]!, bar, barMs,
    fetchedAt: new Date().toISOString(), requestedStart: new Date(start).toISOString(), requestedEndExclusive: new Date(end).toISOString(),
    first: candles[0] ? new Date(candles[0].ts).toISOString() : null, last: candles.at(-1) ? new Date(candles.at(-1)!.ts).toISOString() : null,
    expectedBars: (end - start) / barMs, actualBars: candles.length, gaps: missingIntervals(candles, start, end, barMs), candles };
}
export async function downloadHistory(options: { end?: string; days?: number; dir?: string; coins?: readonly string[] } = {}): Promise<void> {
  const base = "https://eea.okx.com", day = 86_400_000;
  const end = options.end ? Date.parse(options.end) : Math.floor(Date.now() / day) * day;
  const days = options.days ?? 90, start = end - days * day, dir = resolve(options.dir ?? "data/research");
  if (!Number.isFinite(end) || end % day !== 0 || days < 1) throw new Error("end must be UTC midnight; days must be positive");
  await mkdir(dir, { recursive: true });
  const instruments = await publicGet<{ instId: string; state: string }[]>(base, "/api/v5/public/instruments", { instType: "FUTURES" });
  const coins = options.coins ?? BIZZY_BREAKOUT_COINS;
  const tasks = coins.flatMap(coin => {
    const ids = instruments.filter(i => i.state === "live" && i.instId.startsWith(`${coin}-`) && i.instId.includes("_UM_XPERP-"));
    if (ids.length !== 1) throw new Error(`Expected one live X-Perp for ${coin}, got ${ids.length}`);
    return (["15m", "4H"] as const).map(bar => ({ instId: ids[0]!.instId, coin, bar }));
  });
  const results: Omit<HistoryFile, "candles">[] = [];
  async function worker() {
    for (let task = tasks.shift(); task; task = tasks.shift()) {
      const file = resolve(dir, `${task.coin}-${task.bar}.json`), requestedStart = task.bar === "4H" ? start - 90 * day : start;
      let cached: HistoryFile | null = null;
      try { cached = JSON.parse(await readFile(file, "utf8")) as HistoryFile; } catch { /* cache miss */ }
      const result = cached?.requestedStart === new Date(requestedStart).toISOString() && cached.requestedEndExclusive === new Date(end).toISOString()
        ? cached : await fetchHistory(base, task.instId, task.bar, requestedStart, end);
      await writeFile(file, `${JSON.stringify(result)}\n`);
      const metadata = { ...result };
      Reflect.deleteProperty(metadata, "candles");
      results.push(metadata);
      process.stdout.write(`${task.coin} ${task.bar}: ${result.actualBars}/${result.expectedBars}, ${result.gaps.length} gaps\n`);
    }
  }
  await Promise.all([worker(), worker()]);
  await writeFile(resolve(dir, "manifest.json"), `${JSON.stringify({ evaluationStart: new Date(start).toISOString(), endExclusive: new Date(end).toISOString(), files: results.sort((a,b)=>a.coin.localeCompare(b.coin)||a.bar.localeCompare(b.bar)) }, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await downloadHistory({ end: process.argv[2], days: process.argv[3] ? Number(process.argv[3]) : undefined });
}
