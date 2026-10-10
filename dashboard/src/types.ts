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
    choice: string | null;
    status: string;
    vetoedBy: string | null;
    latencyMs: number | null;
    ts: number;
  } | null;
}
export interface Snapshot {
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
  ts: number;
  bee: CatId;
  choice: string | null;
  status: string;
  error: string | null;
}

export type CoachField = "minTrendScore" | "minActionProbability" | "minConviction";
export interface CoachEntry {
  id: number; cat: CatId; day: string; createdAt: number; expiresAt: number;
  status: "reviewing" | "pending" | "accepted" | "declined" | "no_change" | "failed" | "expired" | "rolled_back";
  model: string;
  review: { diagnosis: string; rationale: string; tradeoff: string;
    change: { field: CoachField; from: number; to: number } | null } | null;
  evidence: { summary: { decisions: number; waits: number; holds: number; modelFailures: number };
    blockers: Array<{ reason: string; decisions: number }> };
}
export interface CoachState {
  enabled: boolean; canReview: boolean; model: string; message: string; approvalMessage: string | null;
  cats: Array<{ cat: CatId; current: Record<CoachField, number>; baseline: Record<CoachField, number>; activeReviewId: number | null; nextReviewAt: number | null }>;
  entries: CoachEntry[];
}
