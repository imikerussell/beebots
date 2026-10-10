import type { Decision } from "./types.js";

export const DECISION_LIMIT = 200;
export const decisionKey = (d: Decision) => d.decisionId === undefined
  ? `${d.bee}:${d.ts}:${d.choice}:${d.status}` : `${d.bee}:${d.ts}:${d.decisionId}`;

export function isDecision(value: unknown): value is Decision & { type: "decision" } {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return d.type === "decision" && (d.bee === "tiger" || d.bee === "mochi")
    && typeof d.ts === "number" && Number.isFinite(d.ts) && typeof d.status === "string"
    && (d.choice === null || typeof d.choice === "string");
}

/** History and SSE can arrive in either order. Merge without dropping live rows. */
export function mergeDecisions(current: Decision[], incoming: Decision[]): Decision[] {
  const rows = new Map(current.map((d) => [decisionKey(d), d]));
  for (const d of incoming) rows.set(decisionKey(d), d);
  return [...rows.values()].sort((a, b) => b.ts - a.ts || (b.decisionId ?? 0) - (a.decisionId ?? 0)).slice(0, DECISION_LIMIT);
}
