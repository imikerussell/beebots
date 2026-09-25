import { describe, expect, it } from "vitest";
import { LIVE_ACK_PHRASE, loadConfig } from "../src/config.js";
import type { Settings } from "../src/settings.js";

describe("config", () => {
  it("DRY_RUN defaults to true, which forces dry whatever MODE says", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "live" }).mode).toBe("dry");
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "demo", DRY_RUN: "true" }).mode).toBe("dry");
  });

  it("refuses to start without the Jev key", () => {
    expect(() => loadConfig({})).toThrow(/TYPESAFE_API_KEY/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "  " })).toThrow(/TYPESAFE_API_KEY/);
  });

  it("demo needs all three demo keys and lists the missing NAMES only", () => {
    const env = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo", BEE1_OKX_DEMO_API_KEY: "secret-value-1" };
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/BEE1_OKX_DEMO_API_SECRET/);
    expect(msg).toMatch(/BEE3_OKX_DEMO_API_KEY/);
    expect(msg).not.toMatch(/secret-value-1/);
    expect(msg).not.toMatch(/BEE1_OKX_API_KEY\b/); // live keys not required in demo
  });

  it("demo with every key set loads per-bee creds", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo" };
    for (const b of ["BEE1", "BEE2", "BEE3"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_DEMO_API_${f}`] = `${b}-${f}`;
    const cfg = loadConfig(env);
    expect(cfg.mode).toBe("demo");
    expect(cfg.creds.bee3?.apiKey).toBe("BEE3-KEY");
  });

  it("live needs the written risk acknowledgement, and demo/dry do not", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "live" };
    for (const b of ["BEE1", "BEE2", "BEE3"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_API_${f}`] = `${b}-${f}`;
    expect(() => loadConfig(env)).toThrow(/LIVE_ACK/);
    expect(() => loadConfig({ ...env, LIVE_ACK: "yes" })).toThrow(/LIVE_ACK/);
    expect(loadConfig({ ...env, LIVE_ACK: LIVE_ACK_PHRASE }).mode).toBe("live");
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }).mode).toBe("dry");
  });

  it("with no Setup file the bees are the original three", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.slots.bee1).toMatchObject({ style: "bizzy", name: "Bizzy", customImage: false });
    expect(c.slots.bee2).toMatchObject({ style: "breezy", name: "Breezy" });
    expect(c.slots.bee3).toMatchObject({ style: "boozy", name: "Boozy" });
  });

  it("a Setup file supplies the Jev key and the bees; the environment still wins", () => {
    const settings: Settings = {
      version: 1,
      jevKey: "from-setup",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [
        { name: "Granny", style: "breezy", tagline: "the calm one", rules: "Buy BTC dips.", coins: ["BTC"], image: true },
        { name: "Zippy", style: "boozy", tagline: "", rules: "", coins: [], image: false },
        { name: "Rex", style: "boozy", tagline: "", rules: "", coins: [], image: false },
      ],
    };
    const c = loadConfig({}, settings);
    expect(c.jev.apiKey).toBe("from-setup");
    expect(c.mode).toBe("dry");
    expect(c.slots.bee1).toMatchObject({ name: "Granny", style: "breezy", customImage: true, rules: "Buy BTC dips.", coins: ["BTC"], fromSetup: true });
    expect(c.slots.bee3.style).toBe("boozy");
    expect(loadConfig({ TYPESAFE_API_KEY: "env" }, settings).jev.apiKey).toBe("env");
  });

  it("defaults match the strategy files", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.bees.bizzy).toMatchObject({ maxTradesPerDay: 1, feeBudgetUsdDay: 1, spreadGateBps: 5, maxFlatMinutes: 20 });
    expect(c.bees.boozy).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 3, spreadGateBps: 15, maxFlatMinutes: 0 });
    expect(c.bees.breezy).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 1, maxFlatMinutes: 0, cooldownMinutes: 240 });
    expect(c.tickMs).toBe(10_000);
    expect(c.jev.dailyUsdCap).toBe(2);
    expect(c.dataRefreshMs).toBe(60_000);
    expect(c.risk.maxLeverage).toBe(2);
  });
});
