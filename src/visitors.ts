// Visitor counter for the public page. Privacy by construction:
// an IP is only ever hashed with a random salt that lives in memory for one UTC day, then is discarded,
// so nothing stored (or logged) can be linked back to a person or across days. Only the total persists.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

const MAX_SEEN = 200_000;

export class Visitors {
  private day = "";
  private salt = Buffer.alloc(0);
  private seen = new Set<string>();
  total: number;

  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {
    this.total = Number(db.getMeta("visitors_total") ?? 0);
  }

  /** Count one visit; the same visitor counts once per UTC day. Returns the running total. */
  visit(clientAddr: string): number {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.salt = randomBytes(32);
      this.seen.clear();
    }
    const h = createHash("sha256").update(this.salt).update(clientAddr).digest("base64url").slice(0, 16);
    if (!this.seen.has(h) && this.seen.size < MAX_SEEN) {
      this.seen.add(h);
      this.total++;
      this.db.setMeta("visitors_total", String(this.total));
    }
    return this.total;
  }
}

/** The visitor's address as Caddy reports it (first X-Forwarded-For hop), else the socket address. Never logged. */
export function clientAddr(xff: string | string[] | undefined, socketAddr: string | undefined): string {
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || socketAddr || "unknown";
}
