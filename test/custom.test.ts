import { describe, expect, it } from "vitest";
import { customBrain, deriveStyle } from "../src/bees/custom.js";
import { BRAINS } from "../src/bees/index.js";
import { bee, coin, ctx, position, view } from "./fixtures.js";

// A market where TRUMP is the weakest mover, so an unrestricted Momentum bee would never pick it.
const market = () =>
  view([
    coin("PEPE", { ret7dPct: 40, ret24hPct: 10 }),
    coin("DOGE", { ret7dPct: 25, ret24hPct: 5 }),
    coin("SOL", { ret7dPct: 10, ret24hPct: 2 }),
    coin("TRUMP", { ret7dPct: -5, ret24hPct: -1 }),
  ]);

describe("owner-designed bees", () => {
  const trump = customBrain(BRAINS.boozy, { coins: ["TRUMP"], rules: "Only trade TRUMP. Go long when it pumps." });

  it("a coin-restricted bee is only ever offered its own coins", () => {
    const c = ctx("boozy", bee("boozy"), market());
    expect(Object.keys(BRAINS.boozy.menu(c))).toContain("APE_PEPE");
    expect(Object.keys(trump.menu(c))).toEqual(["APE_TRUMP"]);
    expect(trump.universe(c).map((id) => id.split("-")[0])).toEqual(["TRUMP"]);
    expect(trump.forcedEntry(c)?.instId).toMatch(/^TRUMP-/);
    expect(trump.snapshotCoins(c).map((id) => id.split("-")[0])).toEqual(["TRUMP"]);
  });

  it("drops any move that names another coin, and forced entries outside the list become null", () => {
    const m = market();
    const pepe = m.stats.get("PEPE-USD_UM_XPERP-310404")!;
    // Holding PEPE (e.g. adopted from the exchange): managing it is fine, switching to another coin is not.
    const held = bee("boozy", { position: position(pepe, { openedAt: 0 }) });
    const menu = trump.menu(ctx("boozy", held, m));
    for (const opt of Object.values(menu)) {
      if (opt.intent.kind === "open" || opt.intent.kind === "switch") expect(opt.intent.instId).toMatch(/^(TRUMP|PEPE)-/);
    }
    expect(menu.RIDE).toBeDefined();
    const noTrump = view([coin("PEPE"), coin("DOGE")]);
    expect(trump.forcedEntry(ctx("boozy", bee("boozy"), noTrump))).toBeNull();
    expect(trump.menu(ctx("boozy", bee("boozy"), noTrump))).toEqual({});
  });

  it("tells Jev the owner's rules and the coin list", () => {
    expect(trump.strategy).toContain(BRAINS.boozy.strategy);
    expect(trump.strategy).toContain("Owner's rules for this bee");
    expect(trump.strategy).toContain("Only trade TRUMP. Go long when it pumps.");
    expect(trump.strategy).toContain("only ever trades TRUMP");
    expect(trump.id).toBe("boozy");
  });

  it("an unrestricted bee with no rules is the plain brain", () => {
    expect(customBrain(BRAINS.boozy, { coins: [], rules: "" })).toBe(BRAINS.boozy);
    const anyCoin = customBrain(BRAINS.boozy, { coins: [], rules: "Chase pumps." });
    const c = ctx("boozy", bee("boozy"), market());
    expect(Object.keys(anyCoin.menu(c))).toEqual(Object.keys(BRAINS.boozy.menu(c)));
  });

  it("the brain is chosen from the coins", () => {
    expect(deriveStyle("breezy", ["ETH"])).toBe("breezy");
    expect(deriveStyle("breezy", [])).toBe("boozy");
    expect(deriveStyle("bizzy", ["BTC", "HYPE"])).toBe("bizzy");
    expect(deriveStyle("bizzy", ["TRUMP"])).toBe("boozy");
    expect(deriveStyle("boozy", ["BTC"])).toBe("boozy");
  });
});
