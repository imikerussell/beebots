import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";

it("shares equity reads across visitors, separates ranges, and refreshes after a minute", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const db = new Db(":memory:");
  db.insertEquity("tiger", now - 2 * 86_400_000, 100, 100, 0);
  db.insertEquity("tiger", now - 60_000, 110, 110, 0);
  const reads = vi.spyOn(db, "equitySeries");
  const server = startServer({ profile: () => ({}), engine: {
    db, bus: new EventBus(db), visitors: new Visitors(db),
    snapshot: () => ({}), health: () => ({ ok: true }),
  } }, 0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const response = await fetch(`${origin}${path}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ tiger: Array<[number, number]> }>;
  };
  try {
    const initial = await get("/equity");
    expect(initial.tiger).toHaveLength(2);
    db.insertEquity("tiger", now, 120, 120, 0);
    now += 59_999;
    const visitors = await Promise.all([
      get("/equity?days=30"), get("/equity?days=30.0"), get("/equity"),
    ]);
    expect(visitors).toEqual([initial, initial, initial]);
    expect(reads).toHaveBeenCalledTimes(1);
    const daily = await get("/equity?days=1");
    expect(daily.tiger.map((point) => point[1])).toEqual([110, 120]);
    expect(reads).toHaveBeenCalledTimes(2);
    now += 1;
    const updated = await get("/equity?days=30");
    expect(updated.tiger.at(-1)?.[1]).toBe(120);
    expect(updated).not.toEqual(initial);
    expect(reads).toHaveBeenCalledTimes(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    clock.mockRestore();
  }
});
