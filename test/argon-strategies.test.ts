// Upstream strategy behavior regression suite, adapted for Catfolio identities (MIT, 6cf999a).
import { describe, expect, it } from "vitest";
import { MARGIN_HEADROOM } from "../src/bees/common.js";
import { bizzy, fadeSetup } from "../src/bees/argon-bizzy.js";
import { boozy, BOOZY_MIN_HOLD_MIN, rankCandidates } from "../src/bees/argon-boozy.js";
import { breezy, breezySizeFrac } from "../src/bees/argon-breezy.js";
import { loadConfig } from "../src/config.js";
import { applyRisk } from "../src/risk.js";
import { buildSnapshot } from "../src/snapshot.js";
import { bee as fixtureBee, coin, ctx as fixtureCtx, NOW, position, trend, view } from "./fixtures.js";
import type { BeeState } from "../src/bees/types.js";
import type { BeeId, StyleId } from "../src/config.js";
const testConfig = (env: Record<string,string> = {}) => loadConfig({TOTAL_START_EQUITY_USD:"666", STRATEGY_ENGINE:"upstream", ...env});
const bee = (id: StyleId | BeeId, over: Partial<BeeState> = {}) => fixtureBee(id === "breezy" ? "mochi" : id === "bizzy" || id === "boozy" ? "tiger" : id, over);
const ctx: typeof fixtureCtx = (id,b,v,cfg=testConfig(),now=NOW) => fixtureCtx(id,b,v,cfg,now);

const HOLDS = ["HOLD", "HOLD_WINNER", "RIDE"];

describe("no forced entries (neverForce across all three bees)", () => {
  const v = view([
    coin("BTC", { trend: trend({ score: 1 }), pctB: 0.5, rsi14: 50, ret24hPct: 0.2 }, 80000),
    coin("ETH", { trend: trend({ score: -1 }), pctB: 0.5, rsi14: 50, ret24hPct: -0.3 }, 2700),
    coin("SOL", { ret24hPct: 0.4, rsi14: 50, pctB: 0.5 }),
  ]);
  for (const [id, brain] of [["bizzy", bizzy], ["breezy", breezy], ["boozy", boozy]] as const) {
    it(`${id}: never forces an entry when flat in chop, even after hours flat`, () => {
      expect(brain.neverForce).toBe(true);
      expect(brain.forcedEntry(ctx(id, bee(id), v))).toBeNull();
      const m = brain.menu(ctx(id, bee(id), v));
      expect(Object.keys(m)).toEqual([]);
      const res = applyRisk({
        ctx: ctx(id, bee(id, { flatSince: NOW - 10 * 3600_000 }), v),
        brain,
        proposal: null,
        jev: "no_options",
        sizeMult: 1,
        dataAgeMs: 1000,
        maxDataAgeMs: 120_000,
      });
      expect(res.action).toEqual({ kind: "none" });
      expect(res.forcedBy).toBeNull();
    });

    it(`${id}: positioned menu always offers a hold`, () => {
      const b = bee(id, { position: position(v.stats.get("SOL-USD_UM_XPERP-310404")!), flatSince: null });
      if (id === "breezy") b.position = position(v.stats.get("BTC-USD_UM_XPERP-310404")!);
      const m = brain.menu(ctx(id, b, v));
      expect(HOLDS.some((h) => m[h])).toBe(true);
    });
  }
});

