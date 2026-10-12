import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";

it("keeps Docker liveness separate from readiness and exposes stalled-loop reasons", async () => {
  const db = new Db(":memory:");
  let health = { ok: false, live: true, reasons: ["market_data_stale"] };
  const server = startServer({ profile: () => ({}), engine: {
    db, bus: new EventBus(db), visitors: new Visitors(db),
    snapshot: () => ({}), health: () => health,
  } }, 0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const readiness = await fetch(`${origin}/health`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual(health);
    const live = await fetch(`${origin}/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, ready: false, reasons: ["market_data_stale"] });
    health = { ok: false, live: false, reasons: ["decision_loop_stalled"] };
    const stalled = await fetch(`${origin}/live`);
    expect(stalled.status).toBe(503);
    expect(await stalled.json()).toMatchObject({ ok: false, reasons: ["decision_loop_stalled"] });
    health = { ok: true, live: true, reasons: [] };
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect((await fetch(`${origin}/live`)).status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});
