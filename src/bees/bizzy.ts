// bizzy-bee. Since 2026-09-24: one Larry Williams volatility breakout a day.
// The fade helpers below are her previous strategy (Z1), kept for reference and tests; the brain no longer uses them.
import type { CoinStats } from "../market/types.js";
import { r2 } from "./common.js";
import type { BeeBrain, BeeContext, Menu, Side } from "./types.js";

export const FUNDING_Z_BLOCK_LONG = 1.5;

export interface FadeSetup {
  instId: string;
  coin: string;
  side: Side;
  strict: boolean;
  /** How far outside the bands, for ranking (|%B - 0.5|). */
  stretch: number;
}

/** Strict BbandRsi setups (mirrored), with the funding veto on longs. */
export function fadeSetup(s: CoinStats): FadeSetup | null {
  if (s.rsi14 === null || s.pctB === null) return null;
  const longBlocked = s.fundingZ !== null && s.fundingZ > FUNDING_Z_BLOCK_LONG;
  if (s.rsi14 < 30 && s.pctB < 0 && !longBlocked) return { instId: s.instId, coin: s.coin, side: "long", strict: true, stretch: Math.abs(s.pctB - 0.5) };
  if (s.rsi14 > 70 && s.pctB > 1) return { instId: s.instId, coin: s.coin, side: "short", strict: true, stretch: Math.abs(s.pctB - 0.5) };
  return null;
}

/** The most stretched coins by %B, as loose fades (the side is toward the middle band). */
export function stretchedFades(stats: CoinStats[], n: number): FadeSetup[] {
  return stats
    .filter((s) => s.pctB !== null)
    .filter((s) => !(s.pctB! < 0.5 && (s.fundingZ ?? 0) > FUNDING_Z_BLOCK_LONG))
    .map((s): FadeSetup => {
      const side: Side = s.pctB! < 0.5 ? "long" : "short";
      return { instId: s.instId, coin: s.coin, side, strict: false, stretch: Math.abs(s.pctB! - 0.5) };
    })
    .sort((a, b) => b.stretch - a.stretch)
    .slice(0, n);
}

/** The breakout coins, in order of preference when several trigger on the same tick. */
export const BIZZY_BREAKOUT_COINS = ["BTC", "ETH", "SOL", "HYPE"] as const;

function breakoutStats(ctx: BeeContext): CoinStats[] {
  const byCoin = new Map([...ctx.view.stats.values()].map((s) => [s.coin, s]));
  return BIZZY_BREAKOUT_COINS.map((c) => byCoin.get(c)).filter((s): s is CoinStats => !!s && !!s.breakout && s.spreadBp <= ctx.knobs.spreadGateBps);
}

/** % the price still needs to rise to reach today's trigger (negative = already through it). */
const toTrigger = (s: CoinStats) => (s.breakout ? ((s.breakout.trigger - s.mid) / s.mid) * 100 : null);

const nextUtcMidnight = (ms: number) => (Math.floor(ms / 86_400_000) + 1) * 86_400_000;

export const bizzy: BeeBrain = {
  id: "bizzy",
  strategy:
    "You are bizzy-bee, the grinder, now a one-shot breakout hunter. Each UTC day you get ONE trade: when BTC, ETH, SOL or HYPE breaks above today's open plus half of yesterday's range, you may go long at full size and ride it to the end of the day. Only take a breakout that looks real. While holding, HOLD unless it is clearly failing.",
  convictionLabels: ["meh", "decent", "juicy", "screaming"],
  neverForce: true,
  // Ride to the UTC day close (1 minute before midnight).
  timeStopMinutes: (ctx) => {
    const p = ctx.bee.position;
    return p ? Math.max(1, (nextUtcMidnight(p.openedAt) - 60_000 - p.openedAt) / 60_000) : Number.POSITIVE_INFINITY;
  },

  idleStatus(ctx) {
    const next = breakoutStats(ctx)
      .map((s) => ({ coin: s.coin, pct: toTrigger(s) }))
      .filter((x): x is { coin: string; pct: number } => x.pct !== null)
      .sort((a, b) => a.pct - b.pct)[0];
    return next ? `${next.coin} is ${next.pct.toFixed(2)}% from breakout` : "waiting for today's breakout levels";
  },

  universe(ctx) {
    return breakoutStats(ctx).map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    const ids = new Set(this.universe(ctx));
    if (ctx.bee.position) ids.add(ctx.bee.position.instId);
    return [...ids];
  },

  coinSnapshot(s) {
    return {
      to_trigger_pct: r2(toTrigger(s)),
      day_move_pct: s.breakout ? r2(((s.mid - s.breakout.dayOpen) / s.breakout.dayOpen) * 100) : null,
      prev_range_pct: s.breakout ? r2((s.breakout.prevRange / s.breakout.dayOpen) * 100) : null,
      r1h_pct: r2(s.ret1hPct, 1),
      fund_z: r2(s.fundingZ, 1),
      oi1h_pct: r2(s.oiChg1hPct, 1),
      spread_bp: r2(s.spreadBp, 1),
    };
  },

  menu(ctx) {
    const m: Menu = {};
    const p = ctx.bee.position;
    if (!p) {
      // Only coins that are through their trigger right now. Nothing triggered = no question for Jev (saves spend).
      for (const s of breakoutStats(ctx)) {
        const t = toTrigger(s);
        if (t !== null && t <= 0) m[`BREAKOUT_${s.coin}`] = { desc: `through trigger by ${(-t).toFixed(2)}%`, intent: { kind: "open", instId: s.instId, side: "long", sizeFrac: 1, setup: "strict" } };
      }
      if (Object.keys(m).length) m.WAIT = { desc: "not convinced, keep waiting", intent: { kind: "hold" } };
      return m;
    }
    m.HOLD = { desc: "ride it to the day close", intent: { kind: "hold" } };
    if (ctx.bee.uplUsd < 0) m.CUT_LOSS = { desc: "breakout failing, close", intent: { kind: "close", reason: "cut_loss" } };
    return m;
  },

  forcedEntry() {
    return null;
  },

  sizeFrac(intent) {
    return intent.sizeFrac;
  },

  stopFor(instId, side, _entryPx, ctx) {
    // Failed breakout: back below today's open.
    const b = ctx.view.stats.get(instId)?.breakout;
    if (!b) return null;
    return side === "long" ? b.dayOpen : null;
  },
};
