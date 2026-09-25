// First-run Setup. With no Jev key anywhere, the engine starts in setup mode: no trading, just the dashboard's Setup
// page. The page is public (a fresh VPS), and there is no code to dig out of a log, so it is protected by:
//  - first come, first served: once saved, Setup is closed for good (until the owner deletes settings.json);
//  - a setup window: SETUP_WINDOW_MIN after the engine starts (default 120), Setup locks until the container restarts;
//  - caps on the calls that cost money (designs and portraits, in total and per visitor).
// The owner picks an owner password here; later writes from the public dashboard need it (gate.ts).
// After a save the engine exits and Docker restarts it with the new settings, in paper trading.
// Each bee is designed from one sentence ("how do you want this bee to trade?"): OpenAI invents its name, rules, coins
// and look, the engine checks the coins against OKX's live list and picks the brain it runs on, then OpenAI paints it.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BEES } from "./config.js";
import { hashPassword, MAX_PASSWORD, MIN_PASSWORD, readJson, send } from "./gate.js";
import { checkJevKey } from "./jev.js";
import { log } from "./log.js";
import { deriveStyle } from "./bees/custom.js";
import { fetchXperpCoins } from "./okx/public.js";
import { checkOpenAiKey, designBee, OpenAiError, paintBee, type BeeDesign } from "./openai.js";
import { safeError } from "./redact.js";
import { clientAddr } from "./visitors.js";
import { BeeSchema, isReservedName, saveSettings, STYLE_INFO, STYLES, type Settings } from "./settings.js";

const MAX_PAINTS = 24;
const MAX_DESIGNS = 60;
/** Per visitor (client address): paid or outbound calls (designs, portraits, key checks). */
const MAX_CALLS_PER_ADDR = 40;
const COINS_TTL_MS = 10 * 60_000;
const MAX_BODY = 32 * 1024;

export interface SetupOpts {
  settingsPath: string;
  jevModel: string;
  openai: { apiKey?: string; textModel: string; imageModel: string };
  /** Reference portraits for the image model (the default bee art). */
  refDir: string;
  /** Called after a successful save (the engine exits so Docker restarts it). */
  onSaved: () => void;
  /** OKX EEA public REST base, for the live coin list. */
  okxApiBase: string;
  /** Minutes after the engine starts that Setup stays open (SETUP_WINDOW_MIN). */
  windowMin: number;
  now?: () => number;
  /** Injectable for tests; defaults to one real Jev call. */
  checkJev?: (key: string, model: string) => Promise<string | null>;
  /** Injectable for tests; default: OKX's live crypto X-Perp list. */
  listCoins?: () => Promise<string[]>;
  /** Injectable for tests; default: one OpenAI text call. */
  design?: (key: string, model: string, description: string, coins: string[]) => Promise<BeeDesign>;
  /** Injectable for tests; default: one OpenAI image call. */
  paint?: (key: string, model: string, refDir: string, name: string, look: string) => Promise<Buffer>;
}

export class DesignError extends Error {}

export const TIMED_OUT =
  "Setup timed out to keep this server safe. Restart the engine container (Hostinger Docker Manager → Restart, or `docker compose restart engine`) to open it again.";

const reservedMsg = (name: string) =>
  `"${name}" belongs to one of the official bees (${STYLES.map((s) => STYLE_INFO[s].name).join(", ")}). Pick another name.`;

/**
 * Checks a design from the model: coins must be on OKX's live list (unknown ones are dropped; if none are left, the
 * owner is asked to rephrase), the brain is forced to one that can trade those coins, reserved names are refused.
 */
