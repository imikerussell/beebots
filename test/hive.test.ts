import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { buildReport, Hive, HIVE_MAX_FILLS, type HiveInput } from "../src/hive.js";
import { hashPassword } from "../src/gate.js";
import { startServer } from "../src/server.js";

const START = Date.UTC(2026, 8, 24, 0, 0, 0);
const BTC = "BTC-USD_UM_XPERP-310404";
const INPUT: HiveInput = {
  startedAt: START,
  startEquityUsd: 333,
  bees: [
    { slot: "bee1", name: "Granny", style: "breezy", tagline: "the calm one", rules: "Buy BTC dips, then wait.", coins: ["BTC"], equityUsd: 332.104, fundingUsd: -0.42, cap: null, tradesToday: 1 },
    { slot: "bee2", name: "Zip", style: "boozy", tagline: "", rules: "", coins: [], equityUsd: 120, fundingUsd: 0, cap: "retired", tradesToday: 0 },
    { slot: "bee3", name: "Rex", style: "bizzy", tagline: "the wild one", rules: "Only trade TRUMP.", coins: ["TRUMP"], equityUsd: 340, fundingUsd: 0.13, cap: "loss_stop", tradesToday: 2 },
  ],
};

/** A fill the way the engine records one: notional = contracts x ctVal x px. */
function fill(db: Db, bee: string, ts: number, side: "buy" | "sell", contracts: number, ctVal: number, px: number, reduceOnly: boolean, feeUsd = 0.05) {
  const orderId = db.insertOrder({ decisionId: 1, bee: bee as "bee1", ts, clOrdId: `c${ts}${bee}${Math.random()}`, instId: BTC, side, contracts, reduceOnly, purpose: "test" });
  db.insertFill({ orderId, bee: bee as "bee1", ts, instId: BTC, side, contracts, px, notionalUsd: contracts * ctVal * px, feeUsd, realisedUsd: 0 });
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };
function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const r = responses.shift() ?? { status: 200, body: { ok: true, verified: {}, nextReportInS: 300 } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { f, calls };
}

const PASSWORD = "correct horse";
const HASH = hashPassword(PASSWORD);

const hives: Hive[] = [];
let close: (() => void) | null = null;
afterEach(() => {
  for (const h of hives.splice(0)) h.stop();
  close?.();
  close = null;
});

function makeHive(opts: { mode?: "dry" | "demo" | "live"; responses?: Parameters<typeof mockFetch>[0]; dir?: string; db?: Db; hash?: string | null; portrait?: (slot: string) => string | null } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "bees-hive-"));
  const db = opts.db ?? new Db(":memory:");
  const m = mockFetch(opts.responses ?? []);
  const path = join(dir, "hive.json");
  const hive = new Hive({ path, url: "https://hive.test", mode: opts.mode ?? "dry", source: () => INPUT, db, fetch: m.f, portrait: opts.portrait, ownerPasswordHash: () => (opts.hash === undefined ? HASH : opts.hash) });
  hives.push(hive);
  return { hive, path, dir, db, calls: m.calls };
}

