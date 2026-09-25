import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Alerts } from "./alerts.js";
import { BREEZY_COINS } from "./bees/breezy.js";
import { BEES, ConfigError, loadConfig, STYLES, type Config } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { EventBus } from "./events.js";
import { hashPassword, MIN_PASSWORD } from "./gate.js";
import { Hive, hivePath } from "./hive.js";
import { OkxExecutor, SimExecutor, type Executor } from "./exec/executor.js";
import { Jev } from "./jev.js";
import { log, setLogLevel } from "./log.js";
import { MarketFeed } from "./market/data.js";
import { createOkxCli } from "./okx/cli.js";
import { createNewsSource } from "./okx/news.js";
import { createPublicApi } from "./okx/public.js";
import { safeError } from "./redact.js";
import { startServer } from "./server.js";
import { loadSettings, STYLE_INFO } from "./settings.js";
import { imagePath, Setup } from "./setup.js";
import { UpdateCheck } from "./update.js";
import { Visitors } from "./visitors.js";

const SETTINGS_PATH = process.env.SETTINGS_PATH?.trim() || "./data/settings.json";
// Reference portraits for generated bees: the dashboard's default art (copied into the image by the Dockerfile).
const REF_DIR = process.env.REF_DIR?.trim() || "./dashboard/public/bees";

/** Names, rules, styles and pictures for the dashboard. */
function profile(cfg: Config | null) {
  return {
    setup: cfg === null,
    mode: cfg?.mode ?? "dry",
    links: cfg?.links ?? null,
    bees: cfg
      ? BEES.map((id) => {
          const s = cfg.slots[id];
          return {
            id,
            name: s.name,
            tagline: s.tagline,
            style: s.style,
            styleLabel: STYLE_INFO[s.style].label,
            rules: s.rules,
            coins: s.coins,
            // A Setup-made bee only ever shows its own portrait (null = the dashboard's placeholder mark), never the
            // original bees' art, which belongs to the three official bees.
            img: s.customImage && imagePath(cfg.settingsPath, id) ? `/bee-image/${id}` : s.fromSetup ? null : `/bees/${s.style}.jpg`,
          };
        })
      : [],
  };
}

