import { describe, expect, it } from "vitest";
import { contractsFor } from "../src/exec/sizing.js";
import { NOW, position } from "./fixtures.js";
import { riskFixture } from "./risk-fixture.js";
describe("two cats and real risk differences", () => {
  it.each(["tiger", "mochi"] as const)(
    "%s can WAIT indefinitely or HOLD; never auto-add",
    (id) => {
      const h = riskFixture(id);
      h.b.flatSince = NOW - 100000000;
      expect(h.brain.menu(h.ctx).WAIT).toBeDefined();
      expect(
        h.run({
          label: "WAIT",
          intent: { kind: "hold" },
          prob: 1,
          conviction: 0,
        }).action.kind,
      ).toBe("none");
      h.b.position = position(h.s, { stopPx: 90 });
      expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["HOLD", "CLOSE"]);
      expect(
        h.run({
          label: "HOLD",
          intent: { kind: "hold" },
          prob: 1,
          conviction: 0,
        }).action.kind,
      ).toBe("none");
    },
  );
  it("Mochi requires stronger trend, long-only and more liquidity", () => {
    const t = riskFixture(),
      m = riskFixture("mochi");
    t.s.trend!.score = 4;
    m.s.trend!.score = 4;
    expect(t.brain.menu(t.ctx).LONG_BTC).toBeDefined();
    expect(m.brain.menu(m.ctx).LONG_BTC).toBeUndefined();
    m.s.trend!.score = 9;
    m.s.vol24hUsd = 2e6;
    expect(Object.keys(m.brain.menu(m.ctx))).toEqual(["WAIT"]);
    expect(
      m.run({
        ...m.proposal,
        intent: {
          kind: "open",
          instId: m.s.instId,
          side: "short",
          setup: "strict",
          sizeFrac: 1,
        },
      }).vetoedBy,
    ).toBe("long_only");
  });
  it.each(["tiger", "mochi"] as const)(
    "%s sizing obeys equity cap, initial stop risk plus fees and own capital",
    (id) => {
      const h = riskFixture(id),
        result = h.run();
      expect(result.action.kind).toBe("open");
      if (result.action.kind !== "open") throw new Error(result.status);
      const n = result.action.notionalUsd,
        px = h.s.ask * (1 + h.cfg.paperSlippageBps / 10000),
        stop = h.brain.stopFor(h.s.instId, "long", px, h.ctx)!;
      expect(n).toBeLessThanOrEqual(
        (h.b.equityUsd * h.cfg.cats[id].maxNotionalPct) / 100,
      );
      expect(
        (n / px) * (px - stop + (px + stop) * h.cfg.risk.takerFeeRate),
      ).toBeLessThanOrEqual((h.b.equityUsd * h.cfg.cats[id].stopRiskPct) / 100);
      expect(n * (1 + 2 * h.cfg.risk.takerFeeRate)).toBeLessThanOrEqual(
        h.b.cashUsd,
      );
    },
  );
  it("skips exchange minimums and never rounds up beyond notional", () => {
    const h = riskFixture("mochi");
    h.v.instruments.get(h.s.instId)!.minSz = 100;
    expect(h.run().vetoedBy).toBe("below_exchange_minimum");
    expect(contractsFor(9.99, { ctVal: 1, lotSz: 1, minSz: 1 }, 10)).toBe(0);
    expect(
      contractsFor(9.9999999999, { ctVal: 1, lotSz: 1, minSz: 1 }, 10),
    ).toBe(0);
    expect(contractsFor(Infinity, { ctVal: 1, lotSz: 1, minSz: 1 }, 10)).toBe(
      0,
    );
  });
  it.each(["tiger", "mochi"] as const)(
    "%s daily loss stop is independently enforced",
    (id) => {
      const h = riskFixture(id);
      h.b.equityUsd = 100 * (1 - h.cfg.cats[id].dailyLossStopPct / 100);
      h.b.position = position(h.s, { stopPx: 90 });
      expect(h.run(null, false)).toMatchObject({
        action: { kind: "close" },
        forcedBy: "loss_stop",
      });
    },
  );
  it("entry/fee caps and cooldowns never prevent fresh risk-reducing exits", () => {
    for (const which of ["entries", "fees", "cooldown"]) {
      const h = riskFixture("mochi");
      if (which === "entries") h.b.tradesToday = 2;
      if (which === "fees") h.b.feesTodayUsd = 1;
      if (which === "cooldown") h.b.lastEntryAt = NOW - 1000;
      expect(h.run().action.kind).toBe("none");
      h.b.position = position(h.s, { stopPx: 90 });
      expect(
        h.run({
          label: "CLOSE",
          intent: { kind: "close", reason: "model_exit" },
          prob: 0.1,
          conviction: 0,
        }).action.kind,
      ).toBe("close");
      h.b.position.stopPx = 101;
      expect(h.run(null, false).forcedBy).toBe("stop");
    }
  });
  it("checks fresh quotes, spread, current setup and single position at execution time", () => {
    const h = riskFixture();
    h.v.tickers.get(h.s.instId)!.ts = NOW - 16000;
    expect(h.run().vetoedBy).toBe("stale_market_data");
    h.v.tickers.get(h.s.instId)!.ts = NOW;
    h.v.tickers.get(h.s.instId)!.spreadBp = 50;
    expect(h.run().vetoedBy).toBe("spread_gate");
    h.v.tickers.get(h.s.instId)!.spreadBp = 1;
    h.s.ret1hPct = -1;
    expect(h.run().vetoedBy).toBe("setup_no_longer_valid");
    h.b.position = position(h.s, { stopPx: 90 });
    expect(h.run().vetoedBy).toBe("one_position_limit");
  });
  it("refuses all exposure when the model fails, but stops still run", () => {
    const h = riskFixture();
    expect(h.run(null, false).action.kind).toBe("none");
    h.b.position = position(h.s, { stopPx: 101 });
    expect(h.run(null, false).action.kind).toBe("close");
    h.v.tickers.get(h.s.instId)!.ts = NOW - 16000;
    expect(h.run(null, false).vetoedBy).toBe("stale_exit_market_data");
  });
  it("disallows adding and automatically switching", () => {
    const h = riskFixture();
    h.b.position = position(h.s, { stopPx: 90 });
    expect(
      h.run({
        label: "add",
        intent: { kind: "add", sizeFrac: 1 },
        prob: 1,
        conviction: 3,
      }).vetoedBy,
    ).toBe("adds_and_switches_disabled");
  });
});