const readState = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("hive report", () => {
  it("matches the contract: bees from the engine, every fill since the start, oldest first, qty in base units", () => {
    const db = new Db(":memory:");
    fill(db, "bee1", START - 60_000, "buy", 1, 0.01, 80_000, false); // before the experiment: not sent
    fill(db, "bee3", START + 120_000, "sell", 3, 0.01, 84_600, true, 0.12);
    fill(db, "bee1", START + 60_000, "buy", 21, 0.0001, 84_549.5, false, 0.089);
    const r = buildReport({ hiveId: "0b6b2a52-6a1f-4c1e-9a4f-3f7f5b0b6c11", key: "a".repeat(64) }, "dry", "beebots/test", INPUT, db);

    expect(Object.keys(r).sort()).toEqual(["app", "bees", "fills", "fillsTruncated", "hiveId", "key", "mode", "startEquityUsd", "startedAt", "v"]);
    expect(r).toMatchObject({ v: 1, mode: "dry", app: "beebots/test", startedAt: START, startEquityUsd: 333, fillsTruncated: false });
    expect(r.bees).toEqual([
      { slot: "bee1", name: "Granny", style: "breezy", tagline: "the calm one", instructions: "Buy BTC dips, then wait.", coins: ["BTC"], equityUsd: 332.1, fundingUsd: -0.42, retired: false, tradesToday: 1 },
      { slot: "bee2", name: "Zip", style: "boozy", tagline: "", coins: [], equityUsd: 120, fundingUsd: 0, retired: true, tradesToday: 0 },
      { slot: "bee3", name: "Rex", style: "bizzy", tagline: "the wild one", instructions: "Only trade TRUMP.", coins: ["TRUMP"], equityUsd: 340, fundingUsd: 0.13, retired: false, tradesToday: 2 },
    ]);
    expect(r.fills).toEqual([
      { slot: "bee1", instId: BTC, side: "buy", qty: 0.0021, px: 84_549.5, ts: START + 60_000, feeUsd: 0.089, reduceOnly: false },
      { slot: "bee3", instId: BTC, side: "sell", qty: 0.03, px: 84_600, ts: START + 120_000, feeUsd: 0.12, reduceOnly: true },
    ]);
  });

  it(`sends at most ${HIVE_MAX_FILLS} fills, the oldest ones, and flags the cut`, () => {
    const db = new Db(":memory:");
    for (let i = 0; i < HIVE_MAX_FILLS + 5; i++) fill(db, "bee1", START + i * 1000, i % 2 ? "sell" : "buy", 1, 0.01, 100, i % 2 === 1);
    const r = buildReport({ hiveId: "x", key: "y" }, "demo", "a", INPUT, db);
    expect(r.fills).toHaveLength(HIVE_MAX_FILLS);
    expect(r.fills[0]!.ts).toBe(START);
    expect(r.fills.at(-1)!.ts).toBe(START + (HIVE_MAX_FILLS - 1) * 1000);
    expect(r.fillsTruncated).toBe(true);
  });

  it(`does not flag exactly ${HIVE_MAX_FILLS} fills as truncated`, () => {
    const db = new Db(":memory:");
    for (let i = 0; i < HIVE_MAX_FILLS; i++) fill(db, "bee1", START + i * 1000, "buy", 1, 0.01, 100, false);
    const r = buildReport({ hiveId: "x", key: "y" }, "dry", "a", INPUT, db);
    expect(r.fills).toHaveLength(HIVE_MAX_FILLS);
    expect(r.fillsTruncated).toBe(false);
  });

  it("posts only the report (hive key, no other secret) and keeps the verified map", async () => {
    const t = makeHive({ responses: [{ status: 200, body: { ok: true, verified: { bee1: true, bee2: false }, nextReportInS: 600 } }] });
    t.hive.join();
    const key = readState(t.path).key as string;
    expect(await t.hive.report()).toBe(600);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe("https://hive.test/hive/report");
    expect(t.calls[0]!.method).toBe("POST");
    expect(t.calls[0]!.body!.key).toBe(key);
    expect(t.hive.status()).toMatchObject({ joined: true, verified: { bee1: true, bee2: false }, problem: null });
    expect(t.hive.status().lastReportAt).toBeGreaterThan(0);
  });

  it("clamps nextReportInS to at least 240 s", async () => {
    const t = makeHive({ responses: [{ status: 200, body: { ok: true, verified: {}, nextReportInS: 5 } }] });
    t.hive.join();
    expect(await t.hive.report()).toBe(240);
  });

  it("backs off on 429 and 5xx, doubling, and resets after a success", async () => {
    const t = makeHive({ responses: [{ status: 429 }, { status: 503 }, new Error("ECONNREFUSED"), { status: 200, body: { ok: true, verified: {}, nextReportInS: 300 } }, { status: 500 }] });
    t.hive.join();
    expect(await t.hive.report()).toBe(300);
    expect(t.hive.status().problem).toMatch(/slow down/);
    expect(await t.hive.report()).toBe(600);
    expect(await t.hive.report()).toBe(1200);
    expect(t.hive.status().problem).toMatch(/unreachable/);
    expect(await t.hive.report()).toBe(300);
    expect(await t.hive.report()).toBe(300);
  });

  it("honours Retry-After on a 429", async () => {
    const t = makeHive({ responses: [{ status: 429, headers: { "retry-after": "900" } }] });
    t.hive.join();
    expect(await t.hive.report()).toBe(900);
  });

  it("stops on 401 and says to leave and re-join", async () => {
    const t = makeHive({ responses: [{ status: 401, body: { error: "key mismatch" } }] });
    t.hive.join();
    expect(await t.hive.report()).toBeNull();
    expect(t.hive.status().problem).toMatch(/no longer matches.*re-join/i);
  });

  it("refuses to run in MODE=live: no join, no report, no request", async () => {
    const t = makeHive({ mode: "live" });
    expect(() => t.hive.join()).toThrow(/paper/);
    t.hive.start({ hive: true, createdAt: Date.now() });
    expect(existsSync(t.path)).toBe(false);
    expect(await t.hive.report()).toBeNull();
    expect(t.calls).toHaveLength(0);
    expect(t.hive.status()).toMatchObject({ joined: false, paper: false });
  });

  it("will not report from live even with a hive.json left over from paper trading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bees-hive-"));
    makeHive({ dir }).hive.join();
    const t = makeHive({ dir, mode: "live" });
    expect(t.hive.joined).toBe(true);
    expect(await t.hive.report()).toBeNull();
    expect(t.calls).toHaveLength(0);
  });
});