describe("bizzy setups (Bollinger+RSI fades + confirmed breakouts)", () => {
  it("strict long needs rsi<30 AND close below the lower band", () => {
    expect(fadeSetup(coin("BTC", { rsi14: 29, pctB: -0.01 }))).toMatchObject({ side: "long", strict: true });
    expect(fadeSetup(coin("BTC", { rsi14: 31, pctB: -0.01 }))).toBeNull();
    expect(fadeSetup(coin("BTC", { rsi14: 29, pctB: 0.01 }))).toBeNull();
  });

  it("strict short needs rsi>70 AND close above the upper band", () => {
    expect(fadeSetup(coin("BTC", { rsi14: 71, pctB: 1.01 }))).toMatchObject({ side: "short", strict: true });
    expect(fadeSetup(coin("BTC", { rsi14: 69, pctB: 1.01 }))).toBeNull();
  });

  it("funding z > 1.5 blocks the long setup and z < -1.5 blocks the short setup", () => {
    expect(fadeSetup(coin("BTC", { rsi14: 25, pctB: -0.2, fundingZ: 1.6 }))).toBeNull();
    expect(fadeSetup(coin("BTC", { rsi14: 75, pctB: 1.2, fundingZ: -1.6 }))).toBeNull();
  });

  const lvl = { dayOpen: 100, prevRange: 4, trigger: 102 };
  it("offers FADE_LONG, FADE_SHORT, and confirmed BREAKOUT_<coin> at 0.5 sizeFrac (1x equity)", () => {
    const through = coin("SOL", { breakout: lvl, ret1hPct: 0.8 }, 102.5);
    const oversold = coin("ETH", { rsi14: 24, pctB: -0.15 }, 2500);
    const overbought = coin("BTC", { rsi14: 76, pctB: 1.12 }, 83000);
    const m = bizzy.menu(ctx("bizzy", bee("bizzy"), view([through, oversold, overbought])));
    expect(m.BREAKOUT_SOL!.intent).toMatchObject({ kind: "open", side: "long", sizeFrac: 0.5, setup: "strict" });
    expect(m.FADE_LONG_ETH!.intent).toMatchObject({ kind: "open", side: "long", sizeFrac: 0.5, setup: "strict" });
    expect(m.FADE_SHORT_BTC!.intent).toMatchObject({ kind: "open", side: "short", sizeFrac: 0.5, setup: "strict" });
    expect(m.WAIT).toBeDefined();
  });

  it("positioned: offers TAKE_PROFIT at middle band or +1R, and CUT_LOSS when losing", () => {
    const s = coin("ETH", { bbMid: 2500, pctB: 0.55 }, 2510);
    const win = bizzy.menu(ctx("bizzy", bee("bizzy", { position: position(s, { entryPx: 2480 }), flatSince: null, uplUsd: 5 }), view([s])));
    expect(win.HOLD).toBeDefined();
    expect(win.TAKE_PROFIT).toBeDefined();
    expect(win.CUT_LOSS).toBeUndefined();

    // Losing and held 20 minutes: CUT_LOSS is offered (riskUsd 10, so -3 is only -0.3R).
    const lose = bizzy.menu(ctx("bizzy", bee("bizzy", { position: position(s, { openedAt: NOW - 20 * 60_000 }), flatSince: null, uplUsd: -3 }), view([s])));
    expect(lose.CUT_LOSS).toBeDefined();
  });

  it("CUT_LOSS is not offered on the spread right after entry: only after 20 min, or at -0.5R or worse", () => {
    const s = coin("ETH", { bbMid: 2600, pctB: 0.2 }, 2500);
    const at = (heldMin: number, uplUsd: number) =>
      bizzy.menu(ctx("bizzy", bee("bizzy", { position: position(s, { openedAt: NOW - heldMin * 60_000, riskUsd: 10 }), flatSince: null, uplUsd }), view([s]))).CUT_LOSS;
    expect(at(0, -0.2)).toBeUndefined(); // straight after the entry, red by the spread and fee
    expect(at(19, -4.9)).toBeUndefined(); // 19 min, -0.49R
    expect(at(20, -0.2)).toBeDefined(); // 20 min held
    expect(at(1, -5)).toBeDefined(); // -0.5R: a real loser, at once
    expect(at(1, -8)).toBeDefined();
    expect(at(30, 1)).toBeUndefined(); // never on a winner
  });

  it("the hard stop and the time stop still fire inside the first 20 minutes", () => {
    const s = coin("ETH", {}, 2500);
    const run = (over: Parameters<typeof position>[1]) =>
      applyRisk({ ctx: ctx("bizzy", bee("bizzy", { position: position(s, over), flatSince: null, uplUsd: -1 }), view([s])), brain: bizzy, proposal: { label: "HOLD", intent: { kind: "hold" }, prob: 1, conviction: 1 }, jev: "ok", sizeMult: 1, dataAgeMs: 1000, maxDataAgeMs: 120_000 });
    expect(run({ openedAt: NOW - 60_000, stopPx: 2501 }).forcedBy).toBe("stop");
  });

  it("boozy and breezy have no exit on red straight after entry either", () => {
    // boozy: BAIL (offered on red or a fading 1h move) is locked for his first 30 minutes.
    const b = coin("SOL", { ret1hPct: -1 });
    expect(boozy.menu(ctx("boozy", bee("boozy", { position: position(b, { openedAt: NOW - 60_000 }), flatSince: null, uplUsd: -2 }), view([b]))).BAIL).toBeUndefined();
    // breezy: exits follow the trend score, not P&L; a red position in a live trend only holds.
    const t = coin("BTC", { trend: trend({ score: 6 }) }, 80000);
    const m = breezy.menu(ctx("breezy", bee("breezy", { position: position(t, { openedAt: NOW - 60_000, entryScore: 6 }), flatSince: null, uplUsd: -3 }), view([t])));
    expect(Object.values(m).some((o) => o.intent.kind === "close" || o.intent.kind === "trim")).toBe(false);
  });
});

