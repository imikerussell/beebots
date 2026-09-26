// Mirrors the engine's read-only /snapshot and SSE payloads. No account data exists in these shapes.
import { BEE_MARK_URL } from "./BeeMark";

/** The three bee slots. Names, taglines and portraits come from the engine's /profile (set on the Setup page). */
export type BeeName = "bee1" | "bee2" | "bee3";
export const BEE_NAMES: BeeName[] = ["bee1", "bee2", "bee3"];

export type Cap = "trade_cap" | "fee_budget" | "loss_stop" | "retired" | null;

export interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
}

export interface PublicBee {
  bee: BeeName;
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  position: {
    coin: string;
    side: "long" | "short";
    sizeUsd: number | null;
    entryPx: number;
    markPx: number | null;
    stopPx: number | null;
    uplUsd: number;
    minutesHeld: number;
  } | null;
  flatMinutes: number | null;
  tradesToday: number;
  maxTradesPerDay: number;
  feesTodayUsd: number;
  feeBudgetUsd: number;
  cap: Cap;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number };
  maxNotionalUsd: number;
  last: LastDecision | null;
}

export interface Snapshot {
  ts: number;
  mode: "dry" | "demo" | "live";
  closed?: { at: number; flat: boolean } | null;
  startedAt: number;
  startEquityUsd: number;
  tickMs: number;
  bees: PublicBee[];
  leaderboard: Array<{ bee: BeeName; equityUsd: number }>;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; pnlUsd: number };
  jev: { spentTodayUsd: number; dailyCapUsd: number; capTripped: boolean; down: boolean };
  recon: { ok: boolean | null; detail: string; ts: number };
  market: { refreshedAt: number; universe: string[]; spreadBlocked: Array<{ coin: string; spreadBp: number }>; attention: "news" | "volume" };
  visitors?: { total: number; watching: number };
  /** Set when a newer GitHub Release exists than the version this install runs. */
  update?: { current: string; latest: string } | null;
}

export interface DecisionEvent {
  type: "decision";
  ts: number;
  bee: BeeName;
  choice: string | null;
  probabilities: Array<{ label: string; p: number }>;
  confidence: number | null;
  conviction: string | null;
  latencyMs: number | null;
  tokens: number | null;
  jevUsd: number;
  action: string;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  jev: string;
  /** A benched bee's live row: no Jev call, just its position P&L moving. */
  pulse?: boolean;
  /** Flat bee with nothing to ask Jev: what it is watching for (e.g. "SOL is 0.80% from breakout"). */
  watch?: string;
  /** The bee's money at this moment: open P&L while positioned, total P&L when flat, and the move since its last row. */
  live?: { coin: string | null; side: "long" | "short" | null; valueUsd: number; kind: "open" | "total"; deltaUsd: number };
}

export interface FillEvent {
  type: "fill";
  ts: number;
  bee: BeeName;
  coin: string;
  side: "buy" | "sell";
  purpose: string;
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
  label: string;
}

export interface CapEvent {
  type: "cap";
  ts: number;
  bee: BeeName;
  cap: Cap;
  detail: string;
}

export interface FundingEvent {
  type: "funding";
  ts: number;
  bee: BeeName;
  coin: string | null;
  amountUsd: number;
}

export type AnyEvent =
  | DecisionEvent
  | FillEvent
  | CapEvent
  | FundingEvent
  | { type: "equity"; ts: number; bees: PublicBee[] }
  | { type: "recon"; ts: number; ok: boolean; detail: string }
  | { type: "order" | "heartbeat" | "status"; ts: number; [k: string]: unknown };

export interface BeeMeta {
  /** Card title: "Boozy Bee" for the official three, the owner's own name for a Setup-made bee. */
  title: string;
  short: string;
  tagline: string;
  styleLabel: string;
  /** The owner's rules for this bee (Setup), "" for the original three. */
  rules: string;
  coins: string[];
  img: string;
  color: string;
  glow: string;
}

/** Colours belong to the slot, so two bees on the same style still look different. Filled in from /profile at load. */
export const BEE_META: Record<BeeName, BeeMeta> = {
  bee1: { title: "Bizzy Bee", short: "Bizzy", tagline: "the grinder", styleLabel: "Breakout", rules: "", coins: [], img: "/bees/bizzy.jpg", color: "var(--bizzy)", glow: "var(--bizzy-glow)" },
  bee2: { title: "Breezy Bee", short: "Breezy", tagline: "the calculated one", styleLabel: "Trend", rules: "", coins: [], img: "/bees/breezy.jpg", color: "var(--breezy)", glow: "var(--breezy-glow)" },
  bee3: { title: "Boozy Bee", short: "Boozy", tagline: "the degen", styleLabel: "Momentum", rules: "", coins: [], img: "/bees/boozy.jpg", color: "var(--boozy)", glow: "var(--boozy-glow)" },
};

export interface Profile {
  setup: boolean;
  mode: "dry" | "demo" | "live";
  links: { sponsor: string; code: string } | null;
  /** img null: a Setup-made bee without its portrait (the dashboard shows the placeholder mark). */
  bees: Array<{ id: BeeName; name: string; tagline: string; style: string; styleLabel: string; rules?: string; coins?: string[]; img: string | null }>;
}

export const PROFILE: { links: Profile["links"] } = { links: null };

const OFFICIAL_NAMES = ["Bizzy", "Breezy", "Boozy"];

export function applyProfile(p: Profile): void {
  PROFILE.links = p.links;
  for (const b of p.bees) {
    const m = BEE_META[b.id];
    if (!m) continue;
    m.short = b.name;
    m.title = OFFICIAL_NAMES.includes(b.name) ? `${b.name} Bee` : b.name;
    m.tagline = b.tagline;
    m.styleLabel = b.styleLabel;
    m.rules = b.rules ?? "";
    m.coins = b.coins ?? [];
    m.img = b.img ?? BEE_MARK_URL;
  }
}

/** Shown on Setup and in the dashboard's Hive dialog. */
export const HIVE_DISCLAIMER =
  "You're about to share your bees' names, styles and paper-trading results on the public leaderboard at beebots.tech. The board shows % gain/loss only. No keys, no exchange account details, no IP address. Paper trading only. Not financial advice. You can leave any time.";

/** The engine's GET /hive/status. No hive id, no key. */
export interface HiveStatus {
  joined: boolean;
  /** false in MODE=live: the Hive is paper only. */
  paper: boolean;
  /** The leaderboard's base URL (HIVE_URL). */
  board: string;
  lastReportAt: number | null;
  verified: Record<string, boolean> | null;
  problem: string | null;
  locked: boolean;
  /** false: no owner password on this server (join/leave impossible until one is set). */
  passwordSet: boolean;
}
