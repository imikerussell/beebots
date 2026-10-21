// Adapted from imikerussell/beebots @ 6cf999a (MIT).
// bizzy-bee: the grinder. Dual-engine intraday Bollinger+RSI mean reversion (long & short)
// plus confirmed Larry Williams breakouts on liquid majors, at 1x equity (0.5 maxNotional),
// with a 4h time stop and neverForce.
import type { CoinStats } from "../market/types.js";
import { atrStop, minutesSince, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Menu, Side } from "./types.js";

export const FUNDING_Z_BLOCK_LONG = 1.5;
export const FUNDING_Z_BLOCK_SHORT = -1.5;

export interface FadeSetup {
  instId: string;
  coin: string;
  side: Side;
  strict: boolean;
  /** How far outside the bands, for ranking (|%B - 0.5|). */
  stretch: number;
}

/** Strict BbandRsi setups (mirrored), with funding vetoes on crowded sides. */
export function fadeSetup(s: CoinStats): FadeSetup | null {
  if (s.rsi14 === null || s.pctB === null) return null;
  const longBlocked = s.fundingZ !== null && s.fundingZ > FUNDING_Z_BLOCK_LONG;
  const shortBlocked = s.fundingZ !== null && s.fundingZ < FUNDING_Z_BLOCK_SHORT;
  if (s.rsi14 < 30 && s.pctB < 0 && !longBlocked) {
    return { instId: s.instId, coin: s.coin, side: "long", strict: true, stretch: Math.abs(s.pctB - 0.5) };
  }
  if (s.rsi14 > 70 && s.pctB > 1 && !shortBlocked) {
    return { instId: s.instId, coin: s.coin, side: "short", strict: true, stretch: Math.abs(s.pctB - 0.5) };
  }
  return null;
}

/** The most stretched coins by %B, as loose fades (kept for reference and tests). */
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

/** The breakout-eligible majors, also used by lab/brain.ts STYLE_COINS. */
export const BIZZY_BREAKOUT_COINS = ["BTC", "ETH", "SOL", "HYPE", "XRP", "SUI", "DOGE", "LINK"] as const;
const CORE_BREAKOUT_MAJORS = new Set(["BTC", "ETH", "SOL", "HYPE"]);

function liquidPool(ctx: BeeContext): CoinStats[] {
  return [...ctx.view.stats.values()]
    .filter((s) => s.spreadBp <= ctx.knobs.spreadGateBps && (BIZZY_BREAKOUT_COINS as readonly string[]).includes(s.coin))
    .sort((a, b) => b.vol24hUsd - a.vol24hUsd)
    .slice(0, ctx.cfg.bizzy.universeSize);
}

/** % the price still needs to rise to reach today's trigger (negative = already through it). */
const toTrigger = (s: CoinStats) => (s.breakout ? ((s.breakout.trigger - s.mid) / s.mid) * 100 : null);

/** Confirmed breakout: through trigger on a core major, with non-negative 1h return and uncrowded funding. */
function isConfirmedBreakout(s: CoinStats): boolean {
  if (!CORE_BREAKOUT_MAJORS.has(s.coin) || !s.breakout) return false;
  const t = toTrigger(s);
  if (t === null || t > 0) return false;
  if ((s.fundingZ ?? 0) > FUNDING_Z_BLOCK_LONG) return false;
  if ((s.ret1hPct ?? 0) < 0) return false;
  if ((s.rsi14 ?? 55) > 78) return false;
  return true;
}

/** CUT_LOSS is offered only after this many minutes in the trade... */
export const BIZZY_CUT_LOSS_MIN_HOLD_MIN = 20;
/** ...or earlier once the trade is a real loser, at this many R or worse. */
export const BIZZY_CUT_LOSS_EARLY_R = -0.5;

export const BIZZY_PROFIT_LOCK = [
  { atPct: 1.2, keep: 0.5 },
  { atPct: 2.5, keep: 0.7 },
] as const;

