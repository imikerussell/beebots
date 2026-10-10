// Structural ports let the original engine use Catfolio's provider and audit integrations.
// These adapters do not choose actions, schedule trading or change strategy parameters.
import type { Db } from "./db.js";
import type { DecisionAsk, DecisionAnswer, DecisionFailure } from "./decision.js";

export type EngineAnswer = Omit<DecisionAnswer, "source" | "scoreProbabilities" | "scoreConfidence" | "costUsd"> & {costUsd: number};
export type EngineResult = EngineAnswer | DecisionFailure;
export interface EngineJev {
  readonly capTripped: boolean;
  readonly downSince: number | null;
  readonly spentTodayUsd: number;
  decide(ask: DecisionAsk): Promise<EngineResult>;
}
export interface EngineOverlay { id: number; rules: string; coins: string[] }
export type EngineStore = Pick<Db, "raw" | "getMeta" | "setMeta" | "loadBee" | "saveBee" | "insertDecision" | "insertOrder" | "updateOrder" | "insertFill" | "insertFunding" | "insertEquity" | "insertRecon" | "insertCap" | "pruneEvents">;
