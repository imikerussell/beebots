// Per-bee numeric snapshot for Jev. Numbers only, columnar, target < 400 input tokens.
import { createHash } from "node:crypto";
import { beeLine } from "./bees/common.js";
import type { BeeBrain, BeeContext } from "./bees/types.js";

export interface Snapshot {
  state: Record<string, unknown>;
  /** First 16 hex chars of sha256(state). */
  hash: string;
  /** Rough size guard; the real number comes back as usage.input_tokens. */
  approxTokens: number;
}

export function buildSnapshot(brain: BeeBrain, ctx: BeeContext): Snapshot {
  const ids = brain.snapshotCoins(ctx);
  let cols: string[] = [];
  const rows: Record<string, Array<number | string | null>> = {};
  for (const id of ids) {
    const s = ctx.view.stats.get(id);
    if (!s) continue;
    const snap = brain.coinSnapshot(s, ctx);
    if (!cols.length) cols = Object.keys(snap);
    rows[s.coin] = cols.map((c) => snap[c] ?? null);
  }
  const d = new Date(ctx.now);
  const state: Record<string, unknown> = {
    utc: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    me: beeLine(ctx),
    coins: { cols, rows },
  };
  if (brain.id === "boozy") state.attn = ctx.view.newsAvailable ? "news_z" : "volume_z";
  const json = JSON.stringify(state);
  return {
    state,
    hash: createHash("sha256").update(json).digest("hex").slice(0, 16),
    approxTokens: Math.ceil(json.length / 3),
  };
}
