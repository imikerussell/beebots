import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { applyFill, applyFunding, freshBee, fundingForRemainingPosition, type LedgerFill } from "../src/ledger.js";
import { NOW } from "./fixtures.js";

describe("profit protection configuration", () => {
  it("keeps owner-selected exit controls independent between cats and from their initial stops", () => {
    const cfg = loadConfig({ TIGER_STOP_ATR_MULT: "3", TIGER_TRAIL_ATR_MULT: "0.8",
      MOCHI_STOP_ATR_MULT: "2.5", MOCHI_TRAIL_ATR_MULT: "1.2",
      TIGER_BREAKEVEN_AT_R: "0.7", MOCHI_BREAKEVEN_AT_R: "1.3",
      TIGER_EXIT_MIN_ACTION_PROBABILITY: "0.44", MOCHI_EXIT_MIN_ACTION_PROBABILITY: "0.6",
      TIGER_PARTIAL_TAKE_PROFIT_ENABLED: "false", MOCHI_PARTIAL_TAKE_PROFIT_FRACTION: "0.25" });
    expect(cfg.cats.tiger.stopAtrMult).toBe(3);
    expect(cfg.cats.mochi.stopAtrMult).toBe(2.5);
    expect(cfg.exits.tiger).toMatchObject({ trailAtrMult: 0.8, breakevenAtR: 0.7,
      minActionProbability: 0.44, partialTakeProfitEnabled: false });
    expect(cfg.exits.mochi).toMatchObject({ trailAtrMult: 1.2, breakevenAtR: 1.3,
      minActionProbability: 0.6, partialTakeProfitFraction: 0.25 });
  });

  it("permits disabling each automatic protection and profit review with zero activation", () => {
    const cfg = loadConfig({ TIGER_BREAKEVEN_AT_R: "0", TIGER_TRAIL_ACTIVATION_R: "0",
      TIGER_PROFIT_LOCK_AT_R: "0", TIGER_EXIT_REVIEW_MIN_R: "0" });
    expect(cfg.exits.tiger).toMatchObject({ breakevenAtR: 0, trailActivationR: 0,
      profitLockAtR: 0, reviewMinR: 0 });
  });

  it.each([
    ["TIGER_PARTIAL_TAKE_PROFIT_ENABLED", "maybe"],
    ["MOCHI_PARTIAL_TAKE_PROFIT_FRACTION", "1"],
    ["TIGER_MAX_PROFIT_GIVEBACK_PCT", "101"],
    ["MOCHI_TRAIL_ATR_MULT", "NaN"],
    ["TIGER_EXIT_MIN_ACTION_PROBABILITY", "1.01"],
    ["MOCHI_EXIT_REVIEW_INTERVAL_SECONDS", "0"],
  ])("rejects invalid %s instead of silently weakening protections", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(key);
  });
});

function fill(side: "buy" | "sell", contracts: number, px: number): LedgerFill {
  return { instId: "BTC-USD_UM_XPERP-310404", coin: "BTC", side, contracts, px,
    feeUsd: contracts * 0.01 * px * 0.0005, ctVal: 0.01, ts: NOW };
}

describe("remaining position profit cost basis", () => {
  it.each(["long", "short"] as const)("allocates delayed %s funding through reductions and additions in their actual order", side => {
    const add = side === "long" ? "buy" : "sell", reduce = side === "long" ? "sell" : "buy";
    // A settlement on 100 contracts: halving first leaves half its cost, which a later add does not recreate.
    expect(fundingForRemainingPosition(-1, 100, side, [
      { side: reduce, contracts: 50 }, { side: add, contracts: 50 },
    ])).toBeCloseTo(-0.5);
    // Adding first dilutes that cost over 150 contracts; the subsequent 50-contract reduction leaves two thirds.
    expect(fundingForRemainingPosition(-1, 100, side, [
      { side: add, contracts: 50 }, { side: reduce, contracts: 50 },
    ])).toBeCloseTo(-2 / 3);
    expect(fundingForRemainingPosition(1, 50, side, [{ side: reduce, contracts: 50 }])).toBeCloseTo(0.5);
    expect(fundingForRemainingPosition(-1, 100, side, [])).toBe(-1);
  });

  it.each(["long", "short"] as const)("allocates opening fees, funding and original risk after a %s partial", side => {
    const bee = freshBee("tiger", 100, NOW);
    applyFill(bee, fill(side === "long" ? "buy" : "sell", 100, 100));
    Object.assign(bee.position!, { initialStopPx: side === "long" ? 99 : 101,
      stopPx: side === "long" ? 100.5 : 99.5, riskUsd: 1,
      exitPeakPx: side === "long" ? 102 : 98, exitPeakNetPerUnit: 1.5 });
    applyFunding(bee, -0.2);
    expect(bee.position).toMatchObject({ entryFeesUsd: 0.05, fundingAccruedUsd: -0.2 });
    applyFill(bee, fill(side === "long" ? "sell" : "buy", 40, side === "long" ? 102 : 98));
    expect(bee.position?.contracts).toBe(60);
    expect(bee.position?.entryFeesUsd).toBeCloseTo(0.03);
    expect(bee.position?.fundingAccruedUsd).toBeCloseTo(-0.12);
    expect(bee.position?.riskUsd).toBeCloseTo(0.6);
    expect(bee.position?.exitPeakNetPerUnit).toBe(1.5);
    expect(bee.totals.fundingUsd).toBe(-0.2);
    expect(bee.totals.feesUsd).toBeCloseTo(0.05 + 40 * 0.01 * (side === "long" ? 102 : 98) * 0.0005);
  });

  it("adds actual opening fees and discards the old quantity's peak without loosening its stop", () => {
    const bee = freshBee("mochi", 100, NOW);
    applyFill(bee, fill("buy", 100, 100));
    Object.assign(bee.position!, { initialStopPx: 99, stopPx: 101, riskUsd: 1,
      exitPeakPx: 105, exitPeakNetPerUnit: 4.8 });
    applyFunding(bee, 0.1);
    applyFill(bee, fill("buy", 50, 110));
    expect(bee.position?.entryFeesUsd).toBeCloseTo(0.0775);
    expect(bee.position?.fundingAccruedUsd).toBeCloseTo(0.1);
    expect(bee.position?.stopPx).toBe(101);
    expect(bee.position?.exitPeakPx).toBeUndefined();
    expect(bee.position?.exitPeakNetPerUnit).toBeUndefined();
    expect(bee.position?.riskUsd).toBeCloseTo(1.5 * (bee.position!.entryPx - 99));
  });
});
