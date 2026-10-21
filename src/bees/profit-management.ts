import { roundToLot } from "../exec/sizing.js";
import type { BeeContext, Menu } from "./types.js";

export interface ProfitMetrics {
  quantity: number;
  riskPerUnit: number;
  quoteMid: number;
  estimatedClosePx: number;
  entryFeesUsd: number;
  fundingAccruedUsd: number;
  netPnlUsd: number;
  netR: number;
  peakNetPnlUsd: number;
  peakNetR: number;
  givebackPct: number;
  /** Estimated mid-price stop that covers costs plus the configured buffer. */
  breakevenPx: number;
  peakPx: number;
  peakNetPerUnit: number;
  costBasisEstimated: boolean;
}

const positive = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x) && x > 0;
const finite = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);

/** The exit fill is estimated from the executable side; entry spread/slippage is already in entryPx. */
function closeFactor(ctx: BeeContext): number {
  const p = ctx.bee.position!, t = ctx.view.tickers.get(p.instId)!;
  const slip = ctx.cfg.paperSlippageBps / 10_000;
  return p.side === "long" ? t.bid / t.mid * (1 - slip) : t.ask / t.mid * (1 + slip);
}

function stopForNetPerUnit(ctx: BeeContext, m: Pick<ProfitMetrics, "quantity" | "entryFeesUsd" | "fundingAccruedUsd">, target: number): number {
  const p = ctx.bee.position!, dir = p.side === "long" ? 1 : -1;
  // net/q = exitPx*(direction-feeRate) - direction*entryPx - entryFees/q + funding/q.
  return (target + dir * p.entryPx + (m.entryFeesUsd - m.fundingAccruedUsd) / m.quantity) /
    (closeFactor(ctx) * (dir - ctx.cfg.risk.takerFeeRate));
}

/** After-cost liquidation estimate, not a guaranteed fill or a prediction of future funding. */
export function profitMetrics(ctx: BeeContext): ProfitMetrics | null {
  const p = ctx.bee.position;
  if (!p) return null;
  const inst = ctx.view.instruments.get(p.instId), t = ctx.view.tickers.get(p.instId);
  if (!inst || !t || ![inst.ctVal, p.contracts, p.entryPx, p.riskUsd, t.bid, t.ask, t.mid].every(positive) ||
    !Number.isFinite(t.ts) || ctx.now - t.ts < 0 || ctx.now - t.ts > ctx.cfg.maxTickerAgeMs || t.bid > t.ask ||
    t.mid < t.bid || t.mid > t.ask) return null;
  const quantity = p.contracts * inst.ctVal;
  // Exchange rebates are negative fees and remain part of the actual recorded basis.
  const costBasisEstimated = !finite(p.entryFeesUsd);
  const entryFeesUsd = costBasisEstimated ? quantity * p.entryPx * ctx.cfg.risk.takerFeeRate : p.entryFeesUsd!;
  const fundingAccruedUsd = finite(p.fundingAccruedUsd) ? p.fundingAccruedUsd : 0;
  const dir = p.side === "long" ? 1 : -1;
  const estimatedClosePx = t.mid * closeFactor(ctx);
  const netPnlUsd = dir * (estimatedClosePx - p.entryPx) * quantity - entryFeesUsd + fundingAccruedUsd -
    estimatedClosePx * quantity * ctx.cfg.risk.takerFeeRate;
  const netPerUnit = netPnlUsd / quantity;
  const peakNetPerUnit = finite(p.exitPeakNetPerUnit) ? Math.max(netPerUnit, p.exitPeakNetPerUnit) : netPerUnit;
  const priorPeakPx = positive(p.exitPeakPx) ? p.exitPeakPx : t.mid;
  const peakPx = p.side === "long" ? Math.max(priorPeakPx, t.mid) : Math.min(priorPeakPx, t.mid);
  const riskPerUnit = p.riskUsd / quantity;
  const basis = {quantity, entryFeesUsd, fundingAccruedUsd};
  const breakevenPx = stopForNetPerUnit(ctx, basis, p.entryPx * ctx.cfg.exits[ctx.bee.id].breakevenBufferBps / 10_000);
  if (![quantity, estimatedClosePx, riskPerUnit, breakevenPx].every(positive) || !Number.isFinite(netPnlUsd)) return null;
  return {
    ...basis, riskPerUnit, quoteMid: t.mid, estimatedClosePx, netPnlUsd, netR: netPerUnit / riskPerUnit,
    peakNetPnlUsd: peakNetPerUnit * quantity, peakNetR: peakNetPerUnit / riskPerUnit,
    givebackPct: peakNetPerUnit > 0 ? Math.max(0, (peakNetPerUnit - netPerUnit) / peakNetPerUnit * 100) : 0,
    breakevenPx, peakPx, peakNetPerUnit, costBasisEstimated,
  };
}

function freshIndicators(ctx: BeeContext): boolean {
  const p = ctx.bee.position;
  const s = p ? ctx.view.stats.get(p.instId) : undefined;
  if (!s) return false;
  const age = ctx.now - (s.refreshedAt ?? ctx.view.ts);
  return Number.isFinite(age) && age >= 0 && age <= 3 * ctx.cfg.dataRefreshMs;
}

export interface ProfitStopCandidate {
  stopPx: number | null;
  peakPx: number;
  peakNetPerUnit: number;
  reason: "breakeven" | "trailing_profit" | "peak_profit_lock" | null;
}

