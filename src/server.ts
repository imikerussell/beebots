// Read-only HTTP: GET /events (SSE), /snapshot, /history?n=, /equity?days=, /visit, /health, /profile, /bee-image/<bee>.
// Never config or keys. The exceptions: /setup/*, which only exists before first-run Setup is done (setup.ts), and
// POST /hive/join and /hive/leave, which need the owner password (gate.ts, hive.ts). GET /hive/status is public and holds no key.
// /visit is the page's hit counter: it bumps a total and returns it (see visitors.ts; no IP is stored or logged).
import { createReadStream } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { Hive } from "./hive.js";
import { log } from "./log.js";
import { redact } from "./redact.js";
import type { Setup } from "./setup.js";
import { clientAddr, type Visitors } from "./visitors.js";

export interface ServerDeps {
  /** Absent in setup mode (nothing is trading yet). */
  engine?: {
    bus: EventBus;
    db: Db;
    snapshot: () => unknown;
    health: () => { ok: boolean; [k: string]: unknown };
    visitors: Visitors;
    /** "Update available" (update.ts): null unless a newer GitHub Release exists. */
    update?: () => unknown;
  };
  /** Present only in setup mode. */
  setup?: Setup;
  /** Present once trading: join/leave the Hive (owner password) and its public status. */
  hive?: Hive;
  /** Names, styles and portraits of the bees, for the dashboard. No secrets. */
  profile: () => unknown;
  /** File path of a bee's generated portrait, or null. */
  beeImage: (bee: string) => string | null;
}

const MAX_BUFFERED = 1024 * 1024;
// Load limits for a public page: live streams are capped in total and per visitor, and /history is capped and
// served from a 2 s cache so a crowd (or a script) hitting it costs one DB read per 2 s, not one per request.
const MAX_STREAMS = 2000;
const MAX_STREAMS_PER_ADDR = 10;
const MAX_HISTORY = 1000;
const HISTORY_CACHE_MS = 2000;

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(redact(body));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(s);
}

export function startServer(deps: ServerDeps, port: number, bind: string): Server {
  const streams = new Map<string, number>();
  let streamsTotal = 0;
  const historyCache = new Map<number, { at: number; body: string }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (deps.setup && url.pathname.startsWith("/setup/")) {
      void deps.setup.handle(req, res, url.pathname).catch(() => json(res, 500, { error: "setup failed" }));
      return;
    }
    if (deps.hive && url.pathname.startsWith("/hive/")) {
      void deps.hive
        .handle(req, res, url.pathname)
        .then((handled) => {
          if (!handled) json(res, 404, { error: "not found" });
        })
        .catch(() => json(res, 500, { error: "hive request failed" }));
      return;
    }
    if (req.method !== "GET") return json(res, 405, { error: "read-only" });
    if (url.pathname === "/setup/status") return json(res, 200, { needed: false });

    if (url.pathname === "/profile") return json(res, 200, deps.profile());
    if (url.pathname.startsWith("/bee-image/")) {
      const file = deps.beeImage(url.pathname.slice("/bee-image/".length));
      if (!file) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=300" });
      createReadStream(file).pipe(res);
      return;
    }
    const e = deps.engine;
    if (!e) {
      // Setup mode: healthy (so Docker leaves it alone), and nothing else to read yet.
      if (url.pathname === "/health") return json(res, 200, { ok: true, setup: true });
      return json(res, 503, { error: "setup needed", setup: true });
    }

    switch (url.pathname) {
      case "/health": {
        const h = e.health();
        return json(res, h.ok ? 200 : 503, h);
      }
      case "/snapshot":
        return json(res, 200, { ...(e.snapshot() as object), visitors: { total: e.visitors.total, watching: e.bus.subscribers }, update: e.update?.() ?? null });
      case "/visit": {
        const total = e.visitors.visit(clientAddr(req.headers["x-forwarded-for"], req.socket.remoteAddress));
        return json(res, 200, { total, watching: e.bus.subscribers });
      }
      case "/equity": {
        const days = Math.max(0.01, Math.min(60, Number(url.searchParams.get("days") ?? 30) || 30));
        return json(res, 200, e.db.equitySeries(Date.now() - days * 86_400_000, 720));
      }
      case "/history": {
        const n = Math.max(1, Math.min(MAX_HISTORY, Number(url.searchParams.get("n") ?? MAX_HISTORY) || MAX_HISTORY));
        const now = Date.now();
        let hit = historyCache.get(n);
        if (!hit || now - hit.at > HISTORY_CACHE_MS) {
          if (historyCache.size > 50) historyCache.clear();
          hit = { at: now, body: `[${e.db.recentEvents(n).join(",")}]` };
          historyCache.set(n, hit);
        }
        const body = hit.body;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        return res.end(body);
      }
      case "/events": {
        const addr = clientAddr(req.headers["x-forwarded-for"], req.socket.remoteAddress);
        const mine = streams.get(addr) ?? 0;
        if (streamsTotal >= MAX_STREAMS || mine >= MAX_STREAMS_PER_ADDR) return json(res, 503, { error: "too many live connections" });
        streams.set(addr, mine + 1);
        streamsTotal++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          streamsTotal--;
          const left = (streams.get(addr) ?? 1) - 1;
          if (left > 0) streams.set(addr, left);
          else streams.delete(addr);
        };
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*",
        });
        res.write("retry: 2000\n\n");
        const unsub = e.bus.subscribe((line) => {
          // Drop slow clients instead of buffering without bound.
          if (res.writableLength > MAX_BUFFERED) {
            unsub();
            res.destroy();
            return;
          }
          res.write(`data: ${line}\n\n`);
        });
        req.on("close", () => {
          unsub();
          release();
        });
        return;
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  });
  server.listen(port, bind, () => log.info("engine http listening", { port }));
  return server;
}
