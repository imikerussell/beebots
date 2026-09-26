import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { BeeDesign } from "../src/openai.js";
import { startServer } from "../src/server.js";
import { isReservedName, loadSettings, SettingsSchema } from "../src/settings.js";
import { verifyPassword } from "../src/gate.js";
import { DesignError, finishDesign, imageDir, Setup } from "../src/setup.js";

/** A fake OKX EEA crypto X-Perp list (no network in tests). */
const COINS = ["BTC", "DOGE", "ETH", "HYPE", "PEPE", "SOL", "TRUMP"];

const BEES = [
  { name: "Granny", style: "breezy", tagline: "the calm one", rules: "Buy BTC dips and hold them for days.", coins: ["BTC"], look: "a sleepy bee in a nightcap", image: true },
  { name: "Donny", style: "boozy", tagline: "the loud one", rules: "Only trade TRUMP. Go long when it pumps.", coins: ["TRUMP"], look: "a bee in a red cap", image: true },
  { name: "Rex", style: "boozy", tagline: "the wild one", rules: "Chase whatever is pumping hardest this week.", coins: [], look: "a bee with a dinosaur hoodie", image: true },
];
const ACCEPT = { notAdvice: true, paperDefault: true, ownRisk: true };
const SAVE = { jevKey: "good-jev-key", openaiKey: "sk-test-key", ownerPassword: "correct horse", accept: ACCEPT, bees: BEES, hive: false };

const design = (over: Partial<BeeDesign> = {}): BeeDesign => ({
  name: "Donny",
  tagline: "the loud one",
  rules: "Only trade TRUMP. Go long when it is pumping hard, get out when it stalls.",
  coins: ["TRUMP"],
  baseStyle: "boozy",
  look: "a bee in a red cap and a blue suit",
  ...over,
});

let close: (() => void) | null = null;
afterEach(() => close?.());

