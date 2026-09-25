// The kit's `news` module (OKX Orbit). It needs a signed request, so it only runs in demo/live.
// UNVERIFIED on EEA as of 2026-09-24: on any failure it switches off for 15 min and boozy falls back to volume z.
import type { OkxCreds } from "../config.js";
import { log } from "../log.js";
import type { NewsReading, NewsSource } from "../market/data.js";
import { safeError } from "../redact.js";
import type { OkxCli } from "./cli.js";

type TrendPoint = { ts: string; bullishRatio?: string; bearishRatio?: string; mentionCnt?: string };
type Detail = { ccy: string; trend?: TrendPoint[] };

export function createNewsSource(cli: OkxCli, creds: OkxCreds, demo: boolean, now: () => number = Date.now): NewsSource {
  const cache = new Map<string, { at: number; r: NewsReading }>();
  let offUntil = 0;
  let warned = false;

  return async (coins) => {
    if (now() < offUntil) return null;
    const out = new Map<string, NewsReading>();
    try {
      for (const coin of coins) {
        const c = cache.get(coin);
        if (c && now() - c.at < 10 * 60_000) {
          out.set(coin, c.r);
          continue;
        }
        const raw = await cli.run<Array<{ details?: Detail[] }>>({ args: ["news", "coin-trend", coin, "--period", "1h", "--points", "24"], bee: "bee1", creds, demo });
        const trend = [...(raw?.[0]?.details?.[0]?.trend ?? [])].sort((a, b) => Number(a.ts) - Number(b.ts));
        const lastPt = trend[trend.length - 1];
        const r: NewsReading = {
          mentions: trend.map((t) => Number(t.mentionCnt ?? 0)),
          sentiment: lastPt ? Number(lastPt.bullishRatio ?? 0) - Number(lastPt.bearishRatio ?? 0) : null,
        };
        cache.set(coin, { at: now(), r });
        out.set(coin, r);
      }
      warned = false;
      return out;
    } catch (err) {
      offUntil = now() + 15 * 60_000;
      if (!warned) log.warn("news module unavailable, boozy uses volume z for attention", { err: safeError(err) });
      warned = true;
      return null;
    }
  };
}