export const bizzy: BeeBrain = {
  id: "bizzy",
  neverForce: true,
  requiresStrictSetup: true,
  fundingVetoLongZ: FUNDING_Z_BLOCK_LONG,
  profitLock: BIZZY_PROFIT_LOCK,
  timeStopMinutes: (ctx) => ctx.cfg.bizzy.timeStopMinutes,
  strategy:
    "You are bizzy-bee, the grinder. Trade high-probability intraday Bollinger+RSI mean-reversion fades (FADE_LONG when RSI<30 & %B<0, FADE_SHORT when RSI>70 & %B>1) and confirmed daily volatility breakouts (BREAKOUT_<coin>) on liquid majors at 1x equity. Bank profits quickly at the middle band or +1R, cut losers early, and wait flat when no strict setup is live.",
  convictionLabels: ["meh", "decent", "juicy", "screaming"],

  idleStatus(ctx) {
    const pool = liquidPool(ctx);
    const nearBreak = pool
      .filter((s) => CORE_BREAKOUT_MAJORS.has(s.coin) && s.breakout)
      .map((s) => ({ coin: s.coin, pct: toTrigger(s) }))
      .filter((x): x is { coin: string; pct: number } => x.pct !== null)
      .sort((a, b) => a.pct - b.pct)[0];
    return nearBreak ? `${nearBreak.coin} is ${nearBreak.pct.toFixed(2)}% from breakout` : "scanning for strict band fade or breakout";
  },

  universe(ctx) {
    return liquidPool(ctx).map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    const ids = new Set(this.universe(ctx));
    if (ctx.bee.position) ids.add(ctx.bee.position.instId);
    return [...ids];
  },

  coinSnapshot(s) {
    return {
      rsi14: r2(s.rsi14, 0),
      pct_b: r2(s.pctB, 2),
      to_trigger_pct: r2(toTrigger(s)),
      r1h_pct: r2(s.ret1hPct, 1),
      fund_z: r2(s.fundingZ, 1),
      oi1h_pct: r2(s.oiChg1hPct, 1),
      spread_bp: r2(s.spreadBp, 1),
    };
  },

  menu(ctx) {
    const m: Menu = {};
    const p = ctx.bee.position;
    const sizeFrac = ctx.cfg.bizzy.sizeFraction;

    if (!p) {
      const pool = liquidPool(ctx);
      // 1. Strict Bollinger + RSI fades (long or short).
      const fades = pool
        .map((s) => fadeSetup(s))
        .filter((f): f is FadeSetup => f !== null)
        .sort((a, b) => b.stretch - a.stretch);
      for (const f of fades) {
        m[`FADE_${f.side.toUpperCase()}_${f.coin}`] = {
          desc: `${f.side} fade (stretch ${f.stretch.toFixed(2)})`,
          intent: { kind: "open", instId: f.instId, side: f.side, sizeFrac, setup: "strict" },
        };
      }
      // 2. Confirmed Larry Williams breakouts on core majors.
      for (const s of pool) {
        if (isConfirmedBreakout(s)) {
          const t = toTrigger(s)!;
          m[`BREAKOUT_${s.coin}`] = {
            desc: `through trigger by ${(-t).toFixed(2)}%`,
            intent: { kind: "open", instId: s.instId, side: "long", sizeFrac, setup: "strict" },
          };
        }
      }
      if (Object.keys(m).length > 0) {
        m.WAIT = { desc: "not convinced, keep waiting", intent: { kind: "hold" } };
      }
      return m;
    }

    const s = ctx.view.stats.get(p.instId);
    m.HOLD = { desc: "hold position", intent: { kind: "hold" } };

    // Take profit at Bollinger middle band or >= +1.0R.
    const reachedMid =
      s &&
      ((p.side === "long" && ((s.bbMid !== null && s.mid >= s.bbMid && ctx.bee.uplUsd > 0) || (s.pctB !== null && s.pctB >= 0.5 && ctx.bee.uplUsd > 0))) ||
        (p.side === "short" && ((s.bbMid !== null && s.mid <= s.bbMid && ctx.bee.uplUsd > 0) || (s.pctB !== null && s.pctB <= 0.5 && ctx.bee.uplUsd > 0))));
    if (reachedMid || (ctx.uplR ?? 0) >= 1.0) {
      m.TAKE_PROFIT = { desc: "bank target at mid-band / +1R", intent: { kind: "close", reason: "take_profit" } };
    }

    // "Cut losers when underwater", but not the spread: any entry is red at once, so CUT_LOSS waits until the trade
    // has had BIZZY_CUT_LOSS_MIN_HOLD_MIN minutes, unless it is a real loser already (uplR <= BIZZY_CUT_LOSS_EARLY_R).
    // The hard stop and the 4h time stop are unchanged and never wait.
    const heldMin = minutesSince(p.openedAt, ctx.now);
    if (ctx.bee.uplUsd < 0 && (heldMin >= BIZZY_CUT_LOSS_MIN_HOLD_MIN || (ctx.uplR ?? 0) <= BIZZY_CUT_LOSS_EARLY_R)) {
      m.CUT_LOSS = { desc: "setup failing, cut loss", intent: { kind: "close", reason: "cut_loss" } };
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
    const atr = atrStop(s, side, entryPx, ctx.knobs.stopAtrMult);
    // If opened on a daily breakout and dayOpen is below entryPx, honour dayOpen when atrStop is unavailable.
    if (side === "long" && s?.breakout && s.breakout.dayOpen < entryPx) {
      return atr !== null ? Math.max(s.breakout.dayOpen, atr) : s.breakout.dayOpen;
    }
    return atr;
  },
};
