import { describe, expect, it } from "vitest";
import { activeBizzy } from "../src/bees/active-bizzy.js";
import { activeBreezy } from "../src/bees/active-breezy.js";
import { bizzy } from "../src/bees/bizzy.js";
import { buildSnapshot } from "../src/snapshot.js";
import { strategyFacts } from "../src/cats.js";
import { trainerPlaybook } from "../src/coach-prompt.js";
import { NOW, position } from "./fixtures.js";
import { riskFixture } from "./risk-fixture.js";
import type { BeeId } from "../src/config.js";

function winner(id: BeeId = "tiger", side: "long" | "short" = "long") {
  const h = riskFixture(id), px = side === "long" ? 105 : 95;
  h.b.position = position(h.s, {
    side, entryPx: 100, initialStopPx: side === "long" ? 99 : 101,
    stopPx: side === "long" ? 99 : 101, riskUsd: 1, contracts: 100,
    entryFeesUsd: 0.05, fundingAccruedUsd: 0, entryScore: side === "long" ? 9 : -9,
  });
  Object.assign(h.s, {mid:px, last:px, bid:px*0.99995, ask:px*1.00005,
    confirmed15m:{close:px,ts:NOW-900000}, confirmed4h:{close:px,ts:NOW-14400000},
    ret1hPct:side === "long" ? 1 : -1, macdHistPct:side === "long" ? 0.2 : -0.2});
  h.s.trend!.score = side === "long" ? 9 : -9;
  Object.assign(h.v.tickers.get(h.s.instId)!, {mid:px,last:px,bid:h.s.bid,ask:h.s.ask});
  h.b.uplUsd = 5; h.ctx.uplR = 5;
  h.cfg.exits[id].partialTakeProfitEnabled = true;
  h.cfg.exits[id].partialTakeProfitAtR = 1;
  h.cfg.exits[id].reviewMinR = 0.5;
  return h;
}

describe("active profit-taking decisions", () => {
  it.each(["tiger", "mochi"] as const)("%s offers meaningful after-cost profit choices in either direction", id => {
    for (const side of ["long", "short"] as const) {
      const h = winner(id, side), menu = h.brain.menu(h.ctx);
      expect(menu[id === "tiger" ? "HOLD" : "HOLD_WINNER"]?.intent).toEqual({kind:"hold"});
      expect(menu.CLOSE_PROFIT?.intent).toEqual({kind:"close",reason:"model_profit_take"});
      expect(menu.TAKE_PROFIT?.intent).toMatchObject({kind:"trim",reason:"profit_take"});
      expect(h.brain.managementKey?.(h.ctx)).not.toBeNull();
      expect(h.brain.profitProtection).toBe(true);
      expect(h.brain.exitGate?.(h.ctx)).toEqual({minProb:h.cfg.exits[id].minActionProbability});
    }
  });

  it.each(["tiger", "mochi"] as const)("%s keeps deterministic signal invalidation ahead of profit choices", id => {
    const h = winner(id);
    h.s.ret1hPct = -1; h.s.macdHistPct = -0.2; h.s.trend!.score = 0;
    expect(h.brain.protectiveExit?.(h.ctx)).toBeTruthy();
    const menu = h.brain.menu(h.ctx);
    expect(menu.CLOSE?.intent.kind).toBe("close");
    expect(menu.CLOSE_PROFIT).toBeUndefined();
    expect(menu.TAKE_PROFIT).toBeUndefined();
    expect(menu.ADD_TO_WINNER).toBeUndefined();
  });

  it("does not add while taking profit is offered or buy back a completed profit trim", () => {
    const h = winner("mochi");
    h.b.equityUsd = 250;
    expect(h.brain.menu(h.ctx).TAKE_PROFIT).toBeDefined();
    expect(h.brain.menu(h.ctx).ADD_TO_WINNER).toBeUndefined();
    h.cfg.exits.mochi.partialTakeProfitEnabled = false;
    expect(h.brain.menu(h.ctx).ADD_TO_WINNER).toBeDefined();
    h.b.position!.profitTaken = true;
    expect(h.brain.menu(h.ctx).ADD_TO_WINNER).toBeUndefined();
    h.cfg.exits.mochi.partialTakeProfitEnabled = true;
    expect(h.brain.menu(h.ctx).TAKE_PROFIT).toBeUndefined();
    expect(h.brain.menu(h.ctx).CLOSE_PROFIT).toBeDefined();
  });

  it("preserves Good's channel stop while Dark delegates independent profit trailing to the engine", () => {
    expect(activeBizzy.trail).toBeUndefined();
    const h = winner("mochi"); h.s.trend!.trailStop = 103;
    expect(activeBreezy.trail?.(h.ctx)).toBe(103);
  });

  it("keeps entry-bar cadence unchanged while reviewing a winner between bars", () => {
    const h = winner(), entryKey = h.brain.decisionKey!(h.ctx), profitKey = h.brain.managementKey!(h.ctx);
    h.ctx.now += h.cfg.exits.tiger.reviewIntervalSeconds*1000;
    h.v.ts = h.ctx.now; h.v.tickers.get(h.s.instId)!.ts = h.ctx.now;
    expect(h.brain.decisionKey!(h.ctx)).toBe(entryKey);
    expect(h.brain.managementKey!(h.ctx)).not.toBe(profitKey);
  });

  it("does not offer model profit-taking against a stale executable quote", () => {
    const h = winner(); h.v.tickers.get(h.s.instId)!.ts = NOW-h.cfg.maxTickerAgeMs-1;
    expect(h.brain.managementKey!(h.ctx)).toBeNull();
    expect(Object.keys(h.brain.menu(h.ctx))).toEqual(["HOLD"]);
    expect(buildSnapshot(h.brain,h.ctx).state.profit).toBeUndefined();
  });
});

