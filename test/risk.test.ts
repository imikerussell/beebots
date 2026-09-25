// Phase 5: every cap, gate and forcing rule, in both directions.
import { describe, expect, it } from "vitest";
import { bizzy } from "../src/bees/bizzy.js";
import { boozy } from "../src/bees/boozy.js";
import { breezy } from "../src/bees/breezy.js";
import type { BeeBrain, BeeContext, Intent } from "../src/bees/types.js";
import { applyRisk, evaluateCaps, type JevStatus, type Proposal, type RiskInput } from "../src/risk.js";
import { bee, coin, ctx, NOW, position, testConfig, trend, view } from "./fixtures.js";

const open = (instId: string, side: "long" | "short" = "long", setup: "strict" | "loose" = "strict", sizeFrac = 1): Intent => ({ kind: "open", instId, side, sizeFrac, setup });
const prop = (intent: Intent, prob = 0.9, conviction = 3, label = "X"): Proposal => ({ label, intent, prob, conviction });

function run(c: BeeContext, brain: BeeBrain, proposal: Proposal | null, jev: JevStatus = "ok", extra: Partial<RiskInput> = {}) {
  return applyRisk({ ctx: c, brain, proposal, jev, sizeMult: 1, dataAgeMs: 1000, maxDataAgeMs: 210_000, ...extra });
}

const SOL = coin("SOL");
const V = view([SOL, coin("BTC", { trend: trend({ score: 5 }) }, 80000), coin("ETH", { trend: trend({ score: -2 }) }, 2700)]);

describe("caps", () => {
  it("daily loss stop trips at -8% and stays quiet at -7.9%", () => {
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 306.3, dayStartEquityUsd: 333 }), V)).cap).toBe("loss_stop");
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 306.8, dayStartEquityUsd: 333 }), V)).cap).toBeNull();
  });

  it("retire line trips at 40% of start and not above it", () => {
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 133, dayStartEquityUsd: 133 }), V)).cap).toBe("retired");
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 134, dayStartEquityUsd: 134 }), V)).cap).toBeNull();
  });

  it("trade cap trips at the max and not one below", () => {
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 1 }), V)).cap).toBe("trade_cap");
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 0 }), V)).cap).toBeNull();
  });

  it("fee budget trips when spent and not before", () => {
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { feesTodayUsd: 1.0 }), V)).cap).toBe("fee_budget");
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { feesTodayUsd: 0.99 }), V)).cap).toBeNull();
  });

  it("reports a trip only once", () => {
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 1 }), V)).tripped).toBe("trade_cap");
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 6, cap: "trade_cap" }), V)).tripped).toBeNull();
  });

  it("a loss stop escalates over an active trade cap", () => {
    const r = evaluateCaps(ctx("bizzy", bee("bizzy", { cap: "trade_cap", tradesToday: 6, equityUsd: 300, dayStartEquityUsd: 333 }), V));
    expect(r).toEqual({ cap: "loss_stop", tripped: "loss_stop" });
  });
});

describe("loss stop and retire go flat", () => {
  it("closes an open position on the loss stop, even if Jev says ride", () => {
    const b = bee("boozy", { equityUsd: 300, dayStartEquityUsd: 333, position: position(SOL), flatSince: null });
    const r = run(ctx("boozy", b, V), boozy, prop({ kind: "hold" }));
    expect(r.action).toEqual({ kind: "close", reason: "loss_stop" });
    expect(r.forcedBy).toBe("loss_stop");
  });

  it("when flat and sent home, never forces an entry", () => {
    const b = bee("boozy", { equityUsd: 300, dayStartEquityUsd: 333, flatSince: NOW - 3_600_000 });
    const r = run(ctx("boozy", b, V), boozy, prop(open(SOL.instId)));
    expect(r.action.kind).toBe("none");
    expect(r.status).toMatch(/sent home/);
  });
});

