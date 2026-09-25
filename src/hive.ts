// The Hive: an opt-in public leaderboard at beebots.tech (HIVE_URL). A joined install reports its bees (name, style,
// tagline, trading rules and coins, equity, funding, trade count) and every fill since the experiment started, every 5 minutes. The server checks each
// fill against OKX's public candles and replays the books, so a bee's badge means its numbers add up.
// Paper only: the reporter refuses to run in MODE=live, and the server rejects live reports too.
// What is sent: the report below and nothing else. Paper results only (the board shows % gain/loss); no OKX, Jev or
// OpenAI keys, no exchange account details, no IP addresses or paths. The only secret is the hive key, a random value made on join that proves later
// reports (and a leave) come from the same install.
// Joining and leaving are writes from a public page, so they need the owner password picked on Setup.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Mode } from "./config.js";
import type { Db } from "./db.js";
import { PasswordGate, readJson, send } from "./gate.js";
import { log } from "./log.js";
import { safeError } from "./redact.js";
import { writePrivateJson } from "./settings.js";

export const HIVE_MAX_FILLS = 3000;
const MAX_BODY = 16 * 1024;
/** First report after an engine start, and after joining from the dashboard. */
const FIRST_REPORT_MS = 30_000;
const JOIN_REPORT_MS = 5_000;
const EVERY_S = 300;
/** The server answers 429 inside 240 s of a hive's last report. */
const MIN_EVERY_S = 240;
const MAX_BACKOFF_S = 3600;
const TIMEOUT_MS = 15_000;
/** The Hive's limit for one portrait (Setup's portraits are 1024 px JPEGs, ~150-300 KB). */
const PORTRAIT_MAX_BYTES = 600 * 1024;

const StateSchema = z.object({
  joined: z.boolean(),
  hiveId: z.string().uuid().optional(),
  key: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  joinedAt: z.number().optional(),
  leftAt: z.number().optional(),
});
/** /data/hive.json. Joined: hiveId + key + joinedAt. Left: only leftAt (the key is wiped). */
export type HiveState = z.infer<typeof StateSchema>;

export function hivePath(settingsPath: string): string {
  return join(dirname(settingsPath), "hive.json");
}

export function loadHive(path: string): HiveState | null {
  if (!existsSync(path)) return null;
  try {
    const s = StateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return s.joined && !(s.hiveId && s.key) ? null : s;
  } catch {
    log.warn("hive.json is not valid; treating this install as not in the Hive");
    return null;
  }
}

function appVersion(): string {
  try {
    // ../package.json from both src/ (dev) and dist/ (the image).
    const v = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version;
    return `beebots/${v ?? "unknown"}`;
  } catch {
    return "beebots/unknown";
  }
}

/** The engine's live state, as the reporter needs it. */
export interface HiveInput {
  startedAt: number;
  startEquityUsd: number;
  /** fundingUsd: net funding booked to the bee since startedAt (+ received, - paid). rules/coins: from Setup. */
  bees: Array<{ slot: string; name: string; style: string; tagline: string; rules: string; coins: string[]; equityUsd: number; fundingUsd: number; cap: string | null; tradesToday: number }>;
}

export type HiveReport = ReturnType<typeof buildReport>;

/** The exact body of POST /hive/report (contract v1, amendments 1 and 2). */
export function buildReport(creds: { hiveId: string; key: string }, mode: "dry" | "demo", app: string, input: HiveInput, db: Pick<Db, "hiveFills">) {
  // One extra row tells us whether the history is longer than the cap. The oldest fills are sent (the replay needs
  // them from the start); fillsTruncated tells the server the rest is missing, so it marks the bees unverified.
  const fills = db.hiveFills(input.startedAt, HIVE_MAX_FILLS + 1);
  const fillsTruncated = fills.length > HIVE_MAX_FILLS;
  return {
    v: 1 as const,
    hiveId: creds.hiveId,
    key: creds.key,
    mode,
    app,
    startedAt: input.startedAt,
    startEquityUsd: input.startEquityUsd,
    bees: input.bees.map((b) => ({
      slot: b.slot,
      name: b.name,
      style: b.style,
      tagline: b.tagline,
      // Amendment 2: the owner's rules, so others can copy a winning bee. Omitted for bees without any.
      ...(b.rules.trim() ? { instructions: b.rules.trim().slice(0, 600) } : {}),
      coins: b.coins,
      equityUsd: Number(b.equityUsd.toFixed(2)),
      fundingUsd: Number(b.fundingUsd.toFixed(4)),
      retired: b.cap === "retired",
      tradesToday: b.tradesToday,
    })),
    fillsTruncated,
    fills: fillsTruncated ? fills.slice(0, HIVE_MAX_FILLS) : fills,
  };
}