describe("profit context supplied to Jev and the trainer", () => {
  it("shows net current and peak profit with explicit cost estimates and partial state", () => {
    const h = winner();
    h.b.position!.exitPeakNetPerUnit = 6;
    h.b.position!.profitTaken = true;
    const profit = buildSnapshot(h.brain,h.ctx).state.profit as Record<string,number>;
    expect(profit.net_usd).toBeGreaterThan(4.8);
    expect(profit.net_usd).toBeLessThan(5);
    expect(profit.peak_net_usd).toBe(6);
    expect(profit.giveback_pct).toBeGreaterThan(16);
    expect(profit.breakeven_px).toBeGreaterThan(100);
    expect(profit.partial_done).toBe(1);
    expect(profit.cost_basis_estimated).toBe(0);
    expect(profit.exit_min_p).toBe(h.cfg.exits.tiger.minActionProbability);
    delete h.b.position!.entryFeesUsd;
    expect(buildSnapshot(h.brain,h.ctx).state.profit).toMatchObject({cost_basis_estimated:1});
  });

  it("adds profit context only to held positions in active profit-protection brains", () => {
    const h = winner();
    expect(buildSnapshot(bizzy,h.ctx).state.profit).toBeUndefined();
    h.b.position = null;
    expect(buildSnapshot(h.brain,h.ctx).state.profit).toBeUndefined();
  });

  it.each(["tiger", "mochi"] as const)("%s publishes owner-controlled exit settings and model limitations", id => {
    const h = winner(id), facts = strategyFacts(id,h.cfg).join(" ");
    expect(facts).toContain(`${h.cfg.exits[id].reviewIntervalSeconds} seconds`);
    expect(facts).toContain(`probability >= ${h.cfg.exits[id].minActionProbability}`);
    expect(facts).toContain("model outage cannot veto");
    const playbook = trainerPlaybook(h.cfg).find(p=>p.cat === id)!;
    expect(playbook.moves.some(m=>m.startsWith("CLOSE_PROFIT"))).toBe(true);
    expect(playbook.moves.some(m=>m.startsWith("TAKE_PROFIT"))).toBe(true);
    expect(playbook.accountFields).toContain("cost_basis_estimated");
    expect(playbook.accountFields).toContain("exclude inference costs");
  });
});
