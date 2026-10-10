import { STYLES, type Settings, type StyleId } from "./settings.js";
export { STYLES, type StyleId };
export const CATS = ["tiger", "mochi"] as const;
// Retain the upstream ledger/strategy vocabulary internally, with exactly two identities.
export const BEES = CATS;
export type BeeId = (typeof CATS)[number];
export type Mode = "dry" | "demo" | "live";
export const LIVE_ACK_PHRASE = "I-ACCEPT-REAL-MONEY-RISK";
export class ConfigError extends Error {}
export interface OkxCreds {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}
export interface SlotProfile {
  name: string;
  style: StyleId;
  tagline: string;
  rules: string;
  coins: string[];
  customImage: boolean;
  fromSetup: boolean;
}
export interface BeeKnobs {
  maxTradesPerDay: number;
  feeBudgetUsdDay: number;
  spreadGateBps: number;
  cooldownMinutes: number;
  stopAtrMult: number;
  maxFlatMinutes: number;
}
export interface CatLimits extends BeeKnobs {
  allocationPct: number;
  startEquityUsd: number;
  maxNotionalPct: number;
  stopRiskPct: number;
  dailyLossStopPct: number;
  minVolumeUsd: number;
  minActionProbability: number;
  minConviction: number;
  minTrendScore: number;
  longOnly: boolean;
}
export interface Config {
  mode: Mode;
  decisionProvider: "lmstudio" | "jev";
  jev: {
    transport: "typesafe" | "vercel";
    origin: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    concurrency: number;
    dailyUsdCap: number;
    usdPerMTok: number;
  };
  coach: { enabled: boolean; apiKey?: string; adminToken?: string; model: string };
  strategies: {
    tiger: { maxChaseRangeFrac: number; maxFundingPct: number; maxHoldMinutes: number };
    mochi: { volTargetPct: number; trimScoreDrop: number; maxHoldMinutes: number };
  };
  slots: Record<BeeId, SlotProfile>;
  cats: Record<BeeId, CatLimits>;
  local: {
    origin: string;
    model: string;
    token?: string;
    timeoutMs: number;
    concurrency: number;
    maxOptions: number;
    appVersion: string;
    engineVersion: string;
    artifact: string;
  };
  tickMs: number;
  protectiveMs: number;
  maxDecisionAgeMs: number;
  maxTickerAgeMs: number;
  dataRefreshMs: number;
  paperSlippageBps: number;
  totalStartEquityUsd: number;
  risk: {
    startEquityUsd: number;
    maxLeverage: number;
    maxNotionalUsdPerBee: number;
    dailyLossStopPct: number;
    retireAtPct: number;
    maxFlatMinutes: number;
    liveSizeMultiplier: number;
    liveRampHours: number;
    takerFeeRate: number;
  };
  bees: Record<StyleId, BeeKnobs>;
  breezy: { minOpenProb: number; minSizeUsd: number };
  bizzy: {
    sizeFraction: number;
    universeSize: number;
    timeStopMinutes: number;
  };
  boozy: { candidates: number };
  universe: { min24hVolUsd: number; allowNonCrypto: boolean };
  okx: { site: "eea"; apiBase: string; cliTimeoutMs: number };
  creds: Partial<Record<BeeId, OkxCreds>>;
  server: { port: number; bind: string };
  dbPath: string;
  settingsPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  alertWebhookUrl?: string;
}
export function originOf(
  v: string,
  schemes: readonly string[] = ["http:", "https:"],
): string | null {
  try {
    const u = new URL(v);
    return schemes.includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/"
      ? u.origin
      : null;
  } catch {
    return null;
  }
}
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  settings: Settings | null = null,
): Config {
  const str = (k: string, d: string) => env[k]?.trim() || d;
  const num = (
    k: string,
    d: number,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    integer = false,
  ) => {
    const n = Number(str(k, String(d)));
    if (
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (integer && !Number.isInteger(n))
    )
      throw new ConfigError(
        `${k} must be ${integer ? "an integer" : "a number"} in [${min}, ${max}]`,
      );
    return n;
  };
  const decisionProvider = str("DECISION_PROVIDER", "lmstudio");
  if (decisionProvider !== "lmstudio" && decisionProvider !== "jev")
    throw new ConfigError("DECISION_PROVIDER must be lmstudio or jev");
  const jevTransport = str("JEV_TRANSPORT", "typesafe");
  if (jevTransport !== "typesafe" && jevTransport !== "vercel")
    throw new ConfigError("JEV_TRANSPORT must be typesafe or vercel");
  const jevModel = str("JEV_MODEL", jevTransport === "vercel" ? "typesafe-ai/jev" : "jev-1.13.0");
  if (decisionProvider === "jev" && jevTransport === "vercel" && jevModel !== "typesafe-ai/jev")
    throw new ConfigError("Vercel requires JEV_MODEL=typesafe-ai/jev");
  if (decisionProvider === "jev" && jevTransport === "typesafe" && !/^jev-\d+\.\d+\.\d+$/.test(jevModel))
    throw new ConfigError(
      "Pin JEV_MODEL to a versioned identifier such as jev-1.13.0 (aliases can change during comparisons)",
    );
  const dry = str("DRY_RUN", "true");
  if (!["true", "false"].includes(dry))
    throw new ConfigError("DRY_RUN must be true or false");
  const requested = str("MODE", "paper");
  if (!["paper", "dry", "demo", "live"].includes(requested))
    throw new ConfigError("MODE must be paper, demo or live");
  const mode: Mode =
    dry === "true" || requested === "paper" ? "dry" : (requested as Mode);
  if (mode === "live" && env.LIVE_ACK !== LIVE_ACK_PHRASE)
    throw new ConfigError(`Live requires LIVE_ACK=${LIVE_ACK_PHRASE}`);
  if (settings && (settings.version !== 2 || settings.cats.length !== 2))
    throw new ConfigError(
      "Incompatible settings: preserve the old file; select a new SETTINGS_PATH and DB_PATH for Catfolio.",
    );
  const origin = originOf(str("LM_STUDIO_ORIGIN", "http://127.0.0.1:1234"));
  if (!origin)
    throw new ConfigError(
      "LM_STUDIO_ORIGIN must be an http(s) origin without path or credentials",
    );
  const total = num("TOTAL_START_EQUITY_USD", 200, 0.01);
  const cats = {} as Record<BeeId, CatLimits>;
  const slots = {} as Record<BeeId, SlotProfile>;
  for (const [i, id] of CATS.entries()) {
    const tiger = id === "tiger",
      p = id.toUpperCase();
    const allocation = num(`${p}_ALLOCATION_PCT`, 50, 0.01, 99.99);
    cats[id] = {
      allocationPct: allocation,
      startEquityUsd: (total * allocation) / 100,
      maxNotionalPct: num(`${p}_MAX_NOTIONAL_PCT`, 50, 0.01, 100),
      stopRiskPct: num(`${p}_STOP_RISK_PCT`, tiger ? 0.5 : 0.25, 0.001, 10),
      dailyLossStopPct: num(
        `${p}_DAILY_LOSS_STOP_PCT`,
        tiger ? 5 : 2,
        0.01,
        100,
      ),
      maxTradesPerDay: num(
        `${p}_MAX_ENTRIES_PER_DAY`,
        tiger ? 8 : 4,
        0,
        1000,
        true,
      ),
      cooldownMinutes: num(`${p}_COOLDOWN_MINUTES`, tiger ? 15 : 30, 0),
      spreadGateBps: num(`${p}_SPREAD_GATE_BPS`, tiger ? 10 : 3, 0.01, 100),
      minVolumeUsd: num(`${p}_MIN_24H_VOLUME_USD`, tiger ? 1e6 : 10e6, 0),
      feeBudgetUsdDay: num(`${p}_FEE_BUDGET_USD_DAY`, tiger ? 2 : 1, 0),
      minActionProbability: num(
        `${p}_MIN_ACTION_PROBABILITY`,
        tiger ? 0.55 : 0.7,
        0,
        1,
      ),
      minConviction: num(`${p}_MIN_CONVICTION`, tiger ? 1 : 2, 0, 3, true),
      minTrendScore: num(`${p}_MIN_TREND_SCORE`, tiger ? 3 : 4, 1, 9, true),
      stopAtrMult: num(`${p}_STOP_ATR_MULT`, 2, 0.1, 20),
      longOnly: true,
      maxFlatMinutes: Infinity,
    };
    const saved = settings?.cats[i];
    if (saved && saved.id !== id)
      throw new ConfigError(
        "Settings must contain Tiger then Mochi identities",
      );
    slots[id] = {
      name: str(`${p}_NAME`, saved?.name ?? (tiger ? "DARK Wall-E" : "Good Wall-E")),
      style: tiger ? "bizzy" : "breezy",
      tagline: tiger ? "Fast intraday breakout" : "Intraday trend follower",
      rules:
        saved?.rules ??
        (tiger
          ? "Trade confirmed five-minute breakouts with a supportive fifteen-minute trend. Avoid chasing; exit within two hours. WAIT is valid."
          : "Follow an hourly intraday trend with fifteen-minute entry checks, volatility sizing and channel trailing stops. Exit within six hours. Keep cash without a strong trend."),
      coins: tiger ? ["BTC", "ETH", "SOL"] : ["BTC", "ETH"],
      customImage: false,
      fromSetup: !!saved,
    };
  }
  if (
    Math.abs(cats.tiger.allocationPct + cats.mochi.allocationPct - 100) > 1e-8
  )
    throw new ConfigError(
      "TIGER_ALLOCATION_PCT + MOCHI_ALLOCATION_PCT must sum to 100",
    );
  const creds: Config["creds"] = {};
  if (mode !== "dry")
    for (const id of CATS) {
      const p = `${id.toUpperCase()}_OKX_${mode === "demo" ? "DEMO_" : ""}API_`;
      const missing = ["KEY", "SECRET", "PASSPHRASE"].filter(
        (k) => !env[p + k]?.trim(),
      );
      if (missing.length)
        throw new ConfigError(
          `MODE=${mode} needs ${missing.map((k) => p + k).join(", ")}`,
        );
      creds[id] = {
        apiKey: env[p + "KEY"]!,
        secretKey: env[p + "SECRET"]!,
        passphrase: env[p + "PASSPHRASE"]!,
      };
    }
  if (creds.tiger?.apiKey === creds.mochi?.apiKey && creds.tiger)
    throw new ConfigError("Cats require distinct exchange sub-account keys");
  const logLevel = str("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel))
    throw new ConfigError("Invalid LOG_LEVEL");
  const coachEnabled = str("COACH_ENABLED", env.AI_GATEWAY_API_KEY?.trim() ? "true" : "false");
  if (!["true", "false"].includes(coachEnabled)) throw new ConfigError("COACH_ENABLED must be true or false");
  const adminToken = env.COACH_ADMIN_TOKEN?.trim() || undefined;
  if (adminToken && adminToken.length < 24) throw new ConfigError("COACH_ADMIN_TOKEN must be at least 24 characters");
  return {
    coach: {
      enabled: coachEnabled === "true",
      apiKey: env.AI_GATEWAY_API_KEY?.trim() || undefined,
      adminToken,
      model: str("COACH_MODEL", "anthropic/claude-sonnet-4.6"),
    },
    strategies: {
      tiger: {
        maxChaseRangeFrac: num("TIGER_MAX_CHASE_RANGE_FRAC", 0.25, 0, 2),
        maxFundingPct: num("TIGER_MAX_FUNDING_PCT", 0.03, 0, 1),
        maxHoldMinutes: num("TIGER_MAX_HOLD_MINUTES", 120, 5, 1440),
      },
      mochi: {
        volTargetPct: num("MOCHI_VOL_TARGET_PCT", 25, 0.1, 100),
        trimScoreDrop: num("MOCHI_TRIM_SCORE_DROP", 3, 1, 9, true),
        maxHoldMinutes: num("MOCHI_MAX_HOLD_MINUTES", 360, 15, 2880),
      },
    },
    mode,
    slots,
    cats,
    creds,
    totalStartEquityUsd: total,
    decisionProvider,
    jev: {
      transport: jevTransport,
      origin: jevTransport === "vercel" ? "https://ai-gateway.vercel.sh/typesafe" : "https://api.typesafe.ai",
      apiKey: (jevTransport === "vercel" ? env.AI_GATEWAY_API_KEY : env.TYPESAFE_API_KEY)?.trim() || undefined,
      model: jevModel,
      timeoutMs: num("JEV_TIMEOUT_MS", 10000, 100, 300000),
      concurrency: num("JEV_CONCURRENCY", 1, 1, 2, true),
      dailyUsdCap: num("JEV_DAILY_USD_CAP", 2, 0),
      usdPerMTok: num("JEV_USD_PER_MTOK", 0.042, 0),
    },
    local: {
      origin,
      model: str("LM_STUDIO_MODEL", ""),
      token: env.LM_STUDIO_TOKEN?.trim() || undefined,
      timeoutMs: num("LM_STUDIO_TIMEOUT_MS", 45000, 100, 300000),
      concurrency: num("LM_STUDIO_CONCURRENCY", 1, 1, 2, true),
      maxOptions: num("LM_STUDIO_MAX_OPTIONS", 26, 2, 26, true),
      appVersion: str("LM_STUDIO_VERSION", "unrecorded"),
      engineVersion: str("LM_STUDIO_ENGINE", "unrecorded"),
      artifact: str("LM_STUDIO_ARTIFACT", "unrecorded"),
    },
    tickMs: num("DECISION_INTERVAL_MS", 60000, 1000),
    protectiveMs: num("PROTECTIVE_INTERVAL_MS", 5000, 100),
    maxDecisionAgeMs: num("MAX_DECISION_AGE_MS", 55000, 100),
    maxTickerAgeMs: num("MAX_TICKER_AGE_MS", 15000, 100),
    dataRefreshMs: num("DATA_REFRESH_MS", 60000, 1000),
    paperSlippageBps: num("PAPER_SLIPPAGE_BPS", 2, 0, 100),
    risk: {
      startEquityUsd: total / 2,
      maxLeverage: num("MAX_LEVERAGE", 1, 0.01, 2),
      maxNotionalUsdPerBee: total,
      dailyLossStopPct: 5,
      retireAtPct: 40,
      maxFlatMinutes: Infinity,
      liveSizeMultiplier: num("LIVE_SIZE_MULTIPLIER", 0.25, 0.01, 1),
      liveRampHours: num("LIVE_RAMP_HOURS", 2, 0),
      takerFeeRate: num("TAKER_FEE_RATE", 0.0005, 0, 0.1),
    },
    bees: { bizzy: cats.tiger, breezy: cats.mochi, boozy: cats.tiger },
    breezy: { minOpenProb: cats.mochi.minActionProbability, minSizeUsd: 0 },
    bizzy: { sizeFraction: 1, universeSize: 3, timeStopMinutes: 240 },
    boozy: { candidates: 3 },
    universe: {
      min24hVolUsd: Math.min(cats.tiger.minVolumeUsd, cats.mochi.minVolumeUsd),
      allowNonCrypto: false,
    },
    okx: {
      site: "eea",
      apiBase: str("OKX_API_BASE", "https://eea.okx.com"),
      cliTimeoutMs: num("OKX_CLI_TIMEOUT_MS", 10000, 100),
    },
    server: {
      port: num("ENGINE_PORT", 8080, 1, 65535, true),
      bind: str("ENGINE_BIND", "127.0.0.1"),
    },
    dbPath: str("DB_PATH", "./data/catfolio-{mode}.sqlite").replaceAll(
      "{mode}",
      mode,
    ),
    settingsPath: str("SETTINGS_PATH", "./data/catfolio-settings.json"),
    logLevel: logLevel as Config["logLevel"],
  };
}
