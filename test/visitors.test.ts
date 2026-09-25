import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { clientAddr, Visitors } from "../src/visitors.js";

describe("visitor counter", () => {
  it("counts a visitor once per UTC day, and again the next day", () => {
    let now = Date.UTC(2026, 8, 24, 10);
    const db = new Db(":memory:");
    const v = new Visitors(db, () => now);
    expect(v.visit("a")).toBe(1);
    expect(v.visit("a")).toBe(1);
    expect(v.visit("b")).toBe(2);
    now = Date.UTC(2026, 8, 25, 1);
    expect(v.visit("a")).toBe(3);
  });

  it("persists only the total, never an address or a hash", () => {
    const db = new Db(":memory:");
    new Visitors(db).visit("203.0.113.9");
    const meta = db.raw.prepare("SELECT k, v FROM meta").all() as Array<{ k: string; v: string }>;
    expect(meta).toEqual([{ k: "visitors_total", v: "1" }]);
    expect(new Visitors(db).total).toBe(1);
  });

  it("uses the first X-Forwarded-For hop from Caddy", () => {
    expect(clientAddr("198.51.100.7, 172.18.0.3", "172.18.0.3")).toBe("198.51.100.7");
    expect(clientAddr(undefined, "172.18.0.3")).toBe("172.18.0.3");
  });
});
