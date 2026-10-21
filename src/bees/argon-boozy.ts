// Adapted from imikerussell/beebots @ 6cf999a (MIT).
// boozy-bee: liquid multi-horizon impulse momentum (long & short) with strict volume/spread gates,
// 30-min minimum hold (no 24h lockup), 1x entry + single +0.5x pyramid, and neverForce.
import type { CoinStats, MarketView } from "../market/types.js";
import { atrStop, MARGIN_HEADROOM, maxNotionalUsd, minutesSince, positionNotional, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Menu, Side } from "./types.js";

export interface Candidate {
  s: CoinStats;
  score: number;
  attention: number | null;
  impulse: Side | null;
}

function zs(xs: number[]): (x: number) => number {
  const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1;
  return (x) => (x - m) / sd;
}

/** Minimum 24h volume ($15M) so boozy never apes thin pump-and-dump traps like PUMP or GRASS. */
export const BOOZY_MIN_VOL_USD = 15_000_000;
/** Minimum hold before discretionary bail/switch unlocks (30 min, replacing the fatal 24h lockup). */
export const BOOZY_MIN_HOLD_MIN = 30;
/** Close any momentum trade older than 12 hours so stale picks don't bleed out. */
export const BOOZY_TIME_STOP_MIN = 12 * 60;
/** Enter at 1x equity (0.5 of 2x max), allow one +0.5x DOUBLE_DOWN after +1.5 ATR(1h), capped at 1.5x equity (0.75 of max). */
const ENTRY_FRAC = 0.5;
const ADD_FRAC = 0.25;
const MAX_PYRAMID_FRAC = 0.75;

/** 1h ATR is approximated as 2 x the 15m ATR (sqrt of 4 bars). */
const atr1hPx = (s: CoinStats | undefined) => (s && s.atr14Pct !== null ? (s.mid * s.atr14Pct * 2) / 100 : null);
const STOP_ATR1H = 2.5;
const TRAIL_ATR1H = 2.0;

/**
 * Strict impulse qualification:
 * - Long: 24h return >= +1.5%, 1h return >= 0%, 1h OI change >= 0%, RSI <= 78, fundingZ <= 1.5
 * - Short: 24h return <= -1.5%, 1h return < 0%, RSI >= 22
 */
export function impulseSide(s: CoinStats): Side | null {
  const r24 = s.ret24hPct ?? 0;
  const r1 = s.ret1hPct ?? 0;
  const oi1 = s.oiChg1hPct ?? 0;
  const rsi = s.rsi14 ?? 50;
  const fz = s.fundingZ ?? 0;

  if (r24 >= 1.5 && r1 >= 0 && oi1 >= 0 && rsi <= 78 && fz <= 1.5) return "long";
  if (r24 <= -1.5 && r1 < 0 && rsi >= 22) return "short";
  return null;
}