describe("hive state file", () => {
  it("join writes an owner-only hive.json with a uuid and a 64-hex key", () => {
    const t = makeHive();
    t.hive.join();
    expect(statSync(t.path).mode & 0o777).toBe(0o600);
    const s = readState(t.path);
    expect(s.joined).toBe(true);
    expect(s.hiveId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(s.key).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof s.joinedAt).toBe("number");
  });

  it("leave sends DELETE with the id and key, then wipes them", async () => {
    const t = makeHive({ responses: [{ status: 200, body: { ok: true } }] });
    t.hive.join();
    const before = readState(t.path);
    const r = await t.hive.leave();
    expect(r.remote).toBe(true);
    expect(t.calls[0]).toMatchObject({ method: "DELETE", url: "https://hive.test/hive/report", body: { hiveId: before.hiveId, key: before.key } });
    const after = readState(t.path);
    expect(after.joined).toBe(false);
    expect(after.key).toBeUndefined();
    expect(after.hiveId).toBeUndefined();
    expect(t.hive.status().joined).toBe(false);
  });

  it("still wipes the key locally when the DELETE fails, and says so", async () => {
    const t = makeHive({ responses: [new Error("timeout")] });
    t.hive.join();
    const r = await t.hive.leave();
    expect(r.remote).toBe(false);
    expect(r.detail).toMatch(/Left on this server.*Could not reach/);
    expect(readState(t.path)).toMatchObject({ joined: false });
    expect(readFileSync(t.path, "utf8")).not.toMatch(/[0-9a-f]{64}/);
  });

  it("acts on the Setup answer once: a later leave is not undone by a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bees-hive-"));
    const setup = { hive: true, createdAt: Date.now() - 1000 };
    const a = makeHive({ dir, responses: [{ status: 200 }] });
    a.hive.start(setup);
    expect(a.hive.joined).toBe(true);
    await a.hive.leave();
    const b = makeHive({ dir });
    b.hive.start(setup);
    expect(b.hive.joined).toBe(false);
  });

  it("does nothing for Setup's 'Not now'", () => {
    const t = makeHive();
    t.hive.start({ hive: false, createdAt: Date.now() });
    expect(existsSync(t.path)).toBe(false);
  });
});

