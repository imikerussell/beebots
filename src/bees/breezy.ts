// breezy-bee: ensemble Donchian trend following on BTC + ETH, 4h bars. See strategies/BREEZY_BEE.md.
import type { CoinStats } from "../market/types.js";
import { maxNotionalUsd, positionNotional, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Intent, Menu, Side } from "./types.js";

export const BREEZY_COINS = ["BTC", "ETH"] as const;
/** Vol cap (annualised %). Raised from the paper's 25% to 60% for visible swings (research 2026-09-24). */
const VOL_TARGET_PCT = 60;
/** Never below this fraction of max notional (1x equity at the 2x cap). */
const SIZE_FLOOR_FRAC = 0.5;

function coinStats(ctx: BeeContext): CoinStats[] {
  return [...ctx.view.stats.values()].filter((s) => (BREEZY_COINS as readonly string[]).includes(s.coin) && s.trend);
}

const sideOf = (score: number): Side => (score >= 0 ? "long" : "short");

/** max(0.5, |score|/9) of max notional, capped so the position stays under 60% annualised vol. */
export function breezySizeFrac(s: CoinStats | undefined, ctx: BeeContext): number {
  if (!s?.trend) return 0;
  const byScore = Math.max(SIZE_FLOOR_FRAC, Math.abs(s.trend.score) / 9);
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

export const breezy: BeeBrain = {
  id: "breezy",
  strategy:
    "You are breezy-bee, the calculated one. Trend following on BTC and ETH with a 9-slice Donchian ensemble on 4h bars (score -9..+9: long slices on minus short slices on). Ride winners, trade rarely, stay positioned with a real position (at least 1x equity). The code keeps your position at its target size. Open or flip only on a strong, clear trend; otherwise hold. Add only to a winner above +1R. Trim half when the score has fallen by 3 or more.",
  convictionLabels: ["weak", "fair", "strong", "overwhelming"],
  openGate: { minConviction: 2, minProb: (ctx) => ctx.cfg.breezy.minOpenProb },

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
    const stats = coinStats(ctx);
    const m: Menu = {};
    const p = ctx.bee.position;
    const open = (s: CoinStats, side: Side, kind: "open" | "switch"): Intent => ({
      kind,
      instId: s.instId,
      side,
      sizeFrac: breezySizeFrac(s, ctx),
      setup: Math.sign(s.trend!.score) === (side === "long" ? 1 : -1) ? "strict" : "loose",
    });
    if (!p) {
      for (const s of stats)
        for (const side of ["long", "short"] as const)
          m[`${side.toUpperCase()}_${s.coin}`] = { desc: null, intent: open(s, side, "open") };
      return m;
    }
    const cur = stats.find((s) => s.instId === p.instId);
    const inst = ctx.view.instruments.get(p.instId);
    m.HOLD_WINNER = { desc: "keep position", intent: { kind: "hold" } };
    const notional = cur && inst ? positionNotional(p, cur.mid, inst.ctVal) : 0;
    // Rebalance up only when the position is more than 25% of max notional below target (few, meaningful trades).
    if ((ctx.uplR ?? 0) > 1 && notional < maxNotionalUsd(ctx) * 0.95) {
      m.ADD_TO_WINNER = { desc: "add one slice", intent: { kind: "add", sizeFrac: 1 / 9 } };
    }
    if (cur?.trend && p.entryScore !== undefined) {
      const dir = p.side === "long" ? 1 : -1;
      if (dir * cur.trend.score <= dir * p.entryScore - 3) m.TRIM_HALF = { desc: "take half off", intent: { kind: "trim", fraction: 0.5 } };
    }
    if (cur) {
      const flip: Side = p.side === "long" ? "short" : "long";
      m[`${flip.toUpperCase()}_${cur.coin}`] = { desc: null, intent: open(cur, flip, "switch") };
    }
    const other = stats.find((s) => s.instId !== p.instId);
    if (other && other.trend!.score !== 0) {
      const side = sideOf(other.trend!.score);
      m.SWITCH = { desc: `close, go ${side} ${other.coin}`, intent: open(other, side, "switch") };
    }
    return m;
  },

  rebalance(ctx) {
    // More than 25% of max notional below target: add the difference (few, meaningful rebalances).
    const p = ctx.bee.position;
    const cur = p ? coinStats(ctx).find((s) => s.instId === p.instId) : undefined;
    const inst = p ? ctx.view.instruments.get(p.instId) : undefined;
    const max = maxNotionalUsd(ctx);
    if (!p || !cur || !inst || max <= 0) return null;
    // Only in the trend's direction: never pile into a position the score has turned against.
    if ((p.side === "long" ? 1 : -1) * cur.trend!.score < 0) return null;
    const gap = breezySizeFrac(cur, ctx) * max - positionNotional(p, cur.mid, inst.ctVal);
    return gap > 0.25 * max ? { kind: "add", sizeFrac: gap / max } : null;
  },

  forcedEntry(ctx) {
    // Never flat: minimum size in the direction of the stronger |score|.
    const s = strongerCoin(coinStats(ctx).filter((x) => x.spreadBp <= ctx.knobs.spreadGateBps));
    if (!s) return null;
    return { kind: "open", instId: s.instId, side: sideOf(s.trend!.score), sizeFrac: breezySizeFrac(s, ctx), setup: "loose" };
  },

  sizeFrac(intent, _conviction, ctx) {
    // A sub-strong pick never reaches here with full size: the risk layer turns it into the forced minimum.
    const max = maxNotionalUsd(ctx);
    const minFrac = max > 0 ? ctx.cfg.breezy.minSizeUsd / max : 0;
    return Math.max(intent.sizeFrac, minFrac);
  },

  stopFor(instId, side, entryPx, ctx) {
    const t = ctx.view.stats.get(instId)?.trend;
    if (!t || t.atr4hPct === null) return null;
    const dist = entryPx * (t.atr4hPct / 100) * ctx.knobs.stopAtrMult;
    return side === "long" ? entryPx - dist : entryPx + dist;
  },

  trail(ctx) {
    // Ratchet with the channel midpoint of the slices pointing our way.
    const p = ctx.bee.position;
    const t = p ? ctx.view.stats.get(p.instId)?.trend : undefined;
    if (!p || !t || t.trailStop === null) return null;
    if ((p.side === "long" && t.score > 0) || (p.side === "short" && t.score < 0)) return t.trailStop;
    return null;
  },
};