describe("breezy (gated Donchian ensemble, no chop floor, safe rebalance)", () => {
  it("returns 0 size in chop (|score| < 3) and scales |score|/9 under 40% vol cap when |score| >= 3", () => {
    const b = bee("breezy");
    const calmStrong = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) });
    expect(breezySizeFrac(calmStrong, ctx("breezy", b, view([calmStrong])))).toBe(1);

    const wildStrong = coin("BTC", { trend: trend({ score: 9, rv90Pct: 100 }) });
    expect(breezySizeFrac(wildStrong, ctx("breezy", b, view([wildStrong])))).toBeCloseTo((333 * 0.4) / (666 * MARGIN_HEADROOM), 6);

    const chopZero = coin("BTC", { trend: trend({ score: 0, rv90Pct: 50 }) });
    expect(breezySizeFrac(chopZero, ctx("breezy", b, view([chopZero])))).toBe(0);

    const chopWeak = coin("BTC", { trend: trend({ score: 2, rv90Pct: 50 }) });
    expect(breezySizeFrac(chopWeak, ctx("breezy", b, view([chopWeak])))).toBe(0);

    const threshold = coin("BTC", { trend: trend({ score: -3, rv90Pct: 20 }) });
    expect(breezySizeFrac(threshold, ctx("breezy", b, view([threshold])))).toBeCloseTo(3 / 9, 6);
  });

  it("rebalances up only when in profit (uplR > 0.5), >35% below target, and caps against realised cashUsd", () => {
    const s = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) }, 80000);
    const v = view([s]);
    // Winning position (uplUsd = 10 on riskUsd = 10 -> uplR = 1.0), small 100 contract position
    const winningUndersized = bee("breezy", {
      cashUsd: 320,
      equityUsd: 370,
      uplUsd: 10,
      position: position(s, { contracts: 100, riskUsd: 10 }),
      flatSince: null,
    });
    const reb = breezy.rebalance!(ctx("breezy", winningUndersized, v));
    expect(reb).toMatchObject({ kind: "add" });
    // Usable max is based on cashUsd (320), not inflated equityUsd (370)
    const usableMax = 320 * 2 * MARGIN_HEADROOM;
    expect(reb!.sizeFrac).toBeCloseTo((usableMax - 100) / usableMax, 6);

    // Losing or flat position (uplUsd = 0) never rebalances
    const flatPnl = bee("breezy", { position: position(s, { contracts: 100, riskUsd: 10 }), flatSince: null, uplUsd: 0 });
    expect(breezy.rebalance!(ctx("breezy", flatPnl, v))).toBeNull();
  });

  it("TRIM_HALF when score falls by 3+, CLOSE_TREND when score turns against position", () => {
    const s = coin("BTC", { trend: trend({ score: 4 }) }, 80000);
    const v = view([s]);
    expect(breezy.menu(ctx("breezy", bee("breezy", { position: position(s, { entryScore: 7 }), flatSince: null }), v)).TRIM_HALF).toBeDefined();
    expect(breezy.menu(ctx("breezy", bee("breezy", { position: position(s, { entryScore: 6 }), flatSince: null }), v)).TRIM_HALF).toBeUndefined();

    const stalled = coin("BTC", { trend: trend({ score: 0 }) }, 80000);
    expect(breezy.menu(ctx("breezy", bee("breezy", { position: position(stalled, { entryScore: 5 }), flatSince: null }), view([stalled]))).CLOSE_TREND).toBeDefined();
  });
});

