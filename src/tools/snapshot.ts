// Phase 3 check: build each bee's menu and snapshot from live public data. No Jev call, no keys, no spend.
// pnpm snapshot
import { BREEZY_COINS } from "../bees/breezy.js";
import { BRAINS } from "../bees/index.js";
import { loadConfig, STYLES as BEES, type BeeId } from "../config.js";
import { freshBee } from "../ledger.js";
import { MarketFeed } from "../market/data.js";
import { createPublicApi } from "../okx/public.js";
import { buildSnapshot } from "../snapshot.js";

const cfg = loadConfig({ ...process.env, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY || "unused", DRY_RUN: "true" });
const feed = new MarketFeed(
  createPublicApi(cfg.okx.apiBase),
  { min24hVolUsd: cfg.universe.min24hVolUsd, allowNonCrypto: false, spreadGateBps: Math.max(...BEES.map((b) => cfg.bees[b].spreadGateBps)), trendCoins: [...BREEZY_COINS] },
  null,
  () => [],
);

const t0 = Date.now();
await feed.refresh();
console.log(`market refresh: ${Date.now() - t0} ms, ${feed.view().stats.size} coins with stats`);

for (const id of BEES) {
  const brain = BRAINS[id];
  const bee = freshBee(id as unknown as BeeId, cfg.risk.startEquityUsd, Date.now() - 60_000);
  const ctx = { bee, view: feed.view(), cfg, knobs: cfg.bees[id], now: Date.now(), uplR: null };
  const snap = buildSnapshot(brain, ctx);
  const menu = brain.menu(ctx);
  console.log(`\n=== ${id}: ~${snap.approxTokens} tokens (chars/3), menu: ${Object.keys(menu).join(", ") || "(empty)"}`);
  console.log(JSON.stringify(snap.state));
}
