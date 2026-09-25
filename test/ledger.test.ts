import { describe, expect, it } from "vitest";
import { contractsFor, formatSz, roundToLot } from "../src/exec/sizing.js";
import { applyFill, applyFunding, freshBee, mark, rollDay } from "../src/ledger.js";
import { NOW } from "./fixtures.js";

describe("sizing", () => {
  const BTC = { ctVal: 0.0001, lotSz: 1, minSz: 1 };
  it("floors to whole lots", () => {
    // $265 / (0.0001 x 84461.8) = 31.37 -> 31
    expect(contractsFor(265, BTC, 84461.8)).toBe(31);
  });
  it("returns 0 below the minimum size", () => {
    expect(contractsFor(5, BTC, 84461.8)).toBe(0);
  });
  it("handles fractional lots without float dust", () => {
    expect(contractsFor(10, { ctVal: 1, lotSz: 0.1, minSz: 0.1 }, 3)).toBe(3.3);
    expect(roundToLot(0.30000000000000004, { lotSz: 0.1 })).toBe(0.3);
    expect(formatSz(3.3, { lotSz: 0.1 })).toBe("3.3");
    expect(formatSz(31, { lotSz: 1 })).toBe("31");
  });
  it("rejects garbage input", () => {
    expect(contractsFor(NaN, BTC, 1)).toBe(0);
    expect(contractsFor(100, BTC, 0)).toBe(0);
  });
});

describe("ledger", () => {
  const f = (side: "buy" | "sell", contracts: number, px: number, ts = NOW) => ({ instId: "SOL-USD_UM_XPERP-310404", coin: "SOL", side, contracts, px, feeUsd: contracts * 0.01 * px * 0.0005, ctVal: 0.01, ts });

  it("round trip: realised P&L and fees land in cash", () => {
    const b = freshBee("bee1", 333, NOW);
    applyFill(b, f("buy", 100, 100));
    expect(b.position).toMatchObject({ side: "long", contracts: 100, entryPx: 100 });
    expect(b.flatSince).toBeNull();
    const r = applyFill(b, f("sell", 100, 102, NOW + 60_000));
    expect(r).toBeCloseTo(2, 10); // 100 x 0.01 x $2
    expect(b.position).toBeNull();
    expect(b.flatSince).toBe(NOW + 60_000);
    expect(b.cashUsd).toBeCloseTo(333 + 2 - 0.05 - 0.051, 10); // taker 0.05% on $100 in, $102 out
    expect(b.totals.orders).toBe(2);
  });

  it("short P&L is mirrored", () => {
    const b = freshBee("bee3", 333, NOW);
    applyFill(b, f("sell", 50, 100));
    expect(applyFill(b, f("buy", 50, 90))).toBeCloseTo(5, 10);
  });

  it("adding averages the entry, trimming keeps it", () => {
    const b = freshBee("bee2", 333, NOW);
    applyFill(b, f("buy", 100, 100));
    applyFill(b, f("buy", 100, 110));
    expect(b.position!.entryPx).toBeCloseTo(105);
    applyFill(b, f("sell", 50, 120));
    expect(b.position!.contracts).toBe(150);
    expect(b.position!.entryPx).toBeCloseTo(105);
  });

  it("marks unrealised P&L into equity", () => {
    const b = freshBee("bee1", 333, NOW);
    applyFill(b, { ...f("buy", 100, 100), feeUsd: 0 });
    mark(b, 97, 0.01);
    expect(b.uplUsd).toBeCloseTo(-3);
    expect(b.equityUsd).toBeCloseTo(330);
  });

  it("funding lands as its own line", () => {
    const b = freshBee("bee1", 333, NOW);
    applyFunding(b, -0.12);
    expect(b.cashUsd).toBeCloseTo(332.88);
    expect(b.totals.fundingUsd).toBeCloseTo(-0.12);
  });

  it("00:00 UTC resets counters and caps, but not retirement", () => {
    const b = { ...freshBee("bee1", 333, NOW), tradesToday: 6, feesTodayUsd: 1.5, cap: "trade_cap" as const };
    expect(rollDay(b, NOW)).toBe(false);
    expect(rollDay(b, NOW + 86_400_000)).toBe(true);
    expect(b).toMatchObject({ tradesToday: 0, feesTodayUsd: 0, cap: null });
    const r = { ...freshBee("bee3", 333, NOW), cap: "retired" as const };
    rollDay(r, NOW + 86_400_000);
    expect(r.cap).toBe("retired");
  });
});