describe("boozy (liquid long/short impulse momentum, 30m hold unlock, single pyramid)", () => {
  it("filters out illiquid (<$15M vol) and high-spread coins, and offers both APE_<coin> and SHORT_<coin>", () => {
    const sol = coin("SOL", { ret24hPct: 6.5, ret1hPct: 1.2, oiChg1hPct: 1.5, rsi14: 62, vol24hUsd: 80e6, volZ: 2 });
    const doge = coin("DOGE", { ret24hPct: -5.2, ret1hPct: -0.9, oiChg1hPct: 0.5, rsi14: 35, vol24hUsd: 50e6, volZ: 1.5 });
    const pump = coin("PUMP", { ret24hPct: 25, ret1hPct: 4, vol24hUsd: 3e6 }); // below $15M volume gate
    const ray = coin("RAY", { ret24hPct: 17, spreadBp: 58.6, vol24hUsd: 40e6 }); // above spread gate
    const v = view([sol, doge, pump, ray]);

    const ranked = rankCandidates(v, 8).map((c) => c.s.coin);
    expect(ranked).toContain("SOL");
    expect(ranked).toContain("DOGE");
    expect(ranked).not.toContain("PUMP");
    expect(ranked).not.toContain("RAY");

    const m = boozy.menu(ctx("boozy", bee("boozy"), v));
    expect(m.APE_SOL?.intent).toMatchObject({ kind: "open", side: "long", sizeFrac: 0.5, setup: "strict" });
    expect(m.SHORT_DOGE?.intent).toMatchObject({ kind: "open", side: "short", sizeFrac: 0.5, setup: "strict" });
  });

  it("unlocks BAIL, SWITCH_COIN, and FLIP_SHORT after 30 minutes (not 24 hours)", () => {
    expect(BOOZY_MIN_HOLD_MIN).toBe(30);
    const s = coin("SOL", { ret1hPct: -1.2, oiChg1hPct: -2.0, ret24hPct: -2 });
    const leader = coin("SUI", { ret24hPct: 8, ret1hPct: 1.5, oiChg1hPct: 1.2, rsi14: 60, volZ: 2 });
    const v = view([s, leader]);

    const young = boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { openedAt: NOW - 15 * 60_000 }), flatSince: null }), v));
    expect(young.BAIL ?? young.SWITCH_COIN ?? young.FLIP_SHORT).toBeUndefined();
    expect(young.RIDE).toBeDefined();

    const unlocked = boozy.menu(
      ctx(
        "boozy",
        bee("boozy", {
          position: position(s, { openedAt: NOW - 35 * 60_000 }),
          flatSince: null,
          uplUsd: -2,
          top1: { coin: "SUI", streak: 2, rankedAt: NOW },
        }),
        v,
      ),
    );
    expect(unlocked.BAIL).toBeDefined();
    expect(unlocked.SWITCH_COIN).toBeDefined();
    expect(unlocked.FLIP_SHORT).toBeDefined();
  });

  it("DOUBLE_DOWN triggers after +1.5 ATR(1h) run and caps total size at 1.5x equity", () => {
    // atr14Pct 0.5 at price 100 -> 15m ATR = 0.5, 1h ATR = 1.0 -> needs 1.5 move (entry <= 98.5)
    const s = coin("SOL", { ret1hPct: 1.0 }, 100);
    const v = view([s]);
    const ran = boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { entryPx: 98.4, contracts: 320 }), flatSince: null }), v));
    expect(ran.DOUBLE_DOWN!.intent).toMatchObject({ kind: "add", sizeFrac: 0.25 });

    // Already pyramided to ~1.5x (480 contracts on $333 equity) -> no second DOUBLE_DOWN
    const capped = boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { entryPx: 96.0, contracts: 480 }), flatSince: null }), v));
    expect(capped.DOUBLE_DOWN).toBeUndefined();
  });
});

