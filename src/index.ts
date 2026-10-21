import { strategyFacts } from "./cats.js";
import { strategyVersion } from "./decision.js";
import { existsSync } from "node:fs";
import { Alerts } from "./alerts.js";
import { BEES, loadConfig } from "./config.js";
import { Db } from "./db.js";
import { CatfolioEngine as Engine } from "./catfolio-engine.js";
import { EventBus } from "./events.js";
import { OkxExecutor, SimExecutor } from "./exec/executor.js";
import { createDecisionProvider, decisionConfiguration } from "./providers.js";
import { log, setLogLevel } from "./log.js";
import { MarketFeed } from "./market/data.js";
import { createOkxCli } from "./okx/cli.js";
import { createPublicApi } from "./okx/public.js";
import { createOkxPublicRest } from "./okx/rest.js";
import { startServer } from "./server.js";
import { loadSettings } from "./settings.js";
import { Visitors } from "./visitors.js";
import { lockRun } from "./run-lock.js";
import { morningReport } from "./report.js";

async function main() {
  const cfg = loadConfig(
    process.env,
    loadSettings(
      process.env.SETTINGS_PATH?.trim() || "./data/catfolio-settings.json",
    ),
  );
  setLogLevel(cfg.logLevel);
  for (const message of cfg.configurationWarnings) log.warn(message);
  const unlock = lockRun(cfg.dbPath);
  process.on("exit", unlock);
  const db = new Db(cfg.dbPath),
    bus = new EventBus(db),
    provider = createDecisionProvider(cfg, db);
  const api = createPublicApi(
    cfg.okx.apiBase,
    cfg.mode === "demo",
    createOkxPublicRest({
      apiBase: cfg.okx.apiBase,
      timeoutMs: cfg.okx.cliTimeoutMs,
    }),
  );
  const feed = new MarketFeed(
    api,
    {
      ...cfg.universe,
      spreadGateBps: Math.max(
        cfg.cats.tiger.spreadGateBps,
        cfg.cats.mochi.spreadGateBps,
      ),
      trendCoins: ["BTC", "ETH"],
      trendBreakoutOptions: cfg.strategies.tiger,
      allowedCoins: [...new Set(BEES.flatMap(id => cfg.slots[id].coins))],
    },
    null,
    () =>
      engine
        ? BEES.flatMap((id) =>
            engine.bees[id]?.position ? [engine.bees[id].position!.instId] : [],
          )
        : [],
  );
  // Paper never instantiates a signed client or reads exchange credentials.
  const exec =
    cfg.mode === "dry"
      ? new SimExecutor(
          () => feed.view(),
          cfg.risk.takerFeeRate,
          Date.now,
          cfg.paperSlippageBps,
          cfg.maxTickerAgeMs,
        )
      : new OkxExecutor(
          createOkxCli({ site: cfg.okx.site, timeoutMs: cfg.okx.cliTimeoutMs }),
          cfg.creds,
          cfg.mode === "demo",
          (id) => feed.view().instruments.get(id),
          cfg.risk.maxLeverage,
        );
  const engine: Engine = new Engine({
    cfg,
    db,
    feed,
    provider,
    exec,
    bus,
    alerts: new Alerts(undefined),
    closeRequested: () => existsSync(`${cfg.dbPath}.stop`),
  });
  await engine.start();
  const server = startServer(
    {
      engine: {
        bus,
        db,
        coach: engine.coach,
        coachAdminToken: cfg.coach.adminToken,
        resetEntryLimit: id => engine.resetEntryLimit(id),
        visitors: new Visitors(db),
        snapshot: () => engine.snapshot(),
        health: () => engine.health(),
        report: () => morningReport(db, engine.snapshot()),
      },
      profile: () => ({
        product: "Catfolio",
        strategyVersion: strategyVersion(cfg),
        cats: BEES.map((id) => ({
          id,
          ...cfg.slots[id],
          img: `/cats/wall-e-${id === "tiger" ? "dark" : "good"}.png`,
          limits: cfg.cats[id],
          exits: cfg.exits[id],
          strategyFacts: strategyFacts(id, cfg),
        })),
      }),
    },
    cfg.server.port,
    cfg.server.bind,
  );
  log.info("Catfolio started", {
    mode: cfg.mode === "dry" ? "PAPER" : cfg.mode.toUpperCase(),
    provider: cfg.decisionProvider,
    model: decisionConfiguration(cfg).model || "not configured",
    decisionsMs: cfg.tickMs,
    protectiveMs: Math.min(cfg.tickMs, 2000),
  });
  let stopping = false;
  // Docker's restart policy does not restart an unhealthy but still running
  // process. Exit only for stalled loops, never for a recoverable API outage.
  const watchdog = setInterval(() => {
    const health = engine.health();
    if (!health.live) {
      log.error("engine loop stalled; exiting for supervisor restart", { health });
      process.exit(1);
    }
  }, 10_000);
  watchdog.unref();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(watchdog);
    server.close();
    await engine.stop();
    db.close();
    unlock();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
main().catch((err) => {
  log.error("Catfolio refused to start", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
