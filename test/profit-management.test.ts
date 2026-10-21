import { describe, expect, it } from "vitest";
import { profitMetrics, profitReviewKey, profitReviewMenu, profitStopCandidate, takeProfitContracts } from "../src/bees/profit-management.js";
import type { BeeContext, Position, Side } from "../src/bees/types.js";
import { loadConfig, type BeeId } from "../src/config.js";
import { freshBee } from "../src/ledger.js";
import { coin, NOW, position, trend, view } from "./fixtures.js";

function fixture(side: Side = "long", mid = 103, id: BeeId = "tiger", extra: Partial<Position> = {}) {
  const cfg = loadConfig({}), s = coin("BTC", {bid: mid * .999, ask: mid * 1.001, atr14Pct: 1, trend: trend({atr4hPct: 2})}, mid);
  const v = view([s]);
  cfg.risk.takerFeeRate = .001;
  cfg.paperSlippageBps = 20;
  Object.assign(cfg.exits[id], {
    breakevenAtR: .5, breakevenBufferBps: 10, trailActivationR: .75, trailAtrMult: 1,
    profitLockAtR: 1, maxGivebackPct: 35, partialTakeProfitEnabled: true,
    partialTakeProfitAtR: 1.5, partialTakeProfitFraction: .5,
    reviewMinR: .5, reviewIntervalSeconds: 60, minActionProbability: .4,
  });
  const b = freshBee(id, 250, NOW);
  b.position = position(s, {side, contracts: 10, entryPx: 100, stopPx: side === "long" ? 99 : 101, riskUsd: 10, entryFeesUsd: 1, fundingAccruedUsd: 0, ...extra});
  v.instruments.get(s.instId)!.ctVal = 1;
  const ctx: BeeContext = {bee: b, view: v, cfg, knobs: cfg.cats[id], now: NOW, uplR: null};
  return {ctx, cfg, b, p: b.position, e: cfg.exits[id], s, t: v.tickers.get(s.instId)!, inst: v.instruments.get(s.instId)!};
}

/** Independent executable-fill calculation to check that the stop solver actually covers costs. */
function netAtMid(h: ReturnType<typeof fixture>, mid: number): number {
  const dir = h.p.side === "long" ? 1 : -1, q = h.p.contracts * h.inst.ctVal;
  const px = mid * (h.p.side === "long" ? h.t.bid / h.t.mid * (1-h.cfg.paperSlippageBps/10000) : h.t.ask / h.t.mid * (1+h.cfg.paperSlippageBps/10000));
  return dir * (px-h.p.entryPx)*q - (h.p.entryFeesUsd ?? q*h.p.entryPx*h.cfg.risk.takerFeeRate) + (h.p.fundingAccruedUsd ?? 0) - px*q*h.cfg.risk.takerFeeRate;
}

