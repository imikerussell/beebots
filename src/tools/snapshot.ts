// Current two-cat menus and numeric snapshots from read-only public market data.
import { catBrain } from "../cats.js";
import { BEES, loadConfig } from "../config.js";
import { freshBee } from "../ledger.js";
import { MarketFeed } from "../market/data.js";
import { createPublicApi } from "../okx/public.js";
import { buildSnapshot } from "../snapshot.js";
const cfg = loadConfig({ ...process.env, DRY_RUN: "true" });
const feed = new MarketFeed(
  createPublicApi(cfg.okx.apiBase),
  {
    ...cfg.universe,
    spreadGateBps: Math.max(
      cfg.cats.tiger.spreadGateBps,
      cfg.cats.mochi.spreadGateBps,
    ),
    trendCoins: ["BTC", "ETH"],
    allowedCoins: ["BTC", "ETH", "SOL", "HYPE"],
  },
  null,
  () => [],
);
await feed.refresh();
for (const id of BEES) {
  const brain = catBrain(id, cfg),
    bee = freshBee(id, cfg.cats[id].startEquityUsd, Date.now());
  const ctx = {
    bee,
    view: feed.view(),
    cfg,
    knobs: cfg.cats[id],
    now: Date.now(),
    uplR: null,
  };
  console.log(
    JSON.stringify(
      { cat: id, menu: brain.menu(ctx), snapshot: buildSnapshot(brain, ctx) },
      null,
      2,
    ),
  );
}
