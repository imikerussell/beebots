import { describe, expect, it } from "vitest";
import { BEES, loadConfig, LIVE_ACK_PHRASE } from "../src/config.js";
import { SettingsSchema } from "../src/settings.js";
describe("Catfolio configuration", () => {
  it("has exactly two independent allocations totaling $200, paper with no keys", () => {
    const c = loadConfig({});
    expect(BEES).toEqual(["tiger", "mochi"]);
    expect(Object.keys(c.slots)).toHaveLength(2);
    expect(c.mode).toBe("dry");
    expect(c.cats.tiger.startEquityUsd).toBe(100);
    expect(c.cats.mochi.startEquityUsd).toBe(100);
    expect(c.creds).toEqual({});
    expect(c.local.origin).toBe("http://127.0.0.1:1234");
    expect(c.local.model).toBe("");
    expect(c.tickMs).toBe(10000);
    expect(c.protectiveMs).toBe(5000);
  });
  it("validates configurable allocations and numerical bounds", () => {
    const c = loadConfig({
      TOTAL_START_EQUITY_USD: "1000",
      TIGER_ALLOCATION_PCT: "70",
      MOCHI_ALLOCATION_PCT: "30",
    });
    expect(c.cats.tiger.startEquityUsd).toBe(700);
    expect(c.cats.mochi.startEquityUsd).toBe(300);
    for (const e of [
      { TIGER_ALLOCATION_PCT: "70" },
      { TOTAL_START_EQUITY_USD: "NaN" },
      { TOTAL_START_EQUITY_USD: "-1" },
      { MOCHI_STOP_RISK_PCT: "Infinity" },
      { LM_STUDIO_CONCURRENCY: "1.5" },
      { DRY_RUN: "maybe" },
    ])
      expect(() => loadConfig(e)).toThrow();
  });
  it("retains manual live safeguards and requires only two distinct account credentials", () => {
    expect(loadConfig({ MODE: "live" }).mode).toBe("dry");
    expect(() => loadConfig({ DRY_RUN: "false", MODE: "live" })).toThrow(
      /LIVE_ACK/,
    );
    const keys = Object.fromEntries(
      BEES.flatMap((id) =>
        ["KEY", "SECRET", "PASSPHRASE"].map((k) => [
          `${id.toUpperCase()}_OKX_API_${k}`,
          `${id}-${k}`,
        ]),
      ),
    );
    const c = loadConfig({
      ...keys,
      DRY_RUN: "false",
      MODE: "live",
      LIVE_ACK: LIVE_ACK_PHRASE,
    });
    expect(Object.keys(c.creds)).toEqual(BEES);
    expect(c.risk.liveSizeMultiplier).toBe(0.25);
    expect(() =>
      loadConfig({
        ...keys,
        TIGER_OKX_API_KEY: "same",
        MOCHI_OKX_API_KEY: "same",
        DRY_RUN: "false",
        MODE: "live",
        LIVE_ACK: LIVE_ACK_PHRASE,
      }),
    ).toThrow(/distinct/);
  });
  it("rejects legacy and extra identities in settings", () => {
    expect(
      SettingsSchema.safeParse({ version: 1, bees: [{}, {}, {}] }).success,
    ).toBe(false);
    const cats = [
      { id: "tiger", name: "Tiger", rules: "WAIT" },
      { id: "mochi", name: "Mochi", rules: "WAIT" },
    ];
    expect(SettingsSchema.safeParse({ version: 2, cats }).success).toBe(true);
    expect(
      SettingsSchema.safeParse({ version: 2, cats: [...cats, cats[0]] })
        .success,
    ).toBe(false);
  });
});
