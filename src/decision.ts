import type { Menu } from "./bees/types.js";
export const STRATEGY_VERSION = "catfolio-2-breezy-bizzy";
export const RUBRIC_VERSION = "signal-strength-1";
export const CONVICTION = [
  "0: No confirmed setup; insufficient or conflicting evidence",
  "1: Weak setup; some confirmation but material conflicts",
  "2: Strong setup; trend, momentum and liquidity agree",
  "3: Very strong setup; broad confirmation with few conflicts",
] as const;
export interface DecisionAsk {
  strategy: string;
  state: Record<string, unknown>;
  menu: Menu;
  convictionLabels: readonly string[];
}
export interface DecisionAnswer {
  ok: true;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  conviction: number;
  convictionRaw: number;
  scoreProbabilities: Record<string, number>;
  scoreConfidence: number;
  /** Estimated hosted API cost, separate from trading capital. */
  costUsd?: number;
  metadata?: Record<string, unknown>;
  inputTokens: number;
  latencyMs: number;
  model: string;
  source: "model" | "rules";
}
export interface DecisionFailure {
  costUsd?: number;
  ok: false;
  reason: string;
  error?: { code: string; message: string };
  latencyMs: number;
}
export type DecisionResult = DecisionAnswer | DecisionFailure;
export interface DecisionProvider {
  decide(ask: DecisionAsk): Promise<DecisionResult>;
  status(): {
    provider: string;
    estimatedSpentTodayUsd?: number;
    dailyUsdCap?: number;
    model: string;
    requests: number;
    failures: number;
    latencyMs: number | null;
    connected: boolean;
    error: string | null;
  };
  close?(): void;
}
