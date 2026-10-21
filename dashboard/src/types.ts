export type CatId = "tiger" | "mochi";
export interface Cat {
  bee: CatId;
  name: string;
  allocatedUsd: number;
  cashUsd: number;
  equityUsd: number;
  uplUsd: number;
  pnlUsd: number;
  pnlPct: number;
  maxDrawdownPct: number;
  exposureUsd: number;
  exposedMs: number;
  slippageUsd: number;
  tradesToday: number;
  entriesUsed?: number;
  maxTradesPerDay: number;
  totals: {
    feesUsd: number;
    fundingUsd: number;
    realisedUsd: number;
    decisions: number;
    orders: number;
  };
  position: {
    coin: string;
    side: string;
    entryPx: number;
    stopPx: number | null;
    contracts: number;
  } | null;
  cap: string | null;
  last: {
    decidedBy?: string | null;
    fallbackReason?: string | null;
    choice: string | null;
    status: string;
    vetoedBy: string | null;
    latencyMs: number | null;
    ts: number;
  } | null;
}
export interface Snapshot {
  strategyEngine?: "upstream" | "catfolio";
  ownerControlsEnabled?: boolean;
  ts: number;
  mode: "PAPER" | "DEMO" | "LIVE";
  cats: Cat[];
  totalStartEquityUsd: number;
  startedAt: number;
  decisionIntervalMs: number;
  protectiveIntervalMs: number;
  closed: { flat: boolean; at: number } | null;
  inference: {
    provider: string;
    estimatedSpentTodayUsd?: number;
    dailyUsdCap?: number;
    model: string;
    requests: number;
    failures: number;
    latencyMs: number | null;
    connected: boolean;
    error: string | null;
    lastRequestAt?: number | null;
    lastSuccessAt?: number | null;
    activeRequests?: number;
    queuedRequests?: number;
    retryAt?: number | null;
    reservedUsd?: number;
    budgetRefused?: boolean;
    lastFallback?: { reason: string; at: number } | null;
    minIntervalMs?: number;
    probabilityKind?: "self_reported";
  };
  market: { refreshedAt: number };
  coach?: CoachState;
}
export interface Profile {
  cats: Array<{
    id: CatId;
    name: string;
    tagline: string;
    rules: string;
    strategyFacts?: string[];
    coins: string[];
    img: string;
  }>;
}
export interface Decision {
  decisionId?: number;
  ts: number;
  bee: CatId;
  choice: string | null;
  status: string;
  error: string | null;
  latencyMs?: number | null;
  probabilities?: Record<string, number> | null;
  confidence?: number | null;
  source?: "model" | "rules" | "protection" | "code";
  decidedBy?: string | null;
  fallbackReason?: string | null;
  probabilityKind?: "self_reported" | "distribution";
  pnlUsd?: number;
  vetoedBy?: string | null;
  forcedBy?: string | null;
  entryDiagnostics?: EntryDiagnostic[];
  action?: { kind: string; instId?: string; side?: string; notionalUsd?: number; fraction?: number; reason?: string };
}

/** Optional measurements keep historical decision records readable. */
export interface EntryDiagnostic {
  coin: string;
  blockers: string[];
  indicatorsAgeMs?: number | null;
  maxIndicatorsAgeMs?: number | null;
  feedError?: string | null;
  feedErrorAt?: number | null;
  confirmedAt?: number | null;
  confirmedAgeMs?: number | null;
  maxConfirmedAgeMs?: number | null;
  entryMinutes?: number;
  trendMinutes?: number;
  trendScore?: number | null;
  minTrendScore?: number | null;
  momentumPct?: number | null;
  minMomentumPct?: number | null;
  macdHistPct?: number | null;
  signalSide?: "long" | "short" | null;
  atrPct?: number | null;
  momentumMinutes?: number;
  stopDistancePct?: number | null;
  roundTripCostPct?: number | null;
  minStopDistancePct?: number | null;
  minStopCostRatio?: number;
  signalMode?: string;
  regime?: "long" | "short" | null;
  entryHigh?: number | null;
  entryLow?: number | null;
  maxEntryChaseAtr?: number;
  spreadBps?: number | null;
  maxSpreadBps?: number | null;
  volumeUsd?: number | null;
  minVolumeUsd?: number | null;
  mid?: number | null;
  confirmedClose?: number | null;
  breakoutTrigger?: number | null;
  maxEntryPrice?: number | null;
  fundingPct?: number | null;
  maxFundingPct?: number | null;
  shortSlices?: number | null;
  trendSlices?: number | null;
  trendStopPx?: number | null;
  tradesToday?: number;
  entriesUsed?: number;
  maxTradesPerDay?: number;
}

export type CoachField = "minTrendScore" | "minActionProbability" | "minConviction";
export interface TrainerReview { parameterChanges?: Array<{field: string; from: number; to: number}>; idea: string; rules: string; coins: string; reason: string; quip: string; note: string }
export interface CoachRules { rules: string; coins: string[]; parameters?: Record<string, number> }
export interface CoachContext {
  diagnostics?: EntryDiagnostic[];
  account?: { pnlUsd: number; pnlPct: number; tradesToday: number; maxTradesPerDay: number; position: { coin: string; side: string } | null };
}
export interface CoachEntry {
  id: number; cat: CatId; day: string; createdAt: number; expiresAt: number;
  status: "reviewing" | "pending" | "advisory" | "accepted" | "declined" | "no_change" | "failed" | "expired" | "rolled_back";
  model: string;
  completedAt: number | null; resolvedAt: number | null; error: string | null;
  review: { diagnosis: string; rationale: string; tradeoff: string;
    change: { field: CoachField; from: number; to: number } | null } | TrainerReview | null;
  evidence: { current?: CoachContext; strategyVersions?: string[]; excludedObservations?: number; entries?: { count: number }; summary: { decisions: number; waitOnly?: number; waits: number; holds: number; modelFailures: number };
    blockers: Array<{ reason: string; decisions: number }> };
}
export interface CoachState {
  benched?: boolean;
  automatic?: boolean; autoApply?: boolean; reviewIntervalMs?: number; evidenceWindowMs?: number;
  enabled: boolean; canReview: boolean; model: string; message: string; approvalMessage: string | null;
  checkedAt: number | null; checkIntervalMs: number;
  cats: Array<{ cat: CatId; context?: CoachContext; current: CoachRules | Record<CoachField, number>; baseline: CoachRules | Record<CoachField, number>; activeReviewId: number | null; nextReviewAt: number | null;
    phase: "paused" | "reviewing" | "awaiting_approval" | "scheduled" | "queued" | "gathering";
    observations: number; requiredObservations: number; observedMinutes: number; requiredMinutes: number;
    lastReviewAt: number | null; reviewCount: number; acceptedCount: number;
  }>;
  entries: CoachEntry[];
}