/** No Jev key in the environment and no Setup file yet: serve only the Setup page until the owner fills it in. */
function runSetup() {
  const env = process.env;
  const setup = new Setup({
    settingsPath: SETTINGS_PATH,
    jevModel: env.JEV_MODEL?.trim() || "jev-1.13.0",
    openai: { apiKey: env.OPENAI_API_KEY?.trim() || undefined, textModel: env.OPENAI_TEXT_MODEL?.trim() || "gpt-5.4-nano", imageModel: env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2" },
    refDir: REF_DIR,
    windowMin: Math.max(1, Number(env.SETUP_WINDOW_MIN) || 120),
    okxApiBase: env.OKX_API_BASE?.trim().replace(/\/+$/, "") || "https://eea.okx.com",
    onSaved: () => {
      log.info("settings saved; exiting so Docker restarts the engine with them");
      process.exit(0);
    },
  });
  const port = Number(env.ENGINE_PORT) || 8080;
  startServer({ setup, profile: () => profile(null), beeImage: (b) => imagePath(SETTINGS_PATH, b) }, port, env.ENGINE_BIND?.trim() || "127.0.0.1");
  setup.announce();
}

async function main() {
  const settings = loadSettings(SETTINGS_PATH);
  if (!settings && !process.env.TYPESAFE_API_KEY?.trim()) return runSetup();
  let cfg;
  try {
    cfg = loadConfig({ ...process.env, SETTINGS_PATH }, settings);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("refusing to start", { reason: err.message });
      process.exit(1);
    }
    throw err;
  }
  setLogLevel(cfg.logLevel);
  log.info("beebots engine starting", { mode: cfg.mode, tickMs: cfg.tickMs, dataRefreshMs: cfg.dataRefreshMs, jevModel: cfg.jev.model });

  const db = new Db(cfg.dbPath);
  const bus = new EventBus(db);
  const alerts = new Alerts(cfg.alertWebhookUrl);
  const cli = createOkxCli({ site: cfg.okx.site, timeoutMs: cfg.okx.cliTimeoutMs });
  const api = createPublicApi(cli, cfg.okx.apiBase, cfg.mode === "demo");
  const demo = cfg.mode === "demo";

  let engine: Engine | null = null;
  const held = () => (engine ? BEES.map((id) => engine!.bees[id]?.position?.instId).filter((x): x is string => !!x) : []);
  // News needs a key: borrow the first Momentum bee's (demo/live only).
  const newsCreds = BEES.filter((b) => cfg.slots[b].style === "boozy").map((b) => cfg.creds[b]).find((c) => !!c);
  const news = cfg.mode !== "dry" && newsCreds ? createNewsSource(cli, newsCreds, demo) : null;
  const feed = new MarketFeed(
    api,
    {
      min24hVolUsd: cfg.universe.min24hVolUsd,
      allowNonCrypto: cfg.universe.allowNonCrypto,
      spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)),
      trendCoins: [...BREEZY_COINS],
    },
    news,
    held,
  );

  const exec: Executor =
    cfg.mode === "dry"
      ? new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate)
      : new OkxExecutor(cli, cfg.creds, demo, (id) => feed.view().instruments.get(id), cfg.risk.maxLeverage);

  const startOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const jev = new Jev({ ...cfg.jev, spentTodayUsd: db.jevSpendSince(startOfDay) });

  // `deploy/close.sh` drops this file into the data volume to end the experiment cleanly (see Engine.windDown).
  const closeFlag = join(dirname(cfg.dbPath), `close-${cfg.mode}`);
  // Dry run only: `resume-last-dry` puts benched, flat bees back into their last position (consumed on use).
  const resumeFlag = join(dirname(cfg.dbPath), `resume-last-${cfg.mode}`);
  const takeResumeRequest = () => {
    if (cfg.mode !== "dry" || !existsSync(resumeFlag)) return false;
    unlinkSync(resumeFlag);
    return true;
  };
  engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts, closeRequested: () => existsSync(closeFlag), takeResumeRequest });
  await engine.start();

  // The owner password (picked on Setup) gates joining and leaving the Hive from the dashboard. Installs without one
  // (a Setup file from before it existed, or keys only in .env) can set OWNER_PASSWORD instead.
  const envPassword = process.env.OWNER_PASSWORD ?? "";
  if (envPassword && envPassword.length < MIN_PASSWORD) log.warn(`OWNER_PASSWORD is ignored: it needs at least ${MIN_PASSWORD} characters`);
  const ownerPasswordHash = settings?.ownerPasswordHash ?? (envPassword.length >= MIN_PASSWORD ? hashPassword(envPassword) : null);

  // The Hive (opt-in public leaderboard, paper only).
  const hive = new Hive({
    ownerPasswordHash: () => ownerPasswordHash,
    path: hivePath(cfg.settingsPath),
    url: cfg.hive.url,
    mode: cfg.mode,
    db,
    portrait: (slot) => (cfg.slots[slot as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, slot) : null),
    source: () => {
      const snap = engine!.snapshot();
      return {
        startedAt: snap.startedAt,
        startEquityUsd: snap.startEquityUsd,
        bees: snap.bees.map((b) => {
          const s = cfg.slots[b.bee];
          return { slot: b.bee, name: s.name, style: s.style, tagline: s.tagline, rules: s.rules, coins: s.coins, equityUsd: b.equityUsd, fundingUsd: b.totals.fundingUsd, cap: b.cap, tradesToday: b.tradesToday };
        }),
      };
    },
  });
  hive.start(settings);

  // "Update available" on the dashboard (checks GitHub Releases; never installs anything).
  const updates = new UpdateCheck({ repo: cfg.update.repo, current: cfg.update.version, enabled: cfg.update.enabled });
  updates.start();

  const server = startServer(
    {
      engine: { bus, db, visitors: new Visitors(db), snapshot: () => engine!.snapshot(), health: () => engine!.health(), update: () => updates.status() },
      hive,
      profile: () => profile(cfg),
      beeImage: (b) => (cfg.slots[b as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, b) : null),
    },
    cfg.server.port,
    cfg.server.bind,
  );

  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    engine?.stop();
    hive.stop();
    updates.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: safeError(err) });
  process.exit(1);
});
