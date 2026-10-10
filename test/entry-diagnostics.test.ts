import { describe, expect, it } from "vitest";
import { entryBlockers, entryDiagnostics } from "../src/cats.js";
import { entryExplanations } from "../dashboard/src/entryDiagnostics.js";
import { MarketFeed } from "../src/market/data.js";
import type { PublicApi } from "../src/okx/public.js";
import { riskFixture } from "./risk-fixture.js";
import { NOW } from "./fixtures.js";

describe("entry diagnostics", () => {
  it("does not misrepresent stale signals as failed market conditions", () => {
    const h = riskFixture();
    h.s.refreshedAt = NOW - 10 * 60000;
    h.s.intraday!.tiger.momentumPct = -1;
    h.s.intraday!.tiger.atrPct = 0.01;
    h.v.dataErrors = new Map([[h.s.instId, { at: NOW - 1000, message: "5m candle request timed out" }]]);
    expect(entryBlockers("tiger", h.s, h.ctx)).toEqual(["stale_indicators"]);
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["WAIT"]);
    const d = entryDiagnostics("tiger", h.ctx)[0]!;
    expect(d).toMatchObject({ indicatorsAgeMs: 600000, maxIndicatorsAgeMs: 180000, feedError: "5m candle request timed out" });
    const explanations = entryExplanations(d);
    expect(explanations[0]).toContain("10.0 min old; limit 3.0 min");
    expect(explanations[1]).toContain("timed out");
    expect(explanations.join(" ")).not.toContain("Volatility filter");
  });

  it("explains the cost and breakout gates with the exact values used by the rules", () => {
    const h = riskFixture();
    h.s.intraday!.tiger.atrPct = 0.04;
    h.s.intraday!.tiger.confirmed.close = 99.5;
    const d = entryDiagnostics("tiger", h.ctx)[0]!;
    expect(d.stopDistancePct).toBe(0.08);
    expect(d.roundTripCostPct).toBeCloseTo(0.15);
    expect(d.minStopDistancePct).toBeCloseTo(0.30);
    expect(entryExplanations(d).join(" ")).toContain("0.080%; needs at least 0.300%");
    expect(entryExplanations(d).join(" ")).toContain("close $99.50 must exceed $100.00");
    expect(d.confirmedAgeMs).toBe(0);
    expect(d.confirmedAt).toBe(NOW);
  });

  it("distinguishes an old entry candle from an absent one and hides misleading historical blockers", () => {
    const h = riskFixture();
    h.s.intraday!.tiger.confirmed.ts = NOW - 20 * 60000;
    expect(entryBlockers("tiger", h.s, h.ctx)).toEqual(["missing_confirmed_entry_close"]);
    expect(entryExplanations(entryDiagnostics("tiger", h.ctx)[0]!).join(" ")).toContain("15.0 min; limit 6.0 min");
    const legacy = { coin: "BTC", blockers: ["stale_indicators", "move_too_small_after_costs", "minTrendScore"] };
    expect(entryExplanations(legacy).join(" ")).toContain("not recorded");
    expect(entryExplanations(legacy).join(" ")).not.toContain("Volatility filter");
  });
});

describe("refresh failure visibility and recovery", () => {
  it("keeps old timestamps, records per-coin and global errors, and clears them on recovery", async () => {
    const h = riskFixture();
    let failCandles = false, failTickers = false;
    const api: PublicApi = {
      instruments: async () => [...h.v.instruments.values()],
      tickers: async () => { if (failTickers) throw new Error("ticker request timed out"); return h.v.tickers; },
      candles: async (_id, bar) => {
        if (failCandles && bar === "5m") throw new Error("5m request token=secretvalue timed out");
        const minutes = bar === "5m" ? 5 : bar === "15m" ? 15 : 60;
        return Array.from({ length: 200 }, (_, i) => ({ ts: NOW - (200 - i) * minutes * 60000, o: 100, h: 101, l: 99, c: 100, volUsd: 1000, confirmed: true }));
      },
      openInterest: async () => new Map(),
      funding: async () => ({ rate: 0.0001, nextFundingTime: NOW + 3600000 }),
      fundingHistory: async () => [],
    };
    const feed = new MarketFeed(api, { min24hVolUsd: 0, allowNonCrypto: false, spreadGateBps: 10, trendCoins: ["BTC"] }, null, () => []);
    await feed.refresh(NOW);
    expect(feed.view().stats.get(h.s.instId)?.refreshedAt).toBe(NOW);
    failCandles = true;
    await feed.refresh(NOW + 240000);
    expect(feed.view().stats.get(h.s.instId)?.refreshedAt).toBe(NOW);
    expect(feed.view().dataErrors?.get(h.s.instId)?.message).toBe("5m request token=[redacted] timed out");
    h.ctx.view = feed.view(); h.ctx.now = NOW + 240000;
    expect(entryDiagnostics("tiger", h.ctx)[0]?.blockers).toEqual(["stale_indicators"]);
    failTickers = true;
    await expect(feed.refresh(NOW + 250000)).rejects.toThrow("ticker request timed out");
    expect(feed.view().refreshError?.message).toBe("ticker request timed out");
    failTickers = failCandles = false;
    await feed.refresh(NOW + 260000);
    expect(feed.view().refreshError).toBeNull();
    expect(feed.view().dataErrors?.size).toBe(0);
    expect(feed.view().stats.get(h.s.instId)?.refreshedAt).toBe(NOW + 260000);
  });
});
