// Dry end-to-end harness with a FAKE Jev (random picks). No keys, no Jev spend. Not part of the vitest suite.
// pnpm e2e:fake-jev   (E2E_SECONDS=40 to stop after 40 s; dashboard stream on localhost:18080)
import { Alerts } from "../src/alerts.js";
import { BREEZY_COINS } from "../src/bees/breezy.js";
import { BEES, loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { MarketFeed } from "../src/market/data.js";
import { createOkxCli } from "../src/okx/cli.js";
import { createPublicApi } from "../src/okx/public.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";

const fakeJev: SystemOne = {
  async systemOne(req) {
    const labels = Object.keys((req.questions.action as { criteria: object }).criteria);
    const w = labels.map(() => Math.random());
    const sum = w.reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(labels.map((l, i) => [l, w[i]! / sum]));
    const choice = labels[w.indexOf(Math.max(...w))]!;
    await new Promise((r) => setTimeout(r, 50));
    return { model: "fake", usage: { input_tokens: 600, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: probabilities[choice], probabilities }, conviction: { type: "score", score: Math.random() * 3, confidence: 0.5, legend: {}, probabilities: {} } } } as never;
  },
};

const cfg = loadConfig({ TYPESAFE_API_KEY: "fake", DRY_RUN: "true", TICK_MS: "2000", DB_PATH: process.env.E2E_DB ?? "./data/e2e-fake-jev.sqlite", ENGINE_PORT: "18080", LOG_LEVEL: "warn" });
const db = new Db(cfg.dbPath);
const bus = new EventBus(db);
const cli = createOkxCli({ site: "eea", timeoutMs: 15_000 });
const feed = new MarketFeed(createPublicApi(cli, cfg.okx.apiBase), { min24hVolUsd: cfg.universe.min24hVolUsd, allowNonCrypto: false, spreadGateBps: 15, trendCoins: [...BREEZY_COINS] }, null, () => BEES.map((b) => engine.bees[b]?.position?.instId).filter((x): x is string => !!x));
const exec = new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate);
const jev = new Jev({ ...cfg.jev, client: fakeJev });
const engine: Engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined) });
await engine.start();
const server = startServer({ engine: { bus, db, visitors: new Visitors(db), snapshot: () => engine.snapshot(), health: () => engine.health() }, profile: () => ({ bees: [] }), beeImage: () => null }, cfg.server.port, cfg.server.bind);
if (process.env.E2E_SECONDS) setTimeout(() => { engine.stop(); server.close(); db.close(); process.exit(0); }, Number(process.env.E2E_SECONDS) * 1000);
