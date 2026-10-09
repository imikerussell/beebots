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
