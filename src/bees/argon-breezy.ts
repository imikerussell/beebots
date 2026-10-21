// Adapted from imikerussell/beebots @ 6cf999a (MIT).
// breezy-bee: ensemble Donchian trend following on BTC + ETH, 4h bars.
// Gated at |score| >= 3 (stays flat in chop), sized proportionally under a 40% vol cap
// with no forced 1x floor, safe realised-cash rebalance, and neverForce.
import type { CoinStats } from "../market/types.js";
import { MARGIN_HEADROOM, maxNotionalUsd, positionNotional, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Intent, Menu, Side } from "./types.js";

export const BREEZY_COINS = ["BTC", "ETH"] as const;
/** Minimum |score| (out of 9 slices) required to open or hold a trend position. */
export const BREEZY_MIN_SCORE = 3;
/** Annualised vol target (%) used to cap position size. */
const VOL_TARGET_PCT = 40;

function coinStats(ctx: BeeContext): CoinStats[] {
  return [...ctx.view.stats.values()].filter((s) => (BREEZY_COINS as readonly string[]).includes(s.coin) && s.trend);
}

const sideOf = (score: number): Side => (score >= 0 ? "long" : "short");

/** Realised-collateral ceiling so unrealised profits never trigger OKX 51008 margin rejections on adds. */
function usableMaxNotional(ctx: BeeContext): number {
  const collateralUsd = Math.max(0, Math.min(ctx.bee.equityUsd, ctx.bee.cashUsd));
  return Math.max(0, Math.min(ctx.cfg.risk.maxLeverage * collateralUsd * MARGIN_HEADROOM, maxNotionalUsd(ctx)));
}

/** True when 4h Donchian score is at least BREEZY_MIN_SCORE and 24h return does not fight the trend. */
export function hasQualifiedTrend(s: CoinStats | undefined): boolean {
  if (!s?.trend) return false;
  const { score } = s.trend;
  if (Math.abs(score) < BREEZY_MIN_SCORE) return false;
  if (Math.abs(score) >= 5) return true;
  const r24 = s.ret24hPct ?? 0;
  return score > 0 ? r24 >= -1.0 : r24 <= 1.0;
}

/** (|score|/9) of max notional when |score| >= 3 (0 in chop), capped by the 40% annualised vol limit. */
export function breezySizeFrac(s: CoinStats | undefined, ctx: BeeContext): number {
  if (!s?.trend || Math.abs(s.trend.score) < BREEZY_MIN_SCORE) return 0;
  const byScore = Math.abs(s.trend.score) / 9;
  const max = maxNotionalUsd(ctx);
  const rv = s.trend.rv90Pct;
  const volCap = rv && rv > 0 && max > 0 ? (ctx.bee.equityUsd * (VOL_TARGET_PCT / rv)) / max : 1;
  return Math.max(0, Math.min(byScore, volCap, 1));
}

/** B2 tie-break: prefer the coin at its 10-day extreme in its score's direction. */
export function strongerCoin(stats: CoinStats[]): CoinStats | undefined {
  return [...stats].sort((a, b) => {
    const d = Math.abs(b.trend!.score) - Math.abs(a.trend!.score);
    if (d !== 0) return d;
    const ext = (s: CoinStats) => (s.trend!.tenDayExtreme !== 0 && Math.sign(s.trend!.tenDayExtreme) === Math.sign(s.trend!.score) ? 1 : 0);
    return ext(b) - ext(a);
  })[0];
}

export const BREEZY_PROFIT_LOCK = [
  { atPct: 2.0, keep: 0.45 },
  { atPct: 4.0, keep: 0.65 },
] as const;