describe("cost-aware profit protection", () => {
  it.each(["long", "short"] as const)("%s breakeven includes opening fees, closing fees, executable spread, adverse slippage and buffer", side => {
    const h = fixture(side, side === "long" ? 103 : 97), m = profitMetrics(h.ctx)!;
    expect(m.netPnlUsd).toBeCloseTo(netAtMid(h, h.t.mid), 10);
    expect(netAtMid(h, m.breakevenPx)).toBeCloseTo(1, 10);
    expect(side === "long" ? m.breakevenPx > 100 : m.breakevenPx < 100).toBe(true);
  });

  it("uses actual entry fill costs once and recognises an explicitly zero opening fee", () => {
    const h = fixture("long", 100, "tiger", {entryPx: 100.2, entryFeesUsd: 0});
    const m = profitMetrics(h.ctx)!;
    // Opening spread/slippage is already represented by the 100.2 fill; only exit slippage is estimated.
    const close = 100 * .999 * .998;
    expect(m.netPnlUsd).toBeCloseTo((close - 100.2) * 10 - close * 10 * .001, 10);
    expect(m.costBasisEstimated).toBe(false);
    delete h.p.entryFeesUsd;
    expect(profitMetrics(h.ctx)!.netPnlUsd).toBeCloseTo(m.netPnlUsd - 1.002, 10);
    expect(profitMetrics(h.ctx)!.costBasisEstimated).toBe(true);
  });

  it("preserves actual opening fee rebates instead of substituting an estimated charge", () => {
    const h = fixture("long", 103, "tiger", {entryFeesUsd: -.5});
    const m = profitMetrics(h.ctx)!;
    expect(m.costBasisEstimated).toBe(false);
    expect(m.entryFeesUsd).toBe(-.5);
    expect(m.netPnlUsd).toBeCloseTo(netAtMid(h, h.t.mid), 10);
    expect(netAtMid(h, m.breakevenPx)).toBeCloseTo(1, 10);
  });

  it.each(["long", "short"] as const)("%s net funding credit reduces the required break-even move; debit increases it", side => {
    const h = fixture(side, side === "long" ? 103 : 97), baseline = profitMetrics(h.ctx)!;
    h.p.fundingAccruedUsd = 2;
    const credited = profitMetrics(h.ctx)!;
    expect(credited.netPnlUsd).toBeCloseTo(baseline.netPnlUsd + 2, 10);
    expect(netAtMid(h, credited.breakevenPx)).toBeCloseTo(1, 10);
    expect(side === "long" ? credited.breakevenPx < baseline.breakevenPx : credited.breakevenPx > baseline.breakevenPx).toBe(true);
    h.p.fundingAccruedUsd = -2;
    expect(profitMetrics(h.ctx)!.netPnlUsd).toBeCloseTo(baseline.netPnlUsd - 2, 10);
    expect(netAtMid(h, profitMetrics(h.ctx)!.breakevenPx)).toBeCloseTo(1, 10);
  });

  it.each(["long", "short"] as const)("%s retains the configured share of a prior after-cost peak and detects a breached lock", side => {
    const h = fixture(side, side === "long" ? 102 : 98, "tiger", {exitPeakNetPerUnit: 4, exitPeakPx: side === "long" ? 105 : 95, stopPx: side === "long" ? 103 : 97});
    h.e.breakevenAtR = h.e.trailActivationR = 0;
    const m = profitMetrics(h.ctx)!, candidate = profitStopCandidate(h.ctx)!;
    expect(m.peakNetR).toBe(4);
    expect(m.peakNetPnlUsd).toBe(40);
    expect(m.givebackPct).toBeGreaterThan(35);
    expect(candidate.reason).toBe("peak_profit_lock");
    expect(netAtMid(h, candidate.stopPx!)).toBeCloseTo(26, 10);
    expect(side === "long" ? candidate.stopPx! > h.t.mid : candidate.stopPx! < h.t.mid).toBe(true);
  });

  it.each(["long", "short"] as const)("%s partial close preserves per-unit high water mark and activation thresholds", side => {
    const h = fixture(side, side === "long" ? 103 : 97, "tiger", {exitPeakNetPerUnit: 4, exitPeakPx: side === "long" ? 105 : 95, fundingAccruedUsd: -2});
    const before = profitMetrics(h.ctx)!;
    h.p.contracts /= 2; h.p.riskUsd /= 2; h.p.entryFeesUsd! /= 2; h.p.fundingAccruedUsd! /= 2;
    const after = profitMetrics(h.ctx)!;
    expect(after.netPnlUsd).toBeCloseTo(before.netPnlUsd / 2, 10);
    expect(after.peakNetPnlUsd).toBe(before.peakNetPnlUsd / 2);
    expect(after.netR).toBeCloseTo(before.netR, 10);
    expect(after.givebackPct).toBeCloseTo(before.givebackPct, 10);
    expect(after.breakevenPx).toBeCloseTo(before.breakevenPx, 10);
  });

  it("requires sufficient current or previously observed profit to cover the break-even buffer", () => {
    const h = fixture("long", 102);
    h.e.trailActivationR = h.e.profitLockAtR = 0;
    h.e.breakevenBufferBps = 500;
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeNull();
    h.p.exitPeakNetPerUnit = 2;
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeNull();
    h.p.exitPeakNetPerUnit = 6;
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeGreaterThan(h.t.mid);
  });

  it("does not turn an ATR change into an already-crossed new price stop", () => {
    const h = fixture("long", 102, "tiger", {exitPeakNetPerUnit: 4, exitPeakPx: 105, stopPx: 101});
    h.e.breakevenAtR = h.e.profitLockAtR = 0;
    // An old, still-valid 101 barrier remains the engine's protection after ATR shrinks.
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeNull();
  });

  it.each(["long", "short"] as const)("%s net lock reacts to spread or funding deterioration before the old price stop is hit", side => {
    const h = fixture(side, side === "long" ? 105 : 95);
    h.e.breakevenAtR = h.e.trailActivationR = 0;
    const initial = profitStopCandidate(h.ctx)!;
    h.p.exitPeakNetPerUnit = initial.peakNetPerUnit;
    h.p.exitPeakPx = initial.peakPx;
    h.p.stopPx = initial.stopPx;
    // Keep the mid unchanged but make executable spread sharply worse.
    if (side === "long") h.t.bid -= 3; else h.t.ask += 3;
    const spreadStop = profitStopCandidate(h.ctx)!;
    expect(profitMetrics(h.ctx)!.givebackPct).toBeGreaterThan(35);
    expect(spreadStop.reason).toBe("peak_profit_lock");
    expect(side === "long" ? h.t.mid > h.p.stopPx! : h.t.mid < h.p.stopPx!).toBe(true);
    expect(side === "long" ? spreadStop.stopPx! > h.t.mid : spreadStop.stopPx! < h.t.mid).toBe(true);
    expect(netAtMid(h, spreadStop.stopPx!)).toBeCloseTo(initial.peakNetPerUnit * 10 * .65, 10);
    // Funding can breach the same retained net target with an unchanged executable spread.
    h.t.bid = h.t.mid * .999; h.t.ask = h.t.mid * 1.001; h.p.fundingAccruedUsd = -30;
    const fundingStop = profitStopCandidate(h.ctx)!;
    expect(fundingStop.reason).toBe("peak_profit_lock");
    expect(side === "long" ? fundingStop.stopPx! > h.t.mid : fundingStop.stopPx! < h.t.mid).toBe(true);
  });

  it("applies a tighter net giveback setting immediately to a previously observed profitable peak", () => {
    const h = fixture("long", 102, "tiger", {exitPeakNetPerUnit: 4, exitPeakPx: 105, stopPx: 101});
    h.e.breakevenAtR = h.e.trailActivationR = 0;
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeGreaterThan(h.t.mid);
  });

  it.each(["long", "short"] as const)("%s trailing distance uses its own ATR multiple rather than the initial-stop multiple", side => {
    const h = fixture(side, side === "long" ? 105 : 95);
    h.e.breakevenAtR = h.e.profitLockAtR = 0;
    h.ctx.knobs.stopAtrMult = 9;
    h.e.trailAtrMult = .5;
    const candidate = profitStopCandidate(h.ctx)!;
    expect(candidate.reason).toBe("trailing_profit");
    expect(candidate.stopPx).toBeCloseTo(h.t.mid * (side === "long" ? .995 : 1.005), 10);
    h.e.trailAtrMult = 1;
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeCloseTo(h.t.mid * (side === "long" ? .99 : 1.01), 10);
  });

  it("uses Good's four-hour ATR and preserves quote-based protection when indicators are stale", () => {
    const h = fixture("long", 105, "mochi");
    h.e.breakevenAtR = h.e.profitLockAtR = 0;
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeCloseTo(102.9, 10);
    h.s.refreshedAt = NOW - 3 * h.cfg.dataRefreshMs - 1;
    expect(profitStopCandidate(h.ctx)!.stopPx).toBeNull();
    expect(profitReviewKey(h.ctx)).toBeNull();
    h.e.breakevenAtR = .5;
    expect(profitStopCandidate(h.ctx)!.reason).toBe("breakeven");
    h.e.profitLockAtR = 1;
    expect(profitStopCandidate(h.ctx)!.reason).toBe("peak_profit_lock");
  });

  it("zero activation settings disable each protection without disabling peak observation", () => {
    const h = fixture();
    h.e.breakevenAtR = h.e.trailActivationR = h.e.profitLockAtR = h.e.reviewMinR = 0;
    expect(profitStopCandidate(h.ctx)).toMatchObject({stopPx: null, reason: null, peakPx: 103});
    expect(profitStopCandidate(h.ctx)!.peakNetPerUnit).toBeGreaterThan(0);
    expect(profitReviewKey(h.ctx)).toBeNull();
    expect(profitReviewMenu(h.ctx)).toEqual({});
  });

  it("rejects missing, stale, future and crossed quotes and invalid quantity/risk", () => {
    const h = fixture();
    h.t.ts = NOW - h.cfg.maxTickerAgeMs - 1;
    expect(profitMetrics(h.ctx)).toBeNull(); expect(profitStopCandidate(h.ctx)).toBeNull(); expect(profitReviewMenu(h.ctx)).toEqual({});
    h.t.ts = NOW + 1;
    expect(profitMetrics(h.ctx)).toBeNull();
    h.t.ts = NOW; h.t.bid = h.t.ask + 1;
    expect(profitMetrics(h.ctx)).toBeNull();
    h.t.bid = h.t.mid * .999; h.p.riskUsd = 0;
    expect(profitMetrics(h.ctx)).toBeNull();
    h.p.riskUsd = 10; h.inst.ctVal = 0;
    expect(profitMetrics(h.ctx)).toBeNull();
    h.inst.ctVal = 1; h.ctx.view.tickers.clear();
    expect(profitMetrics(h.ctx)).toBeNull();
  });

  it("keeps a losing mark out of discretionary profit-taking even with a profitable prior peak", () => {
    const h = fixture("long", 100, "tiger", {exitPeakNetPerUnit: 4});
    expect(profitMetrics(h.ctx)!.netPnlUsd).toBeLessThan(0);
    expect(profitReviewKey(h.ctx)).toBeNull();
    expect(takeProfitContracts(h.ctx)).toBe(0);
  });

  it("cadences profit reviews independently and offers optional model-driven actions without a forced HOLD", () => {
    const h = fixture(), key = profitReviewKey(h.ctx)!;
    expect(key).toBe(`${h.p.openedAt}:${Math.floor(NOW / 60000)}`);
    h.ctx.now += 1000;
    expect(profitReviewKey(h.ctx)).toBe(key);
    h.ctx.now = NOW + 60000; h.t.ts = h.ctx.now;
    expect(profitReviewKey(h.ctx)).not.toBe(key);
    expect(profitReviewMenu(h.ctx)).toMatchObject({
      CLOSE_PROFIT: {intent: {kind: "close", reason: "model_profit_take"}},
      TAKE_PROFIT: {intent: {kind: "trim", fraction: .5, reason: "profit_take"}},
    });
    expect(profitReviewMenu(h.ctx)).not.toHaveProperty("HOLD");
    h.p.profitTaken = true;
    expect(profitReviewMenu(h.ctx)).not.toHaveProperty("TAKE_PROFIT");
    expect(profitReviewMenu(h.ctx)).toHaveProperty("CLOSE_PROFIT");
  });

  it("floors partials to lots and rejects exchange dust, disabled partials, and repeat profit sales", () => {
    const h = fixture();
    h.p.contracts = 11; h.inst.lotSz = 2; h.inst.minSz = 2;
    expect(takeProfitContracts(h.ctx)).toBe(4);
    h.p.contracts = 3;
    expect(takeProfitContracts(h.ctx)).toBe(0);
    h.p.contracts = 5; h.inst.minSz = 4;
    expect(takeProfitContracts(h.ctx)).toBe(0);
    h.p.contracts = 10; h.inst.lotSz = h.inst.minSz = 1;
    h.e.partialTakeProfitEnabled = false;
    expect(takeProfitContracts(h.ctx)).toBe(0);
    h.e.partialTakeProfitEnabled = true; h.p.profitTaken = true;
    expect(takeProfitContracts(h.ctx)).toBe(0);
  });

  it("does not mutate the ledger position while proposing protection", () => {
    const h = fixture(), before = structuredClone(h.p);
    profitMetrics(h.ctx); profitStopCandidate(h.ctx); profitReviewMenu(h.ctx);
    expect(h.p).toEqual(before);
  });
});