describe("code stops", () => {
  it("stop fires when mark crosses it (long) and not before", () => {
    const hit = bee("bizzy", { position: position(SOL, { stopPx: 100.5 }), flatSince: null });
    expect(run(ctx("bizzy", hit, V), bizzy, prop({ kind: "hold" })).action).toEqual({ kind: "close", reason: "stop" });
    const safe = bee("bizzy", { position: position(SOL, { stopPx: 99 }), flatSince: null });
    expect(run(ctx("bizzy", safe, V), bizzy, prop({ kind: "hold" })).action.kind).toBe("none");
  });

  it("short stop fires above", () => {
    const b = bee("bizzy", { position: position(SOL, { side: "short", stopPx: 99.5 }), flatSince: null });
    expect(run(ctx("bizzy", b, V), bizzy, prop({ kind: "hold" })).forcedBy).toBe("stop");
  });

  it("stops fire even while Jev is unreachable", () => {
    const b = bee("bizzy", { position: position(SOL, { stopPx: 101 }), flatSince: null });
    expect(run(ctx("bizzy", b, V), bizzy, null, "unreachable").action.kind).toBe("close");
  });

  it("bizzy rides to the UTC day close: yesterday's trade is closed, today's is not", () => {
    // NOW is 12:00 UTC. Opened 23:00 yesterday: its day closed at 23:59, so the time stop fires.
    const old = bee("bizzy", { position: position(SOL, { openedAt: NOW - 13 * 60 * 60_000 }), flatSince: null });
    expect(run(ctx("bizzy", old, V), bizzy, prop({ kind: "hold" })).forcedBy).toBe("time_stop");
    const today = bee("bizzy", { position: position(SOL, { openedAt: NOW - 11 * 60 * 60_000 }), flatSince: null });
    expect(run(ctx("bizzy", today, V), bizzy, prop({ kind: "hold" })).forcedBy).toBeNull();
  });

  it("boozy has no time stop", () => {
    const b = bee("boozy", { position: position(SOL, { openedAt: NOW - 24 * 60 * 60_000 }), flatSince: null });
    expect(run(ctx("boozy", b, V), boozy, prop({ kind: "hold" })).action.kind).toBe("none");
  });
});

describe("Jev fail-closed", () => {
  it("unreachable: holds a position and opens nothing, even when flat past the limit", () => {
    const flat = bee("boozy", { flatSince: NOW - 3_600_000 });
    const r = run(ctx("boozy", flat, V), boozy, null, "unreachable");
    expect(r.action.kind).toBe("none");
    expect(r.vetoedBy).toBe("jev_unreachable");
  });

  it("daily cap: all bees hold", () => {
    const r = run(ctx("breezy", bee("breezy"), V), breezy, null, "daily_cap");
    expect(r.action.kind).toBe("none");
    expect(r.status).toMatch(/daily cap/);
  });

  it("a healthy Jev answer goes through", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)));
    expect(r.action.kind).toBe("open");
    expect(r.vetoedBy).toBeNull();
  });
});

describe("trade cap and fee budget: hold or close only", () => {
  it("vetoes an open when the trade cap is hit", () => {
    const b = bee("bizzy", { tradesToday: 1 });
    const r = run(ctx("bizzy", b, V), bizzy, prop(open(SOL.instId)));
    expect(r.vetoedBy).toBe("trade_cap");
    expect(r.action.kind).toBe("none");
  });

  it("still allows a close when capped", () => {
    const b = bee("bizzy", { tradesToday: 6, position: position(SOL), flatSince: null });
    const r = run(ctx("bizzy", b, V), bizzy, prop({ kind: "close", reason: "cut_loss" }));
    expect(r.action).toEqual({ kind: "close", reason: "cut_loss" });
  });

  it("vetoes a switch and a double-down under the fee budget", () => {
    const b = bee("boozy", { feesTodayUsd: 3, position: position(SOL), flatSince: null });
    expect(run(ctx("boozy", b, V), boozy, prop({ kind: "switch", instId: "BTC-USD_UM_XPERP-310404", side: "long", sizeFrac: 1, setup: "strict" })).vetoedBy).toBe("fee_budget");
    expect(run(ctx("boozy", b, V), boozy, prop({ kind: "add", sizeFrac: 1 })).vetoedBy).toBe("fee_budget");
  });

  it("suspends the never-flat forcing while benched", () => {
    const b = bee("boozy", { tradesToday: 3, flatSince: NOW - 3_600_000 });
    const r = run(ctx("boozy", b, V), boozy, prop(open(SOL.instId)));
    expect(r.action.kind).toBe("none");
    expect(r.forcedBy).toBeNull();
    expect(r.status).toMatch(/benched: all 3 trades used today/);
  });
});

describe("spread gate", () => {
  it("vetoes a coin above the bee's gate", () => {
    const RAY = coin("RAY", { spreadBp: 58.6 });
    const v = view([RAY, SOL]);
    const r = run(ctx("boozy", bee("boozy", { flatSince: NOW }), v), boozy, prop(open(RAY.instId)));
    expect(r.vetoedBy).toMatch(/^spread_gate RAY 58.6bp/);
  });

  it("allows a coin at exactly the gate", () => {
    const X = coin("X", { spreadBp: 15 });
    const r = run(ctx("boozy", bee("boozy"), view([X])), boozy, prop(open(X.instId)));
    expect(r.action.kind).toBe("open");
  });
});