async function boot(opts: { designs?: BeeDesign[] } = {}) {
  let now = Date.UTC(2026, 8, 25, 12);
  const dir = mkdtempSync(join(tmpdir(), "bees-setup-"));
  const settingsPath = join(dir, "settings.json");
  let saved = 0;
  const asked: Array<{ description: string; coins: string[] }> = [];
  const designs = [...(opts.designs ?? [])];
  const setup = new Setup({
    settingsPath,
    jevModel: "jev-test",
    openai: { textModel: "t", imageModel: "i" },
    refDir: dir,
    okxApiBase: "https://okx.invalid",
    windowMin: 120,
    now: () => now,
    onSaved: () => saved++,
    checkJev: async (key) => (key === "good-jev-key" ? null : "Jev rejected that key."),
    listCoins: async () => COINS,
    design: async (_key, _model, description, coins) => {
      asked.push({ description, coins });
      return designs.shift() ?? design();
    },
    paint: async () => Buffer.from("jpeg"),
  });
  const server = startServer({ setup, profile: () => ({ setup: true }), beeImage: () => null }, 0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** Portraits on disk, as the paint step leaves them. */
  const paintAll = () => {
    mkdirSync(imageDir(settingsPath), { recursive: true });
    for (const s of ["bee1", "bee2", "bee3"]) writeFileSync(join(imageDir(settingsPath), `${s}.jpg`), "jpeg");
  };
  return { setup, settingsPath, base, post, saved: () => saved, asked, paintAll, advance: (ms: number) => (now += ms) };
}

describe("setup", () => {
  it("needs no code: the page can write straight away", async () => {
    const t = await boot();
    expect((await t.post("/setup/check-jev", { key: "good-jev-key" })).status).toBe(200);
  });

  it("closes when the setup window runs out, with a restart hint", async () => {
    const t = await boot();
    t.paintAll();
    t.advance(119 * 60_000);
    expect((await t.post("/setup/check-jev", { key: "good-jev-key" })).status).toBe(200);
    t.advance(60_000);
    const r = await t.post("/setup/save", SAVE);
    expect(r.status).toBe(410);
    expect(((await r.json()) as { error: string }).error).toMatch(/timed out.*docker compose restart engine/);
    expect(loadSettings(t.settingsPath)).toBeNull();
    const s = (await (await fetch(`${t.base}/setup/status`)).json()) as { timedOut: boolean; needed: boolean };
    expect(s).toMatchObject({ timedOut: true, needed: true });
  });

  it("caps the paid calls per visitor", async () => {
    const t = await boot();
    for (let i = 0; i < 40; i++) expect((await t.post("/setup/design", { openaiKey: "sk-test", description: "a Trump bee" })).status).toBe(200);
    expect((await t.post("/setup/design", { openaiKey: "sk-test", description: "a Trump bee" })).status).toBe(429);
  });

  it("status carries no secrets", async () => {
    const t = await boot();
    const s = (await (await fetch(`${t.base}/setup/status`)).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ needed: true, timedOut: false });
    expect(Object.keys(s).sort()).toEqual(["closesAt", "needed", "secure", "serverHasOpenAiKey", "styles", "timedOut"]);
  });

  it("refuses to save without all three risk statements", async () => {
    const t = await boot();
    t.paintAll();
    const r = await t.post("/setup/save", { ...SAVE, accept: { ...ACCEPT, ownRisk: false } });
    expect(r.status).toBe(400);
    expect(loadSettings(t.settingsPath)).toBeNull();
  });

  it("refuses a Jev key that Jev rejects", async () => {
    const t = await boot();
    t.paintAll();
    const r = await t.post("/setup/save", { ...SAVE, jevKey: "bad-jev-key" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/rejected/);
    expect(loadSettings(t.settingsPath)).toBeNull();
  });

  it("saves owner-only, restarts once, then refuses further writes; the result runs as paper trading", async () => {
    const t = await boot();
    t.paintAll();
    const r = await t.post("/setup/save", SAVE);
    expect(r.status).toBe(200);
    expect(statSync(t.settingsPath).mode & 0o777).toBe(0o600);
    await new Promise((res) => setTimeout(res, 900));
    expect(t.saved()).toBe(1);
    expect((await t.post("/setup/save", SAVE)).status).toBe(409);
    const s = loadSettings(t.settingsPath)!;
    expect(s.bees.map((b) => b.image)).toEqual([true, true, true]);
    expect(s.bees[1]).toMatchObject({ name: "Donny", rules: BEES[1]!.rules, coins: ["TRUMP"], style: "boozy" });
    const cfg = loadConfig({}, s);
    expect(cfg.mode).toBe("dry");
    expect(cfg.slots.bee1).toMatchObject({ name: "Granny", style: "breezy", coins: ["BTC"], fromSetup: true });
    expect(cfg.slots.bee2.rules).toMatch(/TRUMP/);
    expect(readFileSync(t.settingsPath, "utf8")).not.toContain("correct horse");
    expect(s.ownerPasswordHash).toMatch(/^scrypt\$/);
    expect(verifyPassword("correct horse", s.ownerPasswordHash!)).toBe(true);
  });

  it("needs an owner password of at least 8 characters", async () => {
    const t = await boot();
    t.paintAll();
    expect((await t.post("/setup/save", { ...SAVE, ownerPassword: "short" })).status).toBe(400);
    const noPw: Record<string, unknown> = { ...SAVE };
    delete noPw.ownerPassword;
    expect((await t.post("/setup/save", noPw)).status).toBe(400);
    expect(loadSettings(t.settingsPath)).toBeNull();
  });

  it("can't save until every bee has its portrait", async () => {
    const t = await boot();
    const noImage = BEES.map((b, i) => (i === 2 ? { ...b, image: false } : b));
    expect((await t.post("/setup/save", { ...SAVE, bees: noImage })).status).toBe(400);
    // The page claims portraits, but none were painted on this server.
    const r = await t.post("/setup/save", SAVE);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/portrait/);
    expect(loadSettings(t.settingsPath)).toBeNull();
  });

  it("can't save bees that were never designed (no rules or look)", async () => {
    const t = await boot();
    t.paintAll();
    const bare = BEES.map(({ name, style, tagline, image }) => ({ name, style, tagline, image }));
    expect((await t.post("/setup/save", { ...SAVE, bees: bare })).status).toBe(400);
  });

  it("needs an OpenAI key to save", async () => {
    const t = await boot();
    t.paintAll();
    const noKey: Record<string, unknown> = { ...SAVE };
    delete noKey.openaiKey;
    expect((await t.post("/setup/save", noKey)).status).toBe(400);
  });

  it("re-checks coins and the brain on save: unknown coins dropped, style forced from the coins", async () => {
    const t = await boot();
    t.paintAll();
    const bees = [{ ...BEES[0]!, style: "breezy", coins: ["BTC", "NOPE"] }, { ...BEES[1]!, style: "bizzy" }, BEES[2]];
    expect((await t.post("/setup/save", { ...SAVE, bees })).status).toBe(200);
    const s = loadSettings(t.settingsPath)!;
    expect(s.bees[0]).toMatchObject({ coins: ["BTC"], style: "breezy" });
    expect(s.bees[1]).toMatchObject({ coins: ["TRUMP"], style: "boozy" }); // Breakout can't trade TRUMP
  });

  it("refuses the official bees' names, typed by the owner", async () => {
    const t = await boot();
    t.paintAll();
    for (const name of ["Bizzy", "breezy-bee", "Boozy Bee", "BIZZIE"]) {
      const bees = [{ ...BEES[0]!, name }, BEES[1], BEES[2]];
      expect((await t.post("/setup/save", { ...SAVE, bees })).status).toBe(400);
    }
  });

  it("rejects bad bee names", async () => {
    const t = await boot();
    t.paintAll();
    const bees = [{ ...BEES[0]!, name: "<script>" }, BEES[1], BEES[2]];
    expect((await t.post("/setup/save", { ...SAVE, bees })).status).toBe(400);
  });

  it("needs an explicit answer to 'Join the Hive?', and stores it", async () => {
    const t = await boot();
    t.paintAll();
    const noHive: Record<string, unknown> = { ...SAVE };
    delete noHive.hive;
    expect((await t.post("/setup/save", noHive)).status).toBe(400);
    expect((await t.post("/setup/save", { ...SAVE, hive: "yes" })).status).toBe(400);
    expect(loadSettings(t.settingsPath)).toBeNull();
    expect((await t.post("/setup/save", { ...SAVE, hive: true })).status).toBe(200);
    expect(loadSettings(t.settingsPath)!.hive).toBe(true);
  });
});