/** Returns the tightest applicable barrier. The engine owns ratcheting, persistence and execution. */
export function profitStopCandidate(ctx: BeeContext): ProfitStopCandidate | null {
  const m = profitMetrics(ctx);
  if (!m) return null;
  const p = ctx.bee.position!, e = ctx.cfg.exits[ctx.bee.id];
  const dir = p.side === "long" ? 1 : -1;
  const priorPeakR = finite(p.exitPeakNetPerUnit) ? p.exitPeakNetPerUnit / m.riskPerUnit : -Infinity;
  const out: ProfitStopCandidate = {stopPx: null, peakPx: m.peakPx, peakNetPerUnit: m.peakNetPerUnit, reason: null};
  const add = (px: number, reason: ProfitStopCandidate["reason"], previouslyArmed: boolean, netBarrier = false) => {
    if (!positive(px)) return;
    // A newly armed stop must be executable below the current profit. Existing net-profit
    // barriers can also be breached by spread/funding changes before an old price stop is hit.
    // Changed settings apply to the retained net peak; a breached tighter net barrier closes now.
    // ATR-only recalculation must not manufacture an already-crossed new price stop.
    const storedBarrierBreached = p.stopPx !== null && positive(p.stopPx) && dir * (p.stopPx - m.quoteMid) >= 0;
    if (dir * (px - m.quoteMid) > 1e-10 && !(previouslyArmed && (netBarrier || storedBarrierBreached))) return;
    if (out.stopPx === null || dir * (px - out.stopPx) > 0) { out.stopPx = px; out.reason = reason; }
  };
  if (e.breakevenAtR > 0 && m.peakNetR >= e.breakevenAtR) {
    const buffer = p.entryPx * m.quantity * e.breakevenBufferBps / 10_000;
    const priorArmed = priorPeakR >= e.breakevenAtR && (p.exitPeakNetPerUnit ?? -Infinity) * m.quantity >= buffer;
    if (m.netPnlUsd >= buffer || priorArmed) add(m.breakevenPx, "breakeven", priorArmed, true);
  }
  if (e.trailActivationR > 0 && e.trailAtrMult > 0 && m.peakNetR >= e.trailActivationR && freshIndicators(ctx)) {
    const s = ctx.view.stats.get(p.instId)!;
    const atrPct = ctx.bee.id === "tiger" ? s.atr14Pct : s.trend?.atr4hPct;
    if (atrPct !== null && positive(atrPct)) {
      const distance = m.quoteMid * atrPct / 100 * e.trailAtrMult;
      add(m.peakPx - dir * distance, "trailing_profit", priorPeakR >= e.trailActivationR);
    }
  }
  if (e.profitLockAtR > 0 && e.maxGivebackPct < 100 && m.peakNetR >= e.profitLockAtR && m.peakNetPerUnit > 0) {
    const retained = m.peakNetPerUnit * (1 - e.maxGivebackPct / 100);
    add(stopForNetPerUnit(ctx, m, retained), "peak_profit_lock", priorPeakR >= e.profitLockAtR, true);
  }
  return out;
}

/** Cadenced discretionary profit review, independent of the slower completed entry-signal bars. */
export function profitReviewKey(ctx: BeeContext): string | null {
  const e = ctx.cfg.exits[ctx.bee.id], m = profitMetrics(ctx);
  return m && e.reviewMinR > 0 && e.reviewIntervalSeconds > 0 && m.netPnlUsd > 0 && m.netR >= e.reviewMinR && freshIndicators(ctx)
    ? `${ctx.bee.position!.openedAt}:${Math.floor(ctx.now / (e.reviewIntervalSeconds * 1000))}` : null;
}

/** Lot-floor the partial sale and require both the sale and remaining position to meet exchange minimums. */
export function takeProfitContracts(ctx: BeeContext): number {
  const p = ctx.bee.position, e = ctx.cfg.exits[ctx.bee.id], m = profitMetrics(ctx);
  if (!p || !m || !e.partialTakeProfitEnabled || p.profitTaken || !(m.netPnlUsd > 0) || m.netR < e.partialTakeProfitAtR) return 0;
  const inst = ctx.view.instruments.get(p.instId)!;
  if (!positive(inst.lotSz) || !positive(inst.minSz) || !(e.partialTakeProfitFraction > 0 && e.partialTakeProfitFraction < 1)) return 0;
  const contracts = roundToLot(p.contracts * e.partialTakeProfitFraction, inst);
  const remaining = roundToLot(p.contracts - contracts, inst);
  return contracts >= inst.minSz && remaining >= inst.minSz ? contracts : 0;
}

/** HOLD is supplied by the brain. Jev may decline these discretionary choices; hard stops remain independent. */
export function profitReviewMenu(ctx: BeeContext): Menu {
  if (profitReviewKey(ctx) === null) return {};
  const menu: Menu = {
    CLOSE_PROFIT: {desc: "Realise the remaining profit after estimated fees and execution costs.", intent: {kind: "close", reason: "model_profit_take"}},
  };
  if (takeProfitContracts(ctx) > 0) menu.TAKE_PROFIT = {
    desc: "Realise part of the after-cost profit once; leave the remaining position protected.",
    intent: {kind: "trim", fraction: ctx.cfg.exits[ctx.bee.id].partialTakeProfitFraction, reason: "profit_take"},
  };
  return menu;
}