describe("no averaging down (only boozy's DOUBLE_DOWN after +1.5 ATR(1h), with protectAdds)", () => {
  it("boozy: no DOUBLE_DOWN on a loser or a small run, and the add never takes the total past 0.75 of max", () => {
    const s = coin("SOL", { ret1hPct: 1.0 }, 100); // ATR(1h) = 1.0
    const v = view([s]);
    const menuFor = (entryPx: number, contracts: number) =>
      boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { entryPx, contracts }), flatSince: null }), v));
    expect(menuFor(101, 200).DOUBLE_DOWN).toBeUndefined(); // losing
    expect(menuFor(98.6, 200).DOUBLE_DOWN).toBeUndefined(); // only 1.4 ATR in profit
    const max = 2 * 333 * MARGIN_HEADROOM;
    // 0.69 of max held: the add is clamped to the 0.06 of max left under 0.75, not a full 0.25.
    const dd = menuFor(98.4, Math.round(0.69 * max)).DOUBLE_DOWN!;
    expect(dd.intent.kind).toBe("add");
    const frac = (dd.intent as { sizeFrac: number }).sizeFrac;
    expect(Math.round(0.69 * max) + frac * max).toBeLessThanOrEqual(0.75 * max + 1e-9);
    expect(boozy.protectAdds).toBe(true);
  });

  it("breezy: ADD_TO_WINNER only above +1R, never on a loser; rebalance only above +0.5R", () => {
    const s = coin("BTC", { trend: trend({ score: 7, rv90Pct: 20 }) }, 80000);
    const v = view([s]);
    const at = (uplUsd: number) => ctx("breezy", bee("breezy", { position: position(s, { contracts: 100, riskUsd: 10 }), flatSince: null, uplUsd }), v);
    expect(breezy.menu(at(-5)).ADD_TO_WINNER).toBeUndefined();
    expect(breezy.menu(at(10)).ADD_TO_WINNER).toBeUndefined();
    expect(breezy.menu(at(11)).ADD_TO_WINNER).toBeDefined();
    expect(breezy.rebalance!(at(-5))).toBeNull();
    expect(breezy.rebalance!(at(5))).toBeNull();
    expect(breezy.protectAdds).toBe(true);
  });

  it("bizzy never adds", () => {
    const s = coin("ETH", {}, 2500);
    for (const uplUsd of [-10, 0, 50]) {
      const m = bizzy.menu(ctx("bizzy", bee("bizzy", { position: position(s), flatSince: null, uplUsd }), view([s])));
      expect(Object.values(m).some((o) => o.intent.kind === "add")).toBe(false);
    }
    expect(bizzy.rebalance).toBeUndefined();
  });
});

describe("boozy's $15M volume floor is absolute", () => {
  it("no candidates at all when nothing clears $15M (it used to fall back to the thin coins)", () => {
    const thin = coin("THIN", { ret24hPct: 9, ret1hPct: 2, oiChg1hPct: 1, vol24hUsd: 3e6 });
    const v = view([thin]);
    expect(rankCandidates(v, 8)).toEqual([]);
    expect(boozy.menu(ctx("boozy", bee("boozy"), v))).toEqual({});
  });
});