export function finishDesign(raw: BeeDesign, known: string[]): BeeDesign {
  const name = raw.name.replace(/[^\p{L}\p{N} .'_-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (!name) throw new DesignError("The designer didn't come up with a name. Press Create again.");
  if (isReservedName(name)) throw new DesignError(`${reservedMsg(name)} Press Create again.`);
  const set = new Set(known);
  const asked = [...new Set(raw.coins.map((c) => c.trim().toUpperCase().replace(/-.*$/, "")).filter(Boolean))];
  const coins = asked.filter((c) => set.has(c)).slice(0, 20);
  if (asked.length && !coins.length) {
    throw new DesignError(`${asked.slice(0, 5).join(", ")} ${asked.length > 1 ? "aren't" : "isn't"} tradable on OKX EEA right now. Try describing your bee again with a coin like BTC, ETH, SOL or DOGE.`);
  }
  const rules = raw.rules.replace(/\s+/g, " ").trim().slice(0, 500);
  if (rules.length < 10) throw new DesignError("The designer didn't write any rules. Press Create again.");
  let tagline = raw.tagline.replace(/\s+/g, " ").trim().slice(0, 40);
  if (tagline && !/^the\b/i.test(tagline)) tagline = `the ${tagline}`.slice(0, 40);
  return { name, tagline, rules, coins, baseStyle: deriveStyle(raw.baseStyle, coins), look: raw.look.replace(/\s+/g, " ").trim().slice(0, 400) };
}

export function imageDir(settingsPath: string): string {
  return join(dirname(settingsPath), "bee-images");
}

export function imagePath(settingsPath: string, slot: string): string | null {
  if (!(BEES as readonly string[]).includes(slot)) return null;
  const p = join(imageDir(settingsPath), `${slot}.jpg`);
  return existsSync(p) ? p : null;
}

const Accept = z.object({ notAdvice: z.literal(true), paperDefault: z.literal(true), ownRisk: z.literal(true) });
/** A Setup-made bee: designed (rules, look) and painted. */
const SetupBee = BeeSchema.extend({
  name: BeeSchema.shape.name.refine((n) => !isReservedName(n), { message: "that name belongs to an official bee" }),
  rules: z.string().trim().min(10).max(500),
  look: z.string().trim().min(3).max(400),
  image: z.literal(true, { errorMap: () => ({ message: "every bee needs its portrait" }) }),
});
const SaveBody = z.object({
  jevKey: z.string().trim().min(8),
  openaiKey: z.string().trim().min(8).optional(),
  accept: Accept,
  bees: z.array(SetupBee).length(3),
  /** Gates the dashboard's writes (joining or leaving the Hive). Stored as a salted scrypt hash only. */
  ownerPassword: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD),
  /** "Join the Hive?" step: an explicit yes or no. A yes joins on the engine's first start (hive.ts). */
  hive: z.boolean(),
});

export class Setup {
  private readonly openedAt: number;
  private readonly now: () => number;
  private calls = new Map<string, number>();
  private paints = 0;
  private designs = 0;
  private saved = false;
  private coins: { at: number; list: string[] } | null = null;

  private checkJev: (key: string, model: string) => Promise<string | null>;
  private listCoins: () => Promise<string[]>;
  private design: (key: string, model: string, description: string, coins: string[]) => Promise<BeeDesign>;
  private paint: (key: string, model: string, refDir: string, name: string, look: string) => Promise<Buffer>;

  constructor(private o: SetupOpts) {
    this.now = o.now ?? Date.now;
    this.openedAt = this.now();
    this.checkJev = o.checkJev ?? checkJevKey;
    this.listCoins = o.listCoins ?? (() => fetchXperpCoins(o.okxApiBase));
    this.design = o.design ?? designBee;
    this.paint = o.paint ?? paintBee;
  }

  /** OKX's live crypto X-Perp coins, cached for a few minutes. */
  private async coinList(): Promise<string[]> {
    if (this.coins && Date.now() - this.coins.at < COINS_TTL_MS) return this.coins.list;
    const list = await this.listCoins();
    if (!list.length) throw new Error("OKX sent an empty coin list");
    this.coins = { at: Date.now(), list };
    return list;
  }

  /** When the setup window closes (ms). */
  get closesAt(): number {
    return this.openedAt + this.o.windowMin * 60_000;
  }

  get timedOut(): boolean {
    return !this.saved && this.now() >= this.closesAt;
  }

  announce(): void {
    log.info("setup is open: open this server's address in a browser to set up your bees", { windowMin: this.o.windowMin });
    const t = setTimeout(() => {
      if (!this.saved) log.warn("setup timed out; restart the engine container to open it again");
    }, this.o.windowMin * 60_000);
    t.unref?.();
  }

  status(req: IncomingMessage) {
    return {
      needed: !this.saved,
      timedOut: this.timedOut,
      closesAt: this.closesAt,
      secure: req.headers["x-forwarded-proto"] === "https",
      serverHasOpenAiKey: !!this.o.openai.apiKey,
      styles: STYLES.map((id) => ({ id, ...STYLE_INFO[id] })),
    };
  }

  /** Handles /setup/*. Returns false if the path is not a setup route. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith("/setup/")) return false;
    if (req.method === "GET" && path === "/setup/status") {
      send(res, 200, this.status(req));
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    if (this.saved) {
      send(res, 409, { error: "Setup is already done. The engine is restarting." });
      return true;
    }
    if (this.timedOut) {
      send(res, 410, { error: TIMED_OUT, timedOut: true });
      return true;
    }
    if (path === "/setup/design" || path === "/setup/paint" || path === "/setup/check-jev" || path === "/setup/check-openai") {
      const addr = clientAddr(req.headers["x-forwarded-for"], req.socket.remoteAddress);
      const n = (this.calls.get(addr) ?? 0) + 1;
      if (n > MAX_CALLS_PER_ADDR) {
        send(res, 429, { error: "That is a lot of requests. Restart the engine to carry on." });
        return true;
      }
      this.calls.set(addr, n);
    }
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req, MAX_BODY)) as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "bad request" });
      return true;
    }
    try {
      await this.route(path, body, res);
    } catch (err) {
      if (err instanceof DesignError) {
        send(res, 422, { error: err.message });
        return true;
      }
      const msg = err instanceof OpenAiError ? `OpenAI said: ${err.message}` : safeError(err).message;
      log.warn("setup step failed", { step: path, err: safeError(err) });
      send(res, 502, { error: msg });
    }
    return true;
  }

  private openaiKey(body: Record<string, unknown>): string | undefined {
    const k = typeof body.openaiKey === "string" ? body.openaiKey.trim() : "";
    return k || this.o.openai.apiKey;
  }

  private async route(path: string, body: Record<string, unknown>, res: ServerResponse) {
    switch (path) {
      case "/setup/check-jev": {
        const key = String(body.key ?? "").trim();
        if (key.length < 8) return send(res, 400, { error: "Paste your Jev API key." });
        const err = await this.checkJev(key, this.o.jevModel);
        return send(res, err ? 400 : 200, err ? { error: err } : { ok: true });
      }

      case "/setup/check-openai": {
        const key = this.openaiKey(body);
        if (!key) return send(res, 400, { error: "Paste your OpenAI API key." });
        await checkOpenAiKey(key);
        return send(res, 200, { ok: true });
      }

      case "/setup/design": {
        const key = this.openaiKey(body);
        const description = String(body.description ?? "").trim();
        if (!key) return send(res, 400, { error: "Designing a bee needs an OpenAI key." });
        if (description.length < 3) return send(res, 400, { error: "Tell us how you want this bee to trade first." });
        if (description.length > 400) return send(res, 400, { error: "Keep it under 400 characters." });
        if (this.designs >= MAX_DESIGNS) return send(res, 429, { error: "That is a lot of bees. Restart the engine to design more." });
        let known: string[];
        try {
          known = await this.coinList();
        } catch (err) {
          log.warn("OKX coin list failed", { err: safeError(err) });
          return send(res, 502, { error: "Couldn't read OKX's coin list just now. Try again in a minute." });
        }
        this.designs++;
        const d = finishDesign(await this.design(key, this.o.openai.textModel, description, known), known);
        return send(res, 200, { ...d, styleLabel: STYLE_INFO[d.baseStyle].label });
      }

      case "/setup/paint": {
        const key = this.openaiKey(body);
        const slot = Number(body.slot);
        const name = String(body.name ?? "").trim().slice(0, 24);
        const look = String(body.look ?? "").trim();
        if (!key) return send(res, 400, { error: "Portraits need an OpenAI key." });
        if (!Number.isInteger(slot) || slot < 0 || slot > 2) return send(res, 400, { error: "bad bee" });
        if (look.length < 3) return send(res, 400, { error: "Describe how your bee looks first." });
        if (this.paints >= MAX_PAINTS) return send(res, 429, { error: "That is a lot of portraits. Restart the engine to paint more." });
        this.paints++;
        const jpg = await this.paint(key, this.o.openai.imageModel, this.o.refDir, name || "a new bee", look);
        const dir = imageDir(this.o.settingsPath);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${BEES[slot]}.jpg`), jpg);
        return send(res, 200, { ok: true, url: `/bee-image/${BEES[slot]}?v=${Date.now()}` });
      }

      case "/setup/save": {
        const parsed = SaveBody.safeParse(body);
        if (!parsed.success) {
          const what = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          return send(res, 400, { error: `Something is missing or not allowed (${what}).` });
        }
        const b = parsed.data;
        if (!b.openaiKey && !this.o.openai.apiKey) return send(res, 400, { error: "Your bees need an OpenAI key (it designs and paints them)." });
        const missing = BEES.filter((slot) => imagePath(this.o.settingsPath, slot) === null);
        if (missing.length) return send(res, 400, { error: "Every bee needs its portrait before you start." });
        const jevErr = await this.checkJev(b.jevKey, this.o.jevModel);
        if (jevErr) return send(res, 400, { error: jevErr });
        // The page's coins and style are re-checked here: coins against OKX's list (when it can be read), the style
        // against the coins.
        const known = await this.coinList().catch(() => null);
        const bees = b.bees.map((bee) => {
          const coins = known ? bee.coins.filter((c) => known.includes(c)) : bee.coins;
          return { ...bee, coins, style: deriveStyle(bee.style, coins), image: true };
        });
        const s: Settings = {
          version: 1,
          jevKey: b.jevKey,
          ownerPasswordHash: hashPassword(b.ownerPassword),
          ...(b.openaiKey ? { openaiKey: b.openaiKey } : {}),
          acceptedRiskAt: Date.now(),
          bees,
          hive: b.hive,
          createdAt: Date.now(),
        };
        saveSettings(this.o.settingsPath, s);
        this.saved = true;
        log.info("setup saved; restarting into paper trading", { bees: bees.map((x) => `${x.name} (${STYLE_INFO[x.style].label})`), hive: b.hive });
        send(res, 200, { ok: true });
        setTimeout(() => this.o.onSaved(), 750);
        return;
      }

      default:
        return send(res, 404, { error: "not found" });
    }
  }
}