export const breezy: BeeBrain = {
  id: "breezy",
  neverForce: true,
  requiresStrictSetup: true,
  profitLock: BREEZY_PROFIT_LOCK,
  protectAdds: true,
  strategy:
    "You are breezy-bee, the calculated one. Trend following on BTC and ETH with a 9-slice Donchian ensemble on 4h bars (score -9..+9). Only enter when |score| >= 3 and the trend is clear; stay flat in chop. Ride winners with trailing stops, add only above +1R, trim half if score drops by 3+, and close if the trend score disappears.",
  convictionLabels: ["weak", "fair", "strong", "overwhelming"],
  openGate: { minConviction: 1, minProb: (ctx) => ctx.cfg.cats[ctx.bee.id].minActionProbability },

  idleStatus(ctx) {
    const top = strongerCoin(coinStats(ctx));
    return top ? `flat: ${top.coin} score ${top.trend!.score}/9 (needs |score| >= ${BREEZY_MIN_SCORE})` : "waiting for 4h Donchian trend";
  },

  universe(ctx) {
    return coinStats(ctx)
      .filter((s) => s.spreadBp <= ctx.knobs.spreadGateBps)
      .map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    return coinStats(ctx).map((s) => s.instId);
  },

  coinSnapshot(s, _ctx) {
    const t = s.trend!;
    const atrPx = t.atr4hPct !== null ? (s.mid * t.atr4hPct) / 100 : null;
    return {
      score: t.score,
      long_on: t.longOn,
      short_on: t.shortOn,
      slices: t.slicesAvailable,
      stop_dist_atr: t.trailStop !== null && atrPx ? r2(Math.abs(s.mid - t.trailStop) / atrPx, 1) : null,
      rv90_pct: r2(t.rv90Pct, 0),
      at_10d: t.tenDayExtreme,
      r24h_pct: r2(s.ret24hPct, 1),
      fund_z: r2(s.fundingZ, 1),
    };
  },

  menu(ctx) {
    const stats = coinStats(ctx).filter((s) => s.spreadBp <= ctx.knobs.spreadGateBps);
    const m: Menu = {};
    const p = ctx.bee.position;
    const open = (s: CoinStats, side: Side, kind: "open" | "switch"): Intent => ({
      kind,
      instId: s.instId,
      side,
      sizeFrac: breezySizeFrac(s, ctx),
      setup: "strict",
    });

    if (!p) {
      // Sort so the stronger qualified trend appears first on the menu.
      const ordered = [...stats].sort((a, b) => Math.abs(b.trend!.score) - Math.abs(a.trend!.score));
      for (const s of ordered) {
        if (!hasQualifiedTrend(s)) continue;
        const side = sideOf(s.trend!.score);
        m[`${side.toUpperCase()}_${s.coin}`] = {
          desc: `score ${s.trend!.score}/9`,
          intent: open(s, side, "open"),
        };
      }
      if (Object.keys(m).length > 0) {
        m.WAIT = { desc: "hold cash, wait for stronger trend", intent: { kind: "hold" } };
      }
      return m;
    }

    const cur = coinStats(ctx).find((s) => s.instId === p.instId);
    const inst = ctx.view.instruments.get(p.instId);
    m.HOLD_WINNER = { desc: "keep position", intent: { kind: "hold" } };

    const dir = p.side === "long" ? 1 : -1;
    const notional = cur && inst ? positionNotional(p, cur.mid, inst.ctVal) : 0;
    const usableMax = usableMaxNotional(ctx);

    if ((ctx.uplR ?? 0) > 1 && cur?.trend && dir * cur.trend.score >= BREEZY_MIN_SCORE && notional < usableMax * 0.85) {
      m.ADD_TO_WINNER = { desc: "add one slice", intent: { kind: "add", sizeFrac: 1 / 9 } };
    }

    if (cur?.trend && p.entryScore !== undefined && dir * cur.trend.score <= dir * p.entryScore - 3) {
      m.TRIM_HALF = { desc: "take half off", intent: { kind: "trim", fraction: 0.5 } };
    }

    if (cur?.trend && dir * cur.trend.score <= 0) {
      m.CLOSE_TREND = { desc: "trend exhausted, exit to cash", intent: { kind: "close", reason: "trend_exhausted" } };
    }

    // Offer a direct flip or switch only when an opposing trend is strongly established (|score| >= 5).
    if (cur?.trend && -dir * cur.trend.score >= 5 && hasQualifiedTrend(cur)) {
      const flip: Side = p.side === "long" ? "short" : "long";
      m[`${flip.toUpperCase()}_${cur.coin}`] = { desc: `flip on score ${cur.trend.score}/9`, intent: open(cur, flip, "switch") };
    }

    const other = stats.find((s) => s.instId !== p.instId);
    if (other?.trend && hasQualifiedTrend(other) && Math.abs(other.trend.score) >= 5 && Math.abs(other.trend.score) >= Math.abs(cur?.trend?.score ?? 0) + 3) {
      const side = sideOf(other.trend.score);
      m.SWITCH = { desc: `close, go ${side} ${other.coin}`, intent: open(other, side, "switch") };
    }
    return m;
  },

  rebalance(ctx) {
    // Only size up a proven winner (uplR > 0.5) when >35% below target against realised cash collateral.
    const p = ctx.bee.position;
    const cur = p ? coinStats(ctx).find((s) => s.instId === p.instId) : undefined;
    const inst = p ? ctx.view.instruments.get(p.instId) : undefined;
    const max = usableMaxNotional(ctx);
    if (!p || !cur?.trend || !inst || max <= 0) return null;
    if ((ctx.uplR ?? 0) <= 0.5) return null;
    const dir = p.side === "long" ? 1 : -1;
    if (dir * cur.trend.score < BREEZY_MIN_SCORE) return null;
    const targetUsd = breezySizeFrac(cur, ctx) * max;
    const gap = targetUsd - positionNotional(p, cur.mid, inst.ctVal);
    return gap > 0.35 * max ? { kind: "add", sizeFrac: gap / max } : null;
  },

  forcedEntry() {
    return null;
  },

  sizeFrac(intent, _conviction, ctx) {
    const max = maxNotionalUsd(ctx);
    const minFrac = max > 0 ? ctx.cfg.breezy.minSizeUsd / max : 0;
    return intent.sizeFrac > 0 ? Math.max(intent.sizeFrac, minFrac) : 0;
  },

  stopFor(instId, side, entryPx, ctx) {
    const t = ctx.view.stats.get(instId)?.trend;
    if (!t || t.atr4hPct === null) return null;
    const dist = entryPx * (t.atr4hPct / 100) * ctx.knobs.stopAtrMult;
    return side === "long" ? entryPx - dist : entryPx + dist;
  },

  trail(ctx) {
    const p = ctx.bee.position;
    const t = p ? ctx.view.stats.get(p.instId)?.trend : undefined;
    if (!p || !t || t.trailStop === null) return null;
    if ((p.side === "long" && t.score > 0) || (p.side === "short" && t.score < 0)) return t.trailStop;
    return null;
  },
};
