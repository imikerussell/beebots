import { timingSafeEqual } from "node:crypto";
import { CoachConflict, type CatCoach } from "./coach.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import { log } from "./log.js";
import { redact } from "./redact.js";
import { clientAddr, type Visitors } from "./visitors.js";

export interface ServerDeps {
  /** Absent in setup mode (nothing is trading yet). */
  engine?: {
    bus: EventBus;
    db: Db;
    snapshot: () => unknown;
    health: () => { ok: boolean; [k: string]: unknown };
    visitors: Visitors;
    report?: () => unknown;
    coach?: CatCoach;
    coachAdminToken?: string;
  };
  profile: () => unknown;
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
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(s);
}

export function startServer(
  deps: ServerDeps,
  port: number,
  bind: string,
): Server {
  const streams = new Map<string, number>();
  let streamsTotal = 0;
  const historyCache = new Map<string, { at: number; body: string }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/coach")) {
      void coachRequest(req, res, url.pathname, deps.engine).catch(() => {
        if (!res.headersSent) json(res, 500, { error: "Coach request failed." });
      });
      return;
    }
    if (req.method !== "GET") return json(res, 405, { error: "read-only" });
    if (url.pathname === "/profile") return json(res, 200, deps.profile());
    const e = deps.engine;
    if (!e) {
      // Setup mode: healthy (so Docker leaves it alone), and nothing else to read yet.
      if (url.pathname === "/health")
        return json(res, 200, { ok: true, setup: true });
      return json(res, 503, { error: "setup needed", setup: true });
    }

    switch (url.pathname) {
      case "/health": {
        const h = e.health();
        return json(res, h.ok ? 200 : 503, h);
      }
      case "/report":
        return json(res, 200, e.report?.() ?? { error: "no report" });
      case "/snapshot":
        return json(res, 200, {
          ...(e.snapshot() as object),
          visitors: { total: e.visitors.total, watching: e.bus.subscribers },
        });
      case "/visit": {
        const total = e.visitors.visit(
          clientAddr(req.headers["x-forwarded-for"], req.socket.remoteAddress),
        );
        return json(res, 200, { total, watching: e.bus.subscribers });
      }
      case "/equity": {
        const days = Math.max(
          0.01,
          Math.min(60, Number(url.searchParams.get("days") ?? 30) || 30),
        );
        return json(
          res,
          200,
          e.db.equitySeries(Date.now() - days * 86_400_000, 720),
        );
      }
      case "/history": {
        const n = Math.max(
          1,
          Math.min(
            MAX_HISTORY,
            Number(url.searchParams.get("n") ?? MAX_HISTORY) || MAX_HISTORY,
          ),
        );
        const now = Date.now();
        const type = url.searchParams.get("type") === "decision" ? "decision" : undefined;
        const cacheKey = `${type ?? "all"}:${n}`;
        let hit = historyCache.get(cacheKey);
        if (!hit || now - hit.at > HISTORY_CACHE_MS) {
          if (historyCache.size > 50) historyCache.clear();
          hit = { at: now, body: `[${e.db.recentEvents(n, type).join(",")}]` };
          historyCache.set(cacheKey, hit);
        }
        const body = hit.body;
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        return res.end(body);
      }
      case "/events": {
        const addr = clientAddr(
          req.headers["x-forwarded-for"],
          req.socket.remoteAddress,
        );
        const mine = streams.get(addr) ?? 0;
        if (streamsTotal >= MAX_STREAMS || mine >= MAX_STREAMS_PER_ADDR)
          return json(res, 503, { error: "too many live connections" });
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
        // Keep idle streams alive through reverse proxies, even while cats wait.
        const heartbeat = setInterval(() => {
          if (res.writableLength > MAX_BUFFERED) res.destroy();
          else res.write(`data: ${JSON.stringify({ type: "heartbeat", ts: Date.now() })}\n\n`);
        }, 15_000);
        heartbeat.unref();
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
          clearInterval(heartbeat);
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

async function coachRequest(req: IncomingMessage, res: ServerResponse, path: string, engine: ServerDeps["engine"]) {
  if (!engine?.coach) return json(res, 503, { error: "Coach unavailable." });
  if (req.method === "GET" && path === "/coach") return json(res, 200, engine.coach.state());
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
  const expected = engine.coachAdminToken;
  if (!expected) return json(res, 503, { error: "Set COACH_ADMIN_TOKEN on the engine to enable approval." });
  const provided = req.headers.authorization ?? "";
  const wanted = `Bearer ${expected}`;
  // A bearer header + JSON body prevents ambient-cookie CSRF. Cross-origin preflight is not allowed.
  const suppliedBytes = Buffer.from(provided), expectedBytes = Buffer.from(wanted);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes))
    return json(res, 401, { error: "Enter the engine's owner key to review suggestions." });
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") return json(res, 415, { error: "JSON required." });
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 1024) return json(res, 413, { error: "Request too large." });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "Invalid JSON." }); }
  // Validate the key without changing a review or applying any strategy setting.
  if (path === "/coach/unlock" && body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)
    return json(res, 200, { ok: true });
  if (!body || typeof body !== "object" || Object.keys(body).length !== 1) return json(res, 400, { error: "Invalid request." });
  try {
    if (path === "/coach/reset" && "cat" in body && (body.cat === "tiger" || body.cat === "mochi"))
      return json(res, 200, engine.coach.reset(body.cat));
    if ((path === "/coach/accept" || path === "/coach/decline") && "id" in body && typeof body.id === "number" && Number.isSafeInteger(body.id) && body.id > 0)
      return json(res, 200, engine.coach.resolve(body.id, path === "/coach/accept" ? "accept" : "decline"));
    return json(res, 400, { error: "Invalid review action." });
  } catch (err) {
    if (err instanceof CoachConflict) return json(res, 409, { error: err.message });
    throw err;
  }
}
