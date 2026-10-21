// Our own books per bee. OKX is the source of truth in demo/live; reconciliation compares the two.
import { uplUsd } from "./bees/common.js";
import type { BeeState, Position } from "./bees/types.js";
import type { BeeId } from "./config.js";

export function freshBee(id: BeeId, equityUsd: number, now: number): BeeState {
  return {
    id,
    cashUsd: equityUsd,
    equityUsd,
    uplUsd: 0,
    dayKey: dayKey(now),
    dayStartEquityUsd: equityUsd,
    position: null,
    flatSince: now,
    tradesToday: 0,
    feesTodayUsd: 0,
    lastOrderAt: null,
    lastEntryAt: null,
    peakEquityUsd: equityUsd,
    maxDrawdownPct: 0,
    exposedMs: 0,
    metricsAt: now,
    slippageUsd: 0,
    cap: null,
    totals: {
      feesUsd: 0,
      fundingUsd: 0,
      jevUsd: 0,
      realisedUsd: 0,
      decisions: 0,
      orders: 0,
    },
    top1: { coin: null, streak: 0, rankedAt: 0 },
  };
}

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface LedgerFill {
  instId: string;
  coin: string;
  side: "buy" | "sell";
  contracts: number;
  px: number;
  feeUsd: number;
  ctVal: number;
  ts: number;
}

/** Apply a fill to the bee's books. Returns realised P&L (before fees). */
export function applyFill(bee: BeeState, f: LedgerFill): number {
  const dir = f.side === "buy" ? 1 : -1;
  const p = bee.position;
  let realised = 0;
  bee.cashUsd -= f.feeUsd;
  bee.feesTodayUsd += f.feeUsd;
  bee.totals.feesUsd += f.feeUsd;
  bee.lastOrderAt = f.ts;
  bee.totals.orders++;

  if (!p) {
    bee.position = newPosition(f, dir);
    bee.flatSince = null;
    return 0;
  }
  if (p.instId !== f.instId)
    throw new Error(`fill for ${f.coin} while holding ${p.coin}`);
  const pDir = p.side === "long" ? 1 : -1;
  if (dir === pDir) {
    // add: weighted average entry
    const total = p.contracts + f.contracts;
    p.entryPx = (p.entryPx * p.contracts + f.px * f.contracts) / total;
    p.contracts = total;
    if (p.entryFeesUsd !== undefined) p.entryFeesUsd += f.feeUsd;
    // A different average/quantity has no observed combined-position peak yet.
    delete p.exitPeakPx;
    delete p.exitPeakNetPerUnit;
    // An add makes the position bigger, so 1R grows with it (it used to stay at the first fill's risk).
    const initStop = p.initialStopPx ?? p.stopPx;
    if (initStop !== null && initStop !== undefined)
      p.riskUsd = sizedRiskUsd(total, f.ctVal, p.entryPx, initStop);
    return 0;
  }
  // reduce / close
  const closed = Math.min(p.contracts, f.contracts);
  realised = pDir * (f.px - p.entryPx) * closed * f.ctVal;
  bee.cashUsd += realised;
  bee.totals.realisedUsd += realised;
  const remainingRatio = p.contracts > 0 ? (p.contracts - closed) / p.contracts : 0;
  if (p.entryFeesUsd !== undefined) p.entryFeesUsd *= remainingRatio;
  if (p.fundingAccruedUsd !== undefined) p.fundingAccruedUsd *= remainingRatio;
  p.riskUsd =
    p.contracts > 0 ? p.riskUsd * ((p.contracts - closed) / p.contracts) : 0;
  p.contracts = Number((p.contracts - closed).toFixed(8));
  if (p.contracts <= 0) {
    bee.position = null;
    bee.flatSince = f.ts;
    const rest = f.contracts - closed;
    if (rest > 1e-9) {
      bee.position = newPosition({ ...f, contracts: rest, feeUsd: f.feeUsd * rest / f.contracts }, dir);
      bee.flatSince = null;
    }
  }
  return realised;
}

/** USD lost if the whole position exits at `stopPx` from its average entry. */
export function sizedRiskUsd(
  contracts: number,
  ctVal: number,
  entryPx: number,
  stopPx: number,
): number {
  return Math.abs(contracts * ctVal * (entryPx - stopPx));
}

function newPosition(f: LedgerFill, dir: number): Position {
  return {
    instId: f.instId,
    coin: f.coin,
    side: dir > 0 ? "long" : "short",
    contracts: f.contracts,
    entryPx: f.px,
    openedAt: f.ts,
    stopPx: null,
    riskUsd: 0,
    entryFeesUsd: f.feeUsd,
    fundingAccruedUsd: 0,
  };
}

export function applyFunding(bee: BeeState, amountUsd: number, positionAmountUsd = amountUsd): void {
  bee.cashUsd += amountUsd;
  bee.totals.fundingUsd += amountUsd;
  if (bee.position)
    bee.position.fundingAccruedUsd = (bee.position.fundingAccruedUsd ?? 0) + positionAmountUsd;
}

/** Allocate a late funding bill through subsequent reductions; adds do not earn historical funding. */
export function fundingForRemainingPosition(
  amountUsd: number,
  contracts: number,
  side: Position["side"],
  laterFills: ReadonlyArray<{ side: "buy" | "sell"; contracts: number }>,
): number {
  const openingSide = side === "long" ? "buy" : "sell";
  const deltas = laterFills.map(f => (f.side === openingSide ? 1 : -1) * f.contracts);
  let quantity = contracts - deltas.reduce((a, b) => a + b, 0);
  if (!(quantity > 0)) return 0;
  let allocated = amountUsd;
  for (const delta of deltas) {
    if (delta < 0) allocated *= Math.max(0, quantity + delta) / quantity;
    quantity += delta;
    if (!(quantity > 0)) return 0;
  }
  return allocated;
}

/** Mark to market at `markPx`. */
export function mark(
  bee: BeeState,
  markPx: number | undefined,
  ctVal: number | undefined,
): void {
  const p = bee.position;
  bee.uplUsd =
    p && markPx && ctVal
      ? uplUsd(p, markPx, ctVal)
      : bee.position
        ? bee.uplUsd
        : 0;
  bee.equityUsd = bee.cashUsd + bee.uplUsd;
}

/** 00:00 UTC: reset daily counters and every cap except "retired". */
export function rollDay(bee: BeeState, now: number): boolean {
  const d = dayKey(now);
  if (d === bee.dayKey) return false;
  bee.dayKey = d;
  bee.dayStartEquityUsd = bee.equityUsd;
  bee.tradesToday = 0;
  delete bee.entryLimitBaseline;
  bee.feesTodayUsd = 0;
  if (bee.cap !== "retired") bee.cap = null;
  return true;
}