/** Rank liquid coins by multi-horizon momentum (24h + 1h + 7d) plus attention z-score. */
export function rankCandidates(view: MarketView, spreadGateBps: number): Candidate[] {
  // The $15M volume floor is absolute: on a day when nothing clears it, boozy has no candidates and waits.
  const pool = view.gated
    .map((id) => view.stats.get(id))
    .filter((s): s is CoinStats => !!s && s.ret24hPct !== null && s.spreadBp <= spreadGateBps && s.vol24hUsd >= BOOZY_MIN_VOL_USD);
  if (!pool.length) return [];

  const z24 = zs(pool.map((s) => Math.abs(s.ret24hPct!)));
  const z1 = zs(pool.map((s) => Math.abs(s.ret1hPct ?? 0)));
  const z7 = zs(pool.map((s) => Math.abs(s.ret7dPct ?? s.ret24hPct!)));

  return pool
    .map((s) => {
      const attention = s.newsZ ?? s.volZ;
      const impulse = impulseSide(s);
      const rawScore =
        0.45 * z24(Math.abs(s.ret24hPct!)) +
        0.35 * z1(Math.abs(s.ret1hPct ?? 0)) +
        0.2 * z7(Math.abs(s.ret7dPct ?? s.ret24hPct!)) +
        0.25 * Math.max(0, attention ?? 0) +
        (impulse ? 0.5 : 0);
      return { s, score: rawScore, attention, impulse };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The coin to offer a switch into, or null. Only when another coin outranks the held one right now,
 * has a valid impulse, AND was #1 on the last two hourly checks (bee.top1, streak >= 2).
 */
export function switchTarget(ctx: BeeContext, top: Candidate[]): Candidate | null {
  const p = ctx.bee.position;
  if (!p) return null;
  const all = rankCandidates(ctx.view, ctx.knobs.spreadGateBps);
  const heldAt = all.findIndex((c) => c.s.instId === p.instId);
  const leader = top[0];
  if (heldAt < 0 || !leader || leader.s.instId === p.instId || !leader.impulse) return null;
  const { coin, streak } = ctx.bee.top1;
  return coin === leader.s.coin && streak >= 2 ? leader : null;
}

/** Profit lock rungs: bank gains early so impulse spikes never round-trip into full losses. */
export const BOOZY_PROFIT_LOCK = [
  { atPct: 1.5, keep: 0.4 },
  { atPct: 3.0, keep: 0.6 },
  { atPct: 5.0, keep: 0.75 },
] as const;

export const boozy: BeeBrain = {
  id: "boozy",
  neverForce: true,
  requiresStrictSetup: true,
  fundingVetoLongZ: 1.5,
  profitLock: BOOZY_PROFIT_LOCK,
  protectAdds: true,
  timeStopMinutes: () => BOOZY_TIME_STOP_MIN,
  strategy:
    "You are boozy-bee, the reformed degen. Hunt fresh, high-volume momentum impulses (long APE_<coin> on surging 24h+1h+OI breakouts, or SHORT_<coin> on heavy breakdowns) across liquid crypto perpetuals. Never trade thin garbage or unconfirmed chop. Enter at 1x equity, DOUBLE_DOWN once (+0.5x) after a +1.5 ATR(1h) run, and bail or take profit once momentum stalls after 30 minutes.",
  convictionLabels: ["tipsy", "buzzed", "wasted", "legendary"],

  idleStatus(ctx) {
    const top = rankCandidates(ctx.view, ctx.knobs.spreadGateBps)[0];
    return top ? `watching ${top.s.coin} (24h ${(top.s.ret24hPct ?? 0).toFixed(1)}%, waiting for clean impulse)` : "scanning for liquid momentum impulse";
  },

  universe(ctx) {
    return rankCandidates(ctx.view, ctx.knobs.spreadGateBps).map((c) => c.s.instId);
  },

  snapshotCoins(ctx) {
    const ids = rankCandidates(ctx.view, ctx.knobs.spreadGateBps)
      .slice(0, ctx.cfg.boozy.candidates)
      .map((c) => c.s.instId);
    const p = ctx.bee.position;
    if (p && !ids.includes(p.instId)) ids.push(p.instId);
    return ids;
  },

  coinSnapshot(s, ctx) {
    const row: Record<string, number | string | null> = {
      r1h_pct: r2(s.ret1hPct, 1),
      r24h_pct: r2(s.ret24hPct, 1),
      r7d_pct: r2(s.ret7dPct, 0),
      rsi14: r2(s.rsi14, 0),
      attn_z: r2(s.newsZ ?? s.volZ, 1),
      oi1h_pct: r2(s.oiChg1hPct, 1),
      fund_z: r2(s.fundingZ, 1),
      spread_bp: r2(s.spreadBp, 1),
      vol_musd: r2(s.vol24hUsd / 1e6, 1),
    };
    if (ctx.view.newsAvailable) row.sentiment = r2(s.sentiment, 1);
    return row;
  },

  menu(ctx) {
    const top = rankCandidates(ctx.view, ctx.knobs.spreadGateBps).slice(0, ctx.cfg.boozy.candidates);
    const m: Menu = {};
    const p = ctx.bee.position;
    if (!p) {
      for (const [i, c] of top.entries()) {
        if (c.impulse === "long") {
          m[`APE_${c.s.coin}`] = {
            desc: `#${i + 1} long impulse (+${(c.s.ret24hPct ?? 0).toFixed(1)}% 24h)`,
            intent: { kind: "open", instId: c.s.instId, side: "long", sizeFrac: ENTRY_FRAC, setup: "strict" },
          };
        } else if (c.impulse === "short") {
          m[`SHORT_${c.s.coin}`] = {
            desc: `#${i + 1} short breakdown (${(c.s.ret24hPct ?? 0).toFixed(1)}% 24h)`,
            intent: { kind: "open", instId: c.s.instId, side: "short", sizeFrac: ENTRY_FRAC, setup: "strict" },
          };
        }
      }
      if (Object.keys(m).length > 0) {
        m.WAIT = { desc: "pass on impulse, stay flat", intent: { kind: "hold" } };
      }
      return m;
    }

    const s = ctx.view.stats.get(p.instId);
    const inst = ctx.view.instruments.get(p.instId);
    m.RIDE = { desc: "keep position", intent: { kind: "hold" } };

    const committed = minutesSince(p.openedAt, ctx.now) < BOOZY_MIN_HOLD_MIN;
    const dir = p.side === "long" ? 1 : -1;
    const r1h = s?.ret1hPct ?? 0;

    if (!committed) {
      if ((ctx.uplR ?? 0) >= 1.5) {
        m.TAKE_PROFIT = { desc: "bank +1.5R momentum gain", intent: { kind: "close", reason: "take_profit" } };
      }
      if (dir * r1h < 0 || ctx.bee.uplUsd < 0) {
        m.BAIL = { desc: "impulse fading, close now", intent: { kind: "close", reason: "bail" } };
      }
      const best = switchTarget(ctx, top);
      if (best && best.impulse) {
        m.SWITCH_COIN = {
          desc: `close, ${best.impulse === "long" ? "ape" : "short"} ${best.s.coin}`,
          intent: { kind: "switch", instId: best.s.instId, side: best.impulse, sizeFrac: ENTRY_FRAC, setup: "strict" },
        };
      }
      if (p.side === "long" && s && (s.ret1hPct ?? 0) < 0 && (s.oiChg1hPct ?? 0) < 0) {
        m.FLIP_SHORT = {
          desc: "reverse to short",
          intent: { kind: "switch", instId: p.instId, side: "short", sizeFrac: ENTRY_FRAC, setup: "strict" },
        };
      }
    }

    // Single pyramid add (+0.5x up to 1.5x equity) after price runs >= 1.5 ATR(1h) in our favour.
    const notional = s && inst ? positionNotional(p, s.mid, inst.ctVal) : 0;
    const collateralUsd = Math.max(0, Math.min(ctx.bee.equityUsd, ctx.bee.cashUsd));
    const usableMax = Math.min(ctx.cfg.risk.maxLeverage * collateralUsd * MARGIN_HEADROOM, maxNotionalUsd(ctx));
    const atr = atr1hPx(s);
    const runAtr = s && atr ? (dir * (s.mid - p.entryPx)) / atr : 0;
    // The add is clamped to the room left under MAX_PYRAMID_FRAC, so the total never passes ~1.5x equity.
    const room = usableMax > 0 ? (usableMax * MAX_PYRAMID_FRAC - notional) / usableMax : 0;
    if (room >= 0.05 && runAtr >= 1.5) {
      m.DOUBLE_DOWN = { desc: `add 0.5x (run ${runAtr.toFixed(1)} ATR)`, intent: { kind: "add", sizeFrac: Math.min(ADD_FRAC, room) } };
    }
    return m;
  },

  forcedEntry() {
    return null;
  },

  sizeFrac(intent) {
    return intent.sizeFrac;
  },

  stopFor(instId, side, entryPx, ctx) {
    const s = ctx.view.stats.get(instId);
    const atr = atr1hPx(s);
    if (atr === null) return atrStop(s, side, entryPx, ctx.knobs.stopAtrMult);
    return side === "long" ? entryPx - STOP_ATR1H * atr : entryPx + STOP_ATR1H * atr;
  },

  trail(ctx) {
    const p = ctx.bee.position;
    const s = p ? ctx.view.stats.get(p.instId) : undefined;
    const atr = atr1hPx(s);
    if (!p || !s || atr === null) return null;
    return p.side === "long" ? s.mid - TRAIL_ATR1H * atr : s.mid + TRAIL_ATR1H * atr;
  },
};
