import type { Instrument } from "../market/types.js";

/** Decimal places in a lot size like "1", "0.1", "0.01". */
function decimals(x: number): number {
  const s = String(x);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
}

/**
 * contracts = floor(notional / (ctVal x price) / lotSz) x lotSz, and it must be >= minSz.
 * Returns 0 when it rounds below the minimum (the caller skips the trade and logs why).
 */
export function contractsFor(notionalUsd: number, inst: Pick<Instrument, "ctVal" | "lotSz" | "minSz">, px: number): number {
  if (!(notionalUsd > 0) || !(px > 0) || !(inst.ctVal > 0) || !(inst.lotSz > 0)) return 0;
  const raw = notionalUsd / (inst.ctVal * px);
  const lots = Math.floor(raw / inst.lotSz + 1e-9);
  const n = Number((lots * inst.lotSz).toFixed(decimals(inst.lotSz)));
  return n >= inst.minSz ? n : 0;
}

/** Round a contract count down to the lot size (for partial closes). */
export function roundToLot(contracts: number, inst: Pick<Instrument, "lotSz">): number {
  const lots = Math.floor(contracts / inst.lotSz + 1e-9);
  return Number((lots * inst.lotSz).toFixed(decimals(inst.lotSz)));
}

export function formatSz(contracts: number, inst: Pick<Instrument, "lotSz">): string {
  return contracts.toFixed(decimals(inst.lotSz));
}