describe("bizzy: waits for her breakout", () => {
  it("is never forced in, however long she has been flat", () => {
    const b = bee("bizzy", { flatSince: NOW - 10 * 60 * 60_000 });
    const r = run(ctx("bizzy", b, view([coin("SOL", { breakout: { dayOpen: 100, prevRange: 4, trigger: 102 } }, 101)])), bizzy, null, "no_options");
    expect(r.forcedBy).toBeNull();
    expect(r.action.kind).toBe("none");
    expect(r.status).toBe("SOL is 0.99% from breakout");
  });

  it("takes the breakout at full size (2x)", () => {
    const r = run(ctx("bizzy", bee("bizzy"), V), bizzy, prop(open(SOL.instId, "long", "strict", 1)));
    expect(r.action).toMatchObject({ kind: "open", notionalUsd: 666 });
  });
});

describe("breezy: open gate and never flat", () => {
  const BTC = V.stats.get("BTC-USD_UM_XPERP-310404")!;

  it("opens with p >= 0.70 and conviction >= strong", () => {
    const r = run(ctx("breezy", bee("breezy"), V), breezy, prop(open(BTC.instId, "long", "strict", 5 / 9), 0.7, 2));
    expect(r.action.kind).toBe("open");
  });

  it("a weak pick while flat becomes the forced minimum in the stronger |score| direction", () => {
    const r = run(ctx("breezy", bee("breezy", { flatSince: NOW }), V), breezy, prop(open(BTC.instId, "short", "loose", 5 / 9), 0.69, 3));
    expect(r.vetoedBy).toMatch(/^weak_conviction/);
    expect(r.forcedBy).toBe("max_flat");
    expect(r.action).toMatchObject({ kind: "open", instId: BTC.instId, side: "long" });
    // Floor of half of max, or |score|/9 when larger (score 5 -> 5/9), under the 60% vol cap.
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo((5 / 9) * 666, 5);
  });

  it("low conviction with high probability is still vetoed", () => {
    const r = run(ctx("breezy", bee("breezy"), V), breezy, prop(open(BTC.instId), 0.95, 1));
    expect(r.vetoedBy).toMatch(/^weak_conviction/);
  });

  it("a weak flip while positioned becomes HOLD", () => {
    // $400 position: already at target size (5/9 of $666), so no rebalance either.
    const b = bee("breezy", { position: position(BTC, { contracts: 400 }), flatSince: null });
    const r = run(ctx("breezy", b, V), breezy, prop({ kind: "switch", instId: BTC.instId, side: "short", sizeFrac: 0.5, setup: "loose" }, 0.6, 1));
    expect(r.action.kind).toBe("none");
    expect(r.forcedBy).toBeNull();
  });

  it("4h cooldown blocks a discretionary flip, but not the never-flat minimum", () => {
    const b = bee("breezy", { position: position(BTC), flatSince: null, lastOrderAt: NOW - 60 * 60_000 });
    const flip = run(ctx("breezy", b, V), breezy, prop({ kind: "switch", instId: BTC.instId, side: "short", sizeFrac: 0.5, setup: "loose" }, 0.9, 3));
    expect(flip.vetoedBy).toBe("cooldown 180m");
    const flat = bee("breezy", { flatSince: NOW, lastOrderAt: NOW - 60_000 });
    const forced = run(ctx("breezy", flat, V), breezy, prop(open(BTC.instId), 0.9, 3));
    expect(forced.vetoedBy).toBe("cooldown 239m");
    expect(forced.forcedBy).toBe("max_flat");
  });

  it("cooldown is quiet once it has elapsed", () => {
    const b = bee("breezy", { position: position(BTC), flatSince: null, lastOrderAt: NOW - 241 * 60_000 });
    const r = run(ctx("breezy", b, V), breezy, prop({ kind: "switch", instId: BTC.instId, side: "short", sizeFrac: 0.5, setup: "loose" }, 0.9, 3));
    expect(r.action.kind).toBe("switch");
  });
});

describe("breezy: code keeps her at target size", () => {
  it("a HOLD on an undersized position becomes a rebalance add", () => {
    const BTC = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) }, 80000);
    const b = bee("breezy", { position: position(BTC, { contracts: 10 }), flatSince: null });
    const r = run(ctx("breezy", b, view([BTC])), breezy, prop({ kind: "hold" }));
    expect(r.forcedBy).toBe("rebalance");
    expect(r.action).toMatchObject({ kind: "add" });
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(656, 5);
  });
  it("no rebalance while benched", () => {
    const BTC = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) }, 80000);
    const b = bee("breezy", { position: position(BTC, { contracts: 10 }), flatSince: null, tradesToday: 3 });
    expect(run(ctx("breezy", b, view([BTC])), breezy, prop({ kind: "hold" })).forcedBy).toBeNull();
  });
});