describe("handling of the three live open positions on 13 Oct 2026", () => {
  it("bizzy open ETH long (held > 14h, uPnL -$1.37) is closed immediately by the 240m time stop", () => {
    const eth = coin("ETH", { breakout: { dayOpen: 2480, prevRange: 60, trigger: 2510 } }, 2507.79);
    const v = view([eth]);
    // dayStartEquityUsd: the bee started the UTC day near its cash, not at the $333 stake (the fixture default),
    // otherwise the -12% from the stake trips the daily loss stop first and masks the time stop.
    const b = bee("bizzy", {
      cashUsd: 293.48,
      equityUsd: 292.11,
      dayStartEquityUsd: 293.48,
      uplUsd: -1.37,
      position: position(eth, {
        side: "long",
        entryPx: 2513.8,
        openedAt: NOW - Math.round(14.77 * 3600_000),
        stopPx: 2480,
      }),
      flatSince: null,
    });
    const res = applyRisk({
      ctx: ctx("bizzy", b, v),
      brain: bizzy,
      proposal: { label: "HOLD", intent: { kind: "hold" }, prob: 1, conviction: 2 },
      jev: "ok",
      sizeMult: 1,
      dataAgeMs: 1000,
      maxDataAgeMs: 120_000,
    });
    expect(res.action).toEqual({ kind: "close", reason: "time_stop" });
    expect(res.forcedBy).toBe("time_stop");
  });

  it("breezy open ETH short (uPnL +$3.09) holds winner and trails stop downward", () => {
    const eth = coin("ETH", { trend: trend({ score: -6, trailStop: 2540, atr4hPct: 1.8, rv90Pct: 45 }), ret24hPct: -3.2 }, 2507.79);
    const v = view([eth]);
    const b = bee("breezy", {
      cashUsd: 317.23,
      equityUsd: 320.32,
      uplUsd: 3.09,
      position: position(eth, {
        side: "short",
        entryPx: 2533.5,
        openedAt: NOW - Math.round(14.1 * 3600_000),
        stopPx: 2580,
        riskUsd: 6,
      }),
      flatSince: null,
    });
    const c = ctx("breezy", b, v);
    const m = breezy.menu(c);
    expect(m.HOLD_WINNER).toBeDefined();
    expect(breezy.trail!(c)).toBe(2540);
  });

  it("boozy open BTC long (held 96m, uPnL +$0.52) is unlocked from 24h lockup and rides or bails on 1h momentum", () => {
    const btc = coin("BTC", { ret1hPct: 0.4, ret24hPct: 1.8, oiChg1hPct: 0.5 }, 83179.45);
    const v = view([btc]);
    const b = bee("boozy", {
      cashUsd: 172.53,
      equityUsd: 173.05,
      uplUsd: 0.52,
      position: position(btc, {
        side: "long",
        entryPx: 82920,
        openedAt: NOW - 96 * 60_000,
        stopPx: 80500,
      }),
      flatSince: null,
    });
    const m = boozy.menu(ctx("boozy", b, v));
    expect(m.RIDE).toBeDefined();
    expect(m.BAIL).toBeUndefined();
  });
});

describe("snapshot (phase 3 budget: < 400 tokens)", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    coin(`C${i}`, { rsi14: 12.3456, pctB: -0.123456, ret24hPct: 10 - i, ret7dPct: 3.3333, fundingPct: 0.0123456, fundingZ: 1.23456, oiChg1hPct: -2.2222, volZ: 1.1111, trend: i < 2 ? trend({ score: 7, trailStop: 95 }) : undefined }, 0.0012345),
  );
  const v = view(many);
  for (const [id, brain] of [["bizzy", bizzy], ["breezy", breezy], ["boozy", boozy]] as const) {
    it(`${id} stays well under 400 tokens`, () => {
      const s = buildSnapshot(brain, ctx(id, bee(id), v));
      expect(s.approxTokens).toBeLessThan(400);
      expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    });
  }
  it("contains numbers and labels, never account data", () => {
    const s = JSON.stringify(buildSnapshot(boozy, ctx("boozy", bee("boozy"), v)).state);
    expect(s).not.toMatch(/uid|subacct|key|secret/i);
  });
});