describe("owner password gate", () => {
  async function boot(mode: "dry" | "live" = "dry", hash?: string | null) {
    const t = makeHive({ mode, hash, responses: [{ status: 200, body: { ok: true } }] });
    const server = startServer({ hive: t.hive, profile: () => ({ setup: false }), beeImage: () => null }, 0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, pw = PASSWORD) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-owner-password": encodeURIComponent(pw) }, body: "{}" });
    return { ...t, base, post };
  }

  it("join and leave need the owner password; status never shows the id or key", async () => {
    const t = await boot();
    expect((await t.post("/hive/join", "wrong password")).status).toBe(401);
    expect((await t.post("/hive/join", "")).status).toBe(401);
    expect(existsSync(t.path)).toBe(false);
    expect((await t.post("/hive/join")).status).toBe(200);
    const s = readState(t.path);
    const status = await (await fetch(`${t.base}/hive/status`)).text();
    expect(JSON.parse(status)).toMatchObject({ joined: true, paper: true, board: "https://hive.test", passwordSet: true });
    expect(status).not.toContain(s.key as string);
    expect(status).not.toContain(s.hiveId as string);
    expect((await t.post("/hive/leave", "wrong password")).status).toBe(401);
    expect(readState(t.path).joined).toBe(true);
    expect((await t.post("/hive/leave")).status).toBe(200);
    expect(readState(t.path).joined).toBe(false);
  });

  it("accepts any characters in the password (sent URI-encoded)", async () => {
    const t = await boot("dry", hashPassword("bïène 🐝 zümmt"));
    expect((await t.post("/hive/join", "bïène 🐝 zümmt")).status).toBe(200);
  });

  it("locks after 8 wrong passwords, even for the right one", async () => {
    const t = await boot();
    for (let i = 0; i < 8; i++) expect((await t.post("/hive/join", "not the password")).status).toBe(401);
    expect((await t.post("/hive/join")).status).toBe(429);
    expect(existsSync(t.path)).toBe(false);
    expect(((await (await fetch(`${t.base}/hive/status`)).json()) as { locked: boolean }).locked).toBe(true);
  });

  it("with no owner password set, nothing can join or leave from the page", async () => {
    const t = await boot("dry", null);
    const r = await t.post("/hive/join");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/Run Setup again|OWNER_PASSWORD/);
    expect(existsSync(t.path)).toBe(false);
    expect(((await (await fetch(`${t.base}/hive/status`)).json()) as { passwordSet: boolean }).passwordSet).toBe(false);
  });

  it("refuses to join in MODE=live", async () => {
    const t = await boot("live");
    expect((await t.post("/hive/join")).status).toBe(409);
    expect(existsSync(t.path)).toBe(false);
  });

  it("does not expose /hive/report, and join/leave need POST", async () => {
    const t = await boot();
    expect((await t.post("/hive/report")).status).toBe(404);
    expect((await fetch(`${t.base}/hive/report`)).status).toBe(404);
    expect((await fetch(`${t.base}/hive/join`)).status).toBe(405);
  });
});

describe("hive portraits", () => {
  it("uploads each painted portrait the Hive does not hold, after the report, and only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bees-hive-"));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2048, 7), Buffer.from([0xff, 0xd9])]);
    writeFileSync(join(dir, "bee1.jpg"), jpeg);
    writeFileSync(join(dir, "bee3.jpg"), jpeg);
    const id = createHash("sha256").update(jpeg).digest("hex").slice(0, 24);
    const ok = (portraits: Record<string, string | null>) => ({ status: 200, body: { ok: true, verified: {}, nextReportInS: 300, portraits } });
    const t = makeHive({
      dir,
      // bee2 has no portrait file; bee3's is already held by the Hive.
      portrait: (slot) => (slot === "bee2" ? null : join(dir, `${slot}.jpg`)),
      responses: [ok({ bee1: null, bee2: null, bee3: id }), { status: 200, body: { ok: true, id } }, ok({ bee1: id, bee2: null, bee3: id })],
    });
    t.hive.join();
    expect(await t.hive.report()).toBe(300);
    expect(t.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://hive.test/hive/report", "PUT https://hive.test/hive/portrait"]);
    const put = t.calls[1]!.body!;
    expect(put.slot).toBe("bee1");
    expect(Buffer.from(String(put.jpeg), "base64").equals(jpeg)).toBe(true);
    expect(put.hiveId).toBe(readState(t.path).hiveId);

    await t.hive.report();
    expect(t.calls.length).toBe(3);
  });

  it("a refused portrait is not re-sent every report, and never stops reporting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bees-hive-"));
    writeFileSync(join(dir, "bee1.jpg"), Buffer.alloc(2048, 1));
    const ok = { status: 200, body: { ok: true, verified: {}, nextReportInS: 300, portraits: { bee1: null } } };
    const t = makeHive({ dir, portrait: (slot) => (slot === "bee1" ? join(dir, "bee1.jpg") : null), responses: [ok, { status: 422, body: { error: "portrait must be a JPEG" } }, ok] });
    t.hive.join();
    expect(await t.hive.report()).toBe(300);
    expect(await t.hive.report()).toBe(300);
    expect(t.calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST"]);
  });

  it("an older Hive that does not answer with portraits gets no uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bees-hive-"));
    writeFileSync(join(dir, "bee1.jpg"), Buffer.alloc(2048, 1));
    const t = makeHive({ dir, portrait: () => join(dir, "bee1.jpg") });
    t.hive.join();
    await t.hive.report();
    expect(t.calls.map((c) => c.method)).toEqual(["POST"]);
  });
});