describe("boozy: always holding something", () => {
  it("is forced back in one tick after bailing", () => {
    const b = bee("boozy", { flatSince: NOW - 2000 });
    const r = run(ctx("boozy", b, V), boozy, null, "no_options");
    expect(r.forcedBy).toBe("max_flat");
    expect(r.action.kind).toBe("open");
  });

  it("the forced ape is 1x equity (half of max)", () => {
    const r = run(ctx("boozy", bee("boozy", { flatSince: NOW - 2000 }), V), boozy, null, "no_options");
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(0.5 * 666, 5);
  });

  it("always enters at 1x whatever the conviction; size comes from pyramiding", () => {
    expect(run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId, "long", "strict", 0.5), 0.5, 3)).action).toMatchObject({ notionalUsd: 333 });
    expect(run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId, "long", "strict", 0.5), 0.5, 0)).action).toMatchObject({ notionalUsd: 333 });
  });
});

describe("no hold while flat, and menu sanity", () => {
  it("a HOLD while flat is not accepted: forcing kicks in", () => {
    const r = run(ctx("boozy", bee("boozy", { flatSince: NOW - 5000 }), V), boozy, prop({ kind: "hold" }));
    expect(r.action.kind).toBe("open");
    expect(r.forcedBy).toBe("max_flat");
  });

  it("the 30-min global flat rule caps a bee's own limit", () => {
    const cfg = testConfig({ BIZZY_MAX_FLAT_MINUTES: "45" });
    expect(cfg.bees.bizzy.maxFlatMinutes).toBe(30);
    const cfg2 = testConfig({ MAX_FLAT_MINUTES: "10" });
    expect(cfg2.bees.bizzy.maxFlatMinutes).toBe(10);
  });

  it("rejects close while flat and open while positioned", () => {
    expect(run(ctx("bizzy", bee("bizzy", { flatSince: NOW }), V), bizzy, prop({ kind: "close", reason: "x" })).vetoedBy).toBe("invalid_while_flat");
    const b = bee("bizzy", { position: position(SOL), flatSince: null });
    expect(run(ctx("bizzy", b, V), bizzy, prop(open(SOL.instId))).vetoedBy).toBe("invalid_while_positioned");
  });
});

describe("size cap: 2x and the absolute ceiling", () => {
  it("never exceeds MAX_LEVERAGE x equity", () => {
    const r = run(ctx("boozy", bee("boozy", { equityUsd: 200, dayStartEquityUsd: 200 }), V), boozy, prop(open(SOL.instId), 0.9, 3));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBe(400);
  });

  it("never exceeds MAX_NOTIONAL_USD_PER_BEE even with a big (demo) balance", () => {
    const r = run(ctx("boozy", bee("boozy", { equityUsd: 5000, dayStartEquityUsd: 5000 }), V), boozy, prop(open(SOL.instId), 0.9, 3));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBe(700);
  });

  it("refuses MAX_LEVERAGE above 2", () => {
    expect(() => testConfig({ MAX_LEVERAGE: "3" })).toThrow(/Hard rule 3/);
  });

  it("the live ramp shrinks size", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId), 0.9, 3), "ok", { sizeMult: 0.25 });
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(166.5, 5);
  });

  it("double-down is capped at the room left under max", () => {
    const b = bee("boozy", { position: position(SOL, { contracts: 500 }), flatSince: null }); // 500 contracts x $1 = $500
    const r = run(ctx("boozy", b, V), boozy, prop({ kind: "add", sizeFrac: 1 }));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(166, 5);
  });

  it("vetoes an order below the instrument minimum", () => {
    const pricey = coin("BIG");
    const v = view([pricey]);
    v.instruments.get(pricey.instId)!.minSz = 10_000; // min order $10,000
    const r = run(ctx("boozy", bee("boozy"), v), boozy, prop(open(pricey.instId)));
    expect(r.vetoedBy).toMatch(/^below_min_size/);
  });
});

describe("stale data", () => {
  it("blocks opens on stale market data but still lets a close through", () => {
    const stale = { dataAgeMs: 300_000 };
    expect(run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), "ok", stale).vetoedBy).toBe("stale_market_data");
    const b = bee("boozy", { position: position(SOL), flatSince: null });
    expect(run(ctx("boozy", b, V), boozy, prop({ kind: "close", reason: "bail" }), "ok", stale).action.kind).toBe("close");
  });
});
