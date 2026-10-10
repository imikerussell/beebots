import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";
import { isDecision, mergeDecisions } from "../dashboard/src/decisionFeed.js";
import type { Decision } from "../dashboard/src/types.js";

const decision = (id: number, ts = id): Decision => ({ decisionId: id, ts, bee: "tiger", choice: "WAIT", status: "WAIT", error: null });
describe("decision stream recovery", () => {
  it("keeps live decisions when history arrives late and deduplicates reconnects", () => {
    const live = [decision(3), decision(2)];
    const history = [decision(1), decision(2)];
    expect(mergeDecisions(live, history).map(d => d.decisionId)).toEqual([3, 2, 1]);
    expect(mergeDecisions(mergeDecisions(live, history), history)).toHaveLength(3);
    expect(mergeDecisions([], [decision(2, 1), decision(1, 1)])).toHaveLength(2);
  });
  it("keeps the latest 200 and supports old events without IDs", () => {
    const rows = mergeDecisions([], Array.from({length: 250}, (_, i) => decision(i)));
    expect(rows).toHaveLength(200);
    expect(rows[0]?.decisionId).toBe(249);
    expect(rows[199]?.decisionId).toBe(50);
    const legacy = { ...decision(1), decisionId: undefined };
    expect(mergeDecisions([legacy], [legacy])).toHaveLength(1);
    expect(isDecision({ ...legacy, type: "decision" })).toBe(true);
    expect(isDecision({ ...legacy, type: "decision", bee: "unknown" })).toBe(false);
    expect(isDecision({ ...legacy, type: "equity" })).toBe(false);
  });
  it("streams decision events and backfills decisions even when other events dominate history", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const db = new Db(":memory:"), bus = new EventBus(db);
    const server = startServer({ profile: () => ({}), engine: {
      db, bus, visitors: new Visitors(db), snapshot: () => ({}), health: () => ({ok:true}),
    } }, 0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const controller = new AbortController();
    try {
      const response = await fetch(`${origin}/events`, {signal:controller.signal});
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      await reader.read(); // The initial retry directive flushes the connection.
      vi.advanceTimersByTime(15_000);
      const heartbeat = new TextDecoder().decode((await reader.read()).value);
      expect(JSON.parse(heartbeat.split("data: ")[1]!.trim())).toMatchObject({type:"heartbeat",ts:expect.any(Number)});
      const sent = bus.emit("decision", { ...decision(1), probabilities: {WAIT:0.75, LONG_BTC:0.25}, latencyMs:288, pnlUsd:0.92 });
      const chunk = new TextDecoder().decode((await reader.read()).value);
      expect(JSON.parse(chunk.split("data: ")[1]!.trim())).toEqual(sent);
      for (let i = 0; i < 5; i++) bus.emit("status", {status:"running"});
      const general = await (await fetch(`${origin}/history?n=2`)).json() as Array<{type:string}>;
      expect(general.every(e => e.type === "status")).toBe(true);
      const history = await (await fetch(`${origin}/history?n=2&type=decision`)).json();
      expect(history).toEqual([sent]);
      expect(mergeDecisions([sent as unknown as Decision], history as Decision[])).toHaveLength(1);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      vi.useRealTimers();
    }
  });
});