describe("designing a bee", () => {
  it("gives the model the live coin list and returns a checked design", async () => {
    const t = await boot();
    const r = await t.post("/setup/design", { openaiKey: "sk-test", slot: 1, description: "a Trump bee that only ever trades TRUMP" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: "Donny", coins: ["TRUMP"], baseStyle: "boozy", styleLabel: "Momentum" });
    expect(t.asked[0]).toEqual({ description: "a Trump bee that only ever trades TRUMP", coins: COINS });
  });

  it("needs an OpenAI key and a description", async () => {
    const t = await boot();
    expect((await t.post("/setup/design", { description: "a Trump bee" })).status).toBe(400);
    expect((await t.post("/setup/design", { openaiKey: "sk-test", description: "" })).status).toBe(400);
    expect(t.asked).toHaveLength(0);
  });

  it("refuses an official bee's name from the model, with a clear message", async () => {
    const t = await boot({ designs: [design({ name: "Boozy Bee" })] });
    const r = await t.post("/setup/design", { openaiKey: "sk-test", description: "a party bee" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toMatch(/official bees.*Create again/);
  });

  it("asks the owner to rephrase when none of the coins are on OKX", async () => {
    const t = await boot({ designs: [design({ coins: ["FAKECOIN", "NOPE"] })] });
    const r = await t.post("/setup/design", { openaiKey: "sk-test", description: "a bee for FAKECOIN" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toMatch(/FAKECOIN.*aren't tradable.*again/);
  });
});

describe("finishDesign", () => {
  it("drops unknown coins and keeps the rest", () => {
    expect(finishDesign(design({ coins: ["trump", "NOPE", "TRUMP"] }), COINS).coins).toEqual(["TRUMP"]);
  });

  it("[] means any coin, and runs on Momentum", () => {
    expect(finishDesign(design({ coins: [], baseStyle: "breezy" }), COINS)).toMatchObject({ coins: [], baseStyle: "boozy" });
  });

  it("forces the brain to one that can trade the coins", () => {
    expect(finishDesign(design({ coins: ["BTC"], baseStyle: "breezy" }), COINS).baseStyle).toBe("breezy");
    expect(finishDesign(design({ coins: ["BTC", "ETH"], baseStyle: "breezy" }), COINS).baseStyle).toBe("breezy");
    expect(finishDesign(design({ coins: ["BTC", "SOL"], baseStyle: "breezy" }), COINS).baseStyle).toBe("boozy");
    expect(finishDesign(design({ coins: ["SOL", "HYPE"], baseStyle: "bizzy" }), COINS).baseStyle).toBe("bizzy");
    expect(finishDesign(design({ coins: ["DOGE"], baseStyle: "bizzy" }), COINS).baseStyle).toBe("boozy");
    expect(finishDesign(design({ coins: ["BTC"], baseStyle: "boozy" }), COINS).baseStyle).toBe("boozy");
  });

  it("says why when the brain is switched, and stays quiet when it isn't", () => {
    expect(finishDesign(design({ coins: ["SOL", "DOGE"], baseStyle: "bizzy" }), COINS).styleNote).toBe(
      "Breakout only trades BTC, ETH, SOL and HYPE, so with SOL and DOGE this bee runs on Momentum.",
    );
    expect(finishDesign(design({ coins: [], baseStyle: "breezy" }), COINS).styleNote).toBe("Trend only trades BTC and ETH, so on any coin this bee runs on Momentum.");
    expect(finishDesign(design({ coins: ["BTC"], baseStyle: "breezy" }), COINS).styleNote).toBeUndefined();
    expect(finishDesign(design({ coins: ["DOGE"], baseStyle: "boozy" }), COINS).styleNote).toBeUndefined();
  });

  it("cleans the name and tagline", () => {
    const d = finishDesign(design({ name: "  Sir <Buzz>  ", tagline: "sleepy dip hunter" }), COINS);
    expect(d.name).toBe("Sir Buzz");
    expect(d.tagline).toBe("the sleepy dip hunter");
  });

  it("refuses reserved names", () => {
    expect(() => finishDesign(design({ name: "Bizzy" }), COINS)).toThrow(DesignError);
  });
});

describe("settings", () => {
  it("reserves the official names in their obvious spellings only", () => {
    for (const n of ["Bizzy", "bizzy-bee", "Bizzy Bee", "BizzyBee", "BREEZY", "Breezey bee", "Boozie", "bizy"]) expect(isReservedName(n), n).toBe(true);
    for (const n of ["Buzzy", "Beatrice", "Bee", "Boozer", "Breeze", "Donny"]) expect(isReservedName(n), n).toBe(false);
  });

  it("still reads a Setup file saved before designed bees and the Hive existed", () => {
    const old = {
      version: 1,
      jevKey: "from-setup",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [
        { name: "Bizzy", style: "bizzy", tagline: "the grinder", image: false },
        { name: "Zip", style: "boozy", tagline: "" },
        { name: "Rex", style: "boozy", tagline: "", image: true },
      ],
    };
    const s = SettingsSchema.parse(old);
    expect(s.hive).toBeUndefined();
    expect(s.bees[0]).toMatchObject({ rules: "", coins: [], image: false });
    // A Setup-made bee without a portrait never falls back to the official art (index.ts profile: img null).
    expect(loadConfig({}, s).slots.bee1).toMatchObject({ fromSetup: true, customImage: false });
  });

  it("keeps coins as upper-case tickers", () => {
    const s = SettingsSchema.parse({ version: 1, jevKey: "k".repeat(8), acceptedRiskAt: 1, createdAt: 1, bees: [BEES[0], BEES[1], { ...BEES[2], coins: ["doge"] }] });
    expect(s.bees[2]!.coins).toEqual(["DOGE"]);
    expect(() => SettingsSchema.parse({ version: 1, jevKey: "k".repeat(8), acceptedRiskAt: 1, createdAt: 1, bees: [BEES[0], BEES[1], { ...BEES[2], coins: ["$$$"] }] })).toThrow();
  });
});