export interface HiveOpts {
  /** hive.json (next to settings.json). */
  path: string;
  /** HIVE_URL, no trailing slash. */
  url: string;
  mode: Mode;
  source: () => HiveInput;
  db: Pick<Db, "hiveFills">;
  /** The owner password's scrypt hash (Setup, or OWNER_PASSWORD), null when none is set. */
  ownerPasswordHash: () => string | null;
  /** File path of a bee's painted portrait (a JPEG from Setup), or null. Uploaded so the board shows it. */
  portrait?: (slot: string) => string | null;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export class Hive {
  private gate: PasswordGate;
  private state: HiveState | null;
  private timer: NodeJS.Timeout | null = null;
  private reporting = false;
  private failures = 0;
  private stopped = false;
  private lastReportAt: number | null = null;
  private verified: Record<string, boolean> | null = null;
  /** What went wrong with the last report, in words for the dashboard (null = fine). */
  private problem: string | null = null;
  private readonly app = appVersion();
  /** Portraits the Hive refused (slot -> portrait id), so the same file is not sent every 5 minutes. */
  private portraitRefused = new Map<string, string>();
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private o: HiveOpts) {
    this.state = loadHive(o.path);
    this.gate = new PasswordGate("x-owner-password", o.ownerPasswordHash, "owner password");
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  get joined(): boolean {
    return !!this.state?.joined;
  }

  private get paper(): boolean {
    return this.o.mode !== "live";
  }

  /**
   * Engine start. `setup` is the Setup page's "Join the Hive?" answer: it is acted on once, unless the owner has
   * joined or left from the dashboard since that Setup (that choice is newer, so it wins).
   */
  start(setup: { hive?: boolean; createdAt: number } | null = null): void {
    this.stopped = false;
    if (setup?.hive !== undefined) {
      const decidedAt = (this.state?.joined ? this.state.joinedAt : this.state?.leftAt) ?? 0;
      if (decidedAt < setup.createdAt) {
        if (setup.hive && !this.joined) {
          if (this.paper) {
            this.join();
            log.info("joined the Hive, as chosen on the Setup page");
          } else log.warn("not joining the Hive: it is paper only, and this engine runs MODE=live");
        } else if (!setup.hive && this.joined) {
          // Setup was run again and the answer this time was "Not now".
          void this.leave().catch((err) => log.warn("could not leave the Hive", { err: safeError(err) }));
        }
      }
    }
    if (!this.joined) return;
    if (!this.paper) {
      log.warn("the Hive is paper only: not reporting while MODE=live (leave from the dashboard, or go back to paper)");
      return;
    }
    this.schedule(FIRST_REPORT_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** New hive id and key. The first report registers them with the server. */
  join(): void {
    if (!this.paper) throw new Error("The Hive is for paper trading only.");
    if (this.joined) return;
    this.state = { joined: true, hiveId: randomUUID(), key: randomBytes(32).toString("hex"), joinedAt: this.now() };
    writePrivateJson(this.o.path, this.state);
    this.resetReportState();
    if (!this.stopped) this.schedule(JOIN_REPORT_MS);
  }

  /** Ask the server to drop this hive and its history, then wipe the key locally whatever the server said. */
  async leave(): Promise<{ remote: boolean; detail: string }> {
    const st = this.state;
    if (!st?.joined || !st.hiveId || !st.key) return { remote: true, detail: "This install is not in the Hive." };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let remote = false;
    let detail: string;
    try {
      const r = await this.fetch(`${this.o.url}/hive/report`, {
        method: "DELETE",
        headers: { "content-type": "application/json", "user-agent": this.app },
        body: JSON.stringify({ hiveId: st.hiveId, key: st.key }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      remote = r.ok;
      detail = r.ok ? "Your bees are off the board, with their history." : r.status === 401 ? "The Hive did not recognise this install's key, so it could not remove anything." : `The Hive answered HTTP ${r.status}.`;
    } catch (err) {
      detail = `Could not reach the Hive (${safeError(err).message}).`;
    }
    this.state = { joined: false, leftAt: this.now() };
    writePrivateJson(this.o.path, this.state);
    this.resetReportState();
    if (remote) log.info("left the Hive; the server removed this hive and its history");
    else log.warn("left the Hive on this server, but the Hive did not confirm the removal; no more reports will be sent", { detail });
    return { remote, detail: remote ? detail : `Left on this server: no more reports will be sent. ${detail}` };
  }

  private resetReportState() {
    this.failures = 0;
    this.lastReportAt = null;
    this.verified = null;
    this.problem = null;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick() {
    this.timer = null;
    const nextS = await this.report();
    if (nextS !== null && !this.stopped && this.joined) this.schedule(nextS * 1000);
  }

  private backoff(retryAfterS = 0): number {
    this.failures++;
    return Math.min(MAX_BACKOFF_S, Math.max(retryAfterS, EVERY_S * 2 ** (this.failures - 1)));
  }

  /** One report. Returns seconds until the next one, or null to stop reporting. */
  async report(): Promise<number | null> {
    const st = this.state;
    if (!st?.joined || !st.hiveId || !st.key) return null;
    if (!this.paper) {
      log.warn("the Hive is paper only: not reporting while MODE=live");
      return null;
    }
    if (this.reporting) return EVERY_S;
    this.reporting = true;
    try {
      let body: string;
      let counts: { bees: number; fills: number; fillsTruncated?: boolean };
      try {
        const r = buildReport({ hiveId: st.hiveId, key: st.key }, this.o.mode as "dry" | "demo", this.app, this.o.source(), this.o.db);
        counts = { bees: r.bees.length, fills: r.fills.length, ...(r.fillsTruncated ? { fillsTruncated: true } : {}) };
        body = JSON.stringify(r);
      } catch (err) {
        log.warn("hive report not built", { err: safeError(err) });
        return this.backoff();
      }
      let res: Response;
      try {
        res = await this.fetch(`${this.o.url}/hive/report`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": this.app },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        this.problem = "The Hive is unreachable right now. Retrying.";
        const next = this.backoff();
        log.warn("hive report failed", { err: safeError(err), retryInS: next });
        return next;
      }
      // Left (or re-joined) while this report was in flight: its answer is about a hive that no longer matters.
      if (this.state?.hiveId !== st.hiveId) return null;
      const j = (await res.json().catch(() => ({}))) as { verified?: Record<string, boolean>; nextReportInS?: number; error?: string; portraits?: Record<string, string | null> };
      if (res.ok) {
        if (j.portraits && typeof j.portraits === "object") await this.syncPortraits({ hiveId: st.hiveId, key: st.key }, j.portraits);
        this.failures = 0;
        this.problem = null;
        this.lastReportAt = this.now();
        this.verified = j.verified && typeof j.verified === "object" ? j.verified : {};
        const next = Math.min(MAX_BACKOFF_S, Math.max(MIN_EVERY_S, Number(j.nextReportInS) || EVERY_S));
        log.info("hive report", { ...counts, verified: this.verified, nextInS: next });
        return next;
      }
      if (res.status === 401) {
        this.problem = "This hive key no longer matches. Leave and re-join.";
        log.error("hive report refused (401): this hive key no longer matches; leave and re-join the Hive from the dashboard. Reporting has stopped.");
        return null;
      }
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const next = this.backoff(retryAfter);
      if (res.status === 429 || res.status >= 500) {
        this.problem = res.status === 429 ? "The Hive asked this install to slow down. Retrying later." : "The Hive is having trouble. Retrying later.";
        log.warn("hive report deferred", { status: res.status, retryInS: next });
      } else {
        const why = typeof j.error === "string" ? j.error.slice(0, 200) : `HTTP ${res.status}`;
        this.problem = `The Hive refused the report: ${why}`;
        log.warn("hive report refused", { status: res.status, error: why, retryInS: next });
      }
      return next;
    } finally {
      this.reporting = false;
    }
  }

  /**
   * Uploads each bee's portrait the Hive does not hold yet (it answers every report with the id it holds per slot:
   * the first 24 hex of the JPEG's sha256). A failure never affects reporting; it is retried after the next report.
   */
  private async syncPortraits(creds: { hiveId: string; key: string }, held: Record<string, string | null>) {
    if (!this.o.portrait) return;
    for (const slot of Object.keys(held)) {
      const file = this.o.portrait(slot);
      if (!file || !existsSync(file)) continue;
      let jpeg: Buffer;
      try {
        jpeg = readFileSync(file);
      } catch (err) {
        log.warn("hive portrait not read", { slot, err: safeError(err) });
        continue;
      }
      const id = createHash("sha256").update(jpeg).digest("hex").slice(0, 24);
      if (held[slot] === id || this.portraitRefused.get(slot) === id) continue;
      if (jpeg.length > PORTRAIT_MAX_BYTES) {
        this.portraitRefused.set(slot, id);
        log.warn("hive portrait not sent: over 600 KB", { slot, bytes: jpeg.length });
        continue;
      }
      try {
        const r = await this.fetch(`${this.o.url}/hive/portrait`, {
          method: "PUT",
          headers: { "content-type": "application/json", "user-agent": this.app },
          body: JSON.stringify({ hiveId: creds.hiveId, key: creds.key, slot, jpeg: jpeg.toString("base64") }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (r.ok) log.info("hive portrait sent", { slot });
        else {
          // 4xx (not a rate limit) means this file will never be accepted; anything else is retried.
          if (r.status >= 400 && r.status < 500 && r.status !== 429) this.portraitRefused.set(slot, id);
          log.warn("hive portrait refused", { slot, status: r.status });
        }
      } catch (err) {
        log.warn("hive portrait not sent", { slot, err: safeError(err) });
      }
    }
  }

  /** Public: no hive id, no key. */
  status() {
    return {
      joined: this.joined,
      paper: this.paper,
      board: this.o.url,
      lastReportAt: this.lastReportAt,
      verified: this.verified,
      problem: this.problem,
      locked: this.gate.locked,
      /** false: no owner password on this server yet (run Setup again to pick one). */
      passwordSet: this.gate.set,
    };
  }

  /** Handles /hive/status, /hive/join and /hive/leave. Returns false for any other path. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === "/hive/status") {
      if (req.method !== "GET") send(res, 405, { error: "method not allowed" });
      else send(res, 200, this.status());
      return true;
    }
    if (path !== "/hive/join" && path !== "/hive/leave") return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    const gate = this.gate.check(req);
    if (gate === "locked") {
      send(res, 429, { error: "Too many wrong passwords. Joining and leaving are locked for 15 minutes." });
      return true;
    }
    if (gate === "unset") {
      send(res, 409, { error: "This server has no owner password yet. Run Setup again to pick one (see the README), or set OWNER_PASSWORD." });
      return true;
    }
    if (gate === "bad") {
      send(res, 401, { error: "That owner password is not right." });
      return true;
    }
    try {
      await readJson(req, MAX_BODY);
    } catch {
      send(res, 400, { error: "bad request" });
      return true;
    }
    if (path === "/hive/join") {
      if (!this.paper) {
        send(res, 409, { error: "The Hive is for paper trading only, and this engine runs MODE=live." });
        return true;
      }
      if (!this.joined) {
        this.join();
        log.info("joined the Hive from the dashboard");
      }
      send(res, 200, { ok: true, ...this.status() });
      return true;
    }
    const r = await this.leave();
    send(res, 200, { ok: true, left: r, ...this.status() });
    return true;
  }
}
