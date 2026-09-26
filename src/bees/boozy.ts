// boozy-bee: top-gainer rotation + attention spikes on the gated universe. See strategies/BOOZY_BEE.md.
import type { CoinStats, MarketView } from "../market/types.js";
import { atrStop, maxNotionalUsd, minutesSince, positionNotional, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Menu } from "./types.js";

export interface Candidate {
  s: CoinStats;
  score: number;
  attention: number | null;
}

function zs(xs: number[]): (x: number) => number {
  const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1;
  return (x) => (x - m) / sd;
}

/** Hold a pick at least this long before rotating or bailing (stops still fire). Research 2026-09-24: 1-4 week momentum. */
export const BOOZY_MIN_HOLD_MIN = 24 * 60;
/** Enter at 1x equity (half of the 2x max), pyramid +0.5x per +1 ATR(1h) in profit, up to 2x. */
const ENTRY_FRAC = 0.5;
const ADD_FRAC = 0.25;
/** 1h ATR is approximated as 2 x the 15m ATR (sqrt of 4 bars); trail at 3 x ATR(1h). */
const atr1hPx = (s: CoinStats | undefined) => (s && s.atr14Pct !== null ? (s.mid * s.atr14Pct * 2) / 100 : null);
const TRAIL_ATR1H = 3;

/** Momentum on 7-day return, plus a small attention bonus (news z, or volume z when news is unavailable). */
export function rankCandidates(view: MarketView, spreadGateBps: number): Candidate[] {
  const pool = view.gated.map((id) => view.stats.get(id)).filter((s): s is CoinStats => !!s && s.ret24hPct !== null && s.spreadBp <= spreadGateBps);
  if (!pool.length) return [];
  const z24 = zs(pool.map((s) => s.ret24hPct!));
  const z7 = zs(pool.map((s) => s.ret7dPct ?? s.ret24hPct!));
  return pool
    .map((s) => {
      const attention = s.newsZ ?? s.volZ;
      const score = z7(s.ret7dPct ?? s.ret24hPct!) + 0.1 * z24(s.ret24hPct!) + 0.3 * Math.max(0, attention ?? 0);
      return { s, score, attention };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The coin to offer a switch into, or null. Only when another coin outranks the held one right now AND was #1 on
 * the last two hourly checks (bee.top1, streak >= 2). If the held coin is missing from the fresh ranking (spread gate,
 * missing data) there is no fair comparison, so no switch is offered.
 */
export function switchTarget(ctx: BeeContext, top: Candidate[]): Candidate | null {
  const p = ctx.bee.position;
  if (!p) return null;
  const all = rankCandidates(ctx.view, ctx.knobs.spreadGateBps);
  const heldAt = all.findIndex((c) => c.s.instId === p.instId);
  const leader = top[0];
  if (heldAt < 0 || !leader || leader.s.instId === p.instId) return null;
  const { coin, streak } = ctx.bee.top1;
  return coin === leader.s.coin && streak >= 2 ? leader : null;
}

export const boozy: BeeBrain = {
  id: "boozy",
  strategy:
    "You are boozy-bee, the degen. Back the week's hottest coin (7-day momentum, including the strange ones) and ride it hard. Always holding something. Enter at 1x, DOUBLE_DOWN into a winner every time it runs another ATR, up to 2x. Commit to each pick for at least 24 hours: rotating and bailing only unlock after that. The code trails a wide stop for you.",
  convictionLabels: ["tipsy", "buzzed", "wasted", "legendary"],

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
    // Rows arrive in momentum-rank order, so no rank column.
    const row: Record<string, number | string | null> = {
      r1h_pct: r2(s.ret1hPct, 1),
      r24h_pct: r2(s.ret24hPct, 0),
      r7d_pct: r2(s.ret7dPct, 0),
      attn_z: r2(s.newsZ ?? s.volZ, 1),
      oi1h_pct: r2(s.oiChg1hPct, 1),
      spread_bp: r2(s.spreadBp, 0),
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
      for (const [i, c] of top.entries())
        m[`APE_${c.s.coin}`] = {
          desc: `#${i + 1} momentum`,
          intent: { kind: "open", instId: c.s.instId, side: "long", sizeFrac: ENTRY_FRAC, setup: "strict" },
        };
      return m;
    }
    const s = ctx.view.stats.get(p.instId);
    const inst = ctx.view.instruments.get(p.instId);
    m.RIDE = { desc: "keep position", intent: { kind: "hold" } };
    const committed = minutesSince(p.openedAt, ctx.now) < BOOZY_MIN_HOLD_MIN;
    if (!committed) m.BAIL = { desc: "close now", intent: { kind: "close", reason: "bail" } };
    const best = switchTarget(ctx, top);
    if (best && !committed) {
      m.SWITCH_COIN = {
        desc: `close, ape ${best.s.coin}`,
        intent: { kind: "switch", instId: best.s.instId, side: "long", sizeFrac: ENTRY_FRAC, setup: "strict" },
      };
    }
    // Pyramid: one more +0.5x step each time price has run another 1 ATR(1h) past the average entry.
    const notional = s && inst ? positionNotional(p, s.mid, inst.ctVal) : 0;
    const max = maxNotionalUsd(ctx);
    const atr = atr1hPx(s);
    const steps = max > 0 ? Math.max(0, Math.round((notional / max - ENTRY_FRAC) / ADD_FRAC)) : 0;
    const runAtr = s && atr ? ((p.side === "long" ? 1 : -1) * (s.mid - p.entryPx)) / atr : 0;
    if (notional < max * 0.95 && runAtr >= steps + 1) {
      m.DOUBLE_DOWN = { desc: `add 0.5x (run ${runAtr.toFixed(1)} ATR)`, intent: { kind: "add", sizeFrac: ADD_FRAC } };
    }
    if (!committed && p.side === "long" && s && (s.ret1hPct ?? 0) < 0 && (s.oiChg1hPct ?? 0) < 0) {
      m.FLIP_SHORT = { desc: "reverse to short", intent: { kind: "switch", instId: p.instId, side: "short", sizeFrac: ENTRY_FRAC, setup: "strict" } };
    }
    return m;
  },

  forcedEntry(ctx) {
    const c = rankCandidates(ctx.view, ctx.knobs.spreadGateBps)[0];
    return c ? { kind: "open", instId: c.s.instId, side: "long", sizeFrac: ENTRY_FRAC, setup: "loose" } : null;
  },

  sizeFrac(intent) {
    // Always enter at 1x; size comes from pyramiding into winners, not from conviction.
    return intent.sizeFrac;
  },

  stopFor(instId, side, entryPx, ctx) {
    const s = ctx.view.stats.get(instId);
    const atr = atr1hPx(s);
    if (atr === null) return atrStop(s, side, entryPx, ctx.knobs.stopAtrMult);
    return side === "long" ? entryPx - TRAIL_ATR1H * atr : entryPx + TRAIL_ATR1H * atr;
  },

  trail(ctx) {
    // 3 x ATR(1h) behind the mark; the engine only ever ratchets it in the position's favour.
    const p = ctx.bee.position;
    const s = p ? ctx.view.stats.get(p.instId) : undefined;
    const atr = atr1hPx(s);
    if (!p || !s || atr === null) return null;
    return p.side === "long" ? s.mid - TRAIL_ATR1H * atr : s.mid + TRAIL_ATR1H * atr;
  },
};
