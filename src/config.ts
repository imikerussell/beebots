import { ACTIVE_MAX_HOLD_MINUTES } from "./bees/active-bizzy.js";
import { BIZZY_BREAKOUT_COINS } from "./bees/bizzy.js";
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
  minStopCostRatio: number;
  maxEntryCandidates: number;
  maxEntryChaseAtr: number;
  longOnly: boolean;
}
export interface ExitSettings {
  breakevenAtR: number;
  breakevenBufferBps: number;
  trailActivationR: number;
  trailAtrMult: number;
  profitLockAtR: number;
  maxGivebackPct: number;
  partialTakeProfitEnabled: boolean;
  partialTakeProfitAtR: number;
  partialTakeProfitFraction: number;
  reviewMinR: number;
  reviewIntervalSeconds: number;
  minActionProbability: number;
}
export interface Config {
  exits: Record<BeeId, ExitSettings>;
  mode: Mode;
  decisionProvider: "lmstudio" | "jev" | "gemini";
  strategyEngine: "catfolio" | "upstream";
  gemini: { apiKey: string; model: string; timeoutMs: number; dailyUsdCap: number; usdPerMTok: number; usdPerMTokOut: number; minIntervalMs: number; thinkingLevel?: string };
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
  coach: { enabled: boolean; autoApply: boolean; apiKey?: string; adminToken?: string; model: string };
  strategies: {
    tiger: { minMomentumPct: number; momentumAtrMult: number; maxHoldMinutes: number;
      signalMode: "momentum" | "trend_momentum" | "trend_breakout";
      entryBars: number; exitBars: number; fastHours: number; slowHours: number };
    mochi: { minTrendScore: number; volTargetPct: number; trimScoreDrop: number; maxHoldMinutes: number };
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
  configurationWarnings: string[];
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
  const decisionProvider = str("DECISION_PROVIDER", env.GEMINI_API_KEY?.trim() ? "gemini" : "lmstudio");
  if (decisionProvider !== "lmstudio" && decisionProvider !== "jev" && decisionProvider !== "gemini")
    throw new ConfigError("DECISION_PROVIDER must be lmstudio, jev or gemini");
  const strategyEngine = str("STRATEGY_ENGINE", decisionProvider === "gemini" ? "upstream" : "catfolio");
  if (strategyEngine !== "catfolio" && strategyEngine !== "upstream") throw new ConfigError("STRATEGY_ENGINE must be upstream or catfolio");
  const upstream = strategyEngine === "upstream";
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
  const exits = {} as Record<BeeId, ExitSettings>;
  const slots = {} as Record<BeeId, SlotProfile>;
  for (const [i, id] of CATS.entries()) {
    const tiger = id === "tiger",
      p = id.toUpperCase();
    const allocation = num(`${p}_ALLOCATION_PCT`, 50, 0.01, 99.99);
    cats[id] = {
      allocationPct: allocation,
      startEquityUsd: (total * allocation) / 100,
      maxNotionalPct: num(`${p}_MAX_NOTIONAL_PCT`, 200, 0.01, 200),
      stopRiskPct: num(`${p}_STOP_RISK_PCT`, tiger ? 0.5 : 0.25, 0.001, 10),
      dailyLossStopPct: num(
        `${p}_DAILY_LOSS_STOP_PCT`,
        8,
        0.01,
        100,
      ),
      maxTradesPerDay: num(
        `${p}_MAX_ENTRIES_PER_DAY`,
        upstream ? (tiger ? 4 : 2) : (tiger ? 12 : 3),
        0,
        1000,
        true,
      ),
      cooldownMinutes: num(`${p}_COOLDOWN_MINUTES`, tiger ? (upstream ? 30 : 5) : 240, 0),
      spreadGateBps: num(`${p}_SPREAD_GATE_BPS`, 5, 0.01, 100),
      minVolumeUsd: num(`${p}_MIN_24H_VOLUME_USD`, 1e6, 0),
      feeBudgetUsdDay: num(`${p}_FEE_BUDGET_USD_DAY`, upstream ? (tiger ? 1.2 : 0.75) : (tiger ? 3 : 1), 0),
      minActionProbability: num(
        `${p}_MIN_ACTION_PROBABILITY`,
        tiger || upstream ? 0.55 : 0.7,
        0,
        1,
      ),
      minConviction: num(`${p}_MIN_CONVICTION`, tiger || upstream ? 1 : 2, 0, 3),
      minStopCostRatio: num(`${p}_MIN_STOP_COST_RATIO`, 3, 0, 20),
      maxEntryCandidates: num(`${p}_MAX_ENTRY_CANDIDATES`, 1, 1, tiger ? 12 : 2, true),
      maxEntryChaseAtr: num(`${p}_MAX_ENTRY_CHASE_ATR`, 0.5, 0, 10),
      stopAtrMult: num(`${p}_STOP_ATR_MULT`, tiger && !upstream ? 1.5 : 2, 0.1, 20),
      longOnly: false,
      maxFlatMinutes: Infinity, // Legacy brain port; current strategies never force entries.
    };
    const partialEnabled = str(`${p}_PARTIAL_TAKE_PROFIT_ENABLED`, "true");
    if (!["true", "false"].includes(partialEnabled))
      throw new ConfigError(`${p}_PARTIAL_TAKE_PROFIT_ENABLED must be true or false`);
    exits[id] = {
      breakevenAtR: num(`${p}_BREAKEVEN_AT_R`, tiger ? 0.5 : 1, 0, 100),
      breakevenBufferBps: num(`${p}_BREAKEVEN_BUFFER_BPS`, 1, 0, 100),
      trailActivationR: num(`${p}_TRAIL_ACTIVATION_R`, tiger ? 0.75 : 1.5, 0, 100),
      trailAtrMult: num(`${p}_TRAIL_ATR_MULT`, tiger ? 1 : 1.5, 0.1, 20),
      profitLockAtR: num(`${p}_PROFIT_LOCK_AT_R`, tiger ? 1 : 2, 0, 100),
      maxGivebackPct: num(`${p}_MAX_PROFIT_GIVEBACK_PCT`, tiger ? 35 : 40, 0, 100),
      partialTakeProfitEnabled: partialEnabled === "true",
      partialTakeProfitAtR: num(`${p}_PARTIAL_TAKE_PROFIT_AT_R`, tiger ? 1.5 : 2, 0.01, 100),
      partialTakeProfitFraction: num(`${p}_PARTIAL_TAKE_PROFIT_FRACTION`, 0.5, 0.01, 0.99),
      reviewMinR: num(`${p}_EXIT_REVIEW_MIN_R`, tiger ? 0.5 : 1, 0, 100),
      reviewIntervalSeconds: num(`${p}_EXIT_REVIEW_INTERVAL_SECONDS`, tiger ? 60 : 300, 10, 86400, true),
      minActionProbability: num(`${p}_EXIT_MIN_ACTION_PROBABILITY`, 0.4, 0, 1),
    };
    const saved = settings?.cats[i];
    if (saved && saved.id !== id)
      throw new ConfigError(
        "Settings must contain Tiger then Mochi identities",
      );
    slots[id] = {
      name: str(`${p}_NAME`, saved?.name ?? (tiger ? "DARK Wall-E" : "Good Wall-E")),
      style: tiger ? "bizzy" : "breezy",
      tagline: tiger ? (upstream ? "Argon band fades & breakouts" : "Active long/short momentum") : "Breezy long/short trend",
      rules:
        migrateStrategyRules(saved?.rules) ??
        (upstream ? (tiger ? "Take strict band fades and confirmed breakouts. Bank targets and cut failed setups. WAIT is valid." : "Follow qualified BTC/ETH Donchian trends. Wait in chop, ride winners, and reduce when the trend weakens.") : tiger
          ? "Assess the qualified LONG or SHORT candidate against WAIT on each completed signal bar. HOLD a continuing move. Code handles signal exits and protective stops; prefer persistence after costs."
          : "Assess the qualified directional trend against WAIT on each completed four-hour bar. Ride winners and add only within the risk budget above +1R. Trim a weakening trend once; code handles exits."),
      coins: tiger ? (upstream ? ["BTC", "ETH", "SOL", "HYPE", "XRP", "SUI", "DOGE", "LINK"] : [...BIZZY_BREAKOUT_COINS]) : ["BTC", "ETH"],
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
  const coachAutoApply = str("COACH_AUTO_APPLY", "false");
  if (!["true", "false"].includes(coachAutoApply)) throw new ConfigError("COACH_AUTO_APPLY must be true or false");
  const signalMode = str("TIGER_SIGNAL_MODE", "momentum");
  if (!["momentum", "trend_momentum", "trend_breakout"].includes(signalMode)) throw new ConfigError("Invalid TIGER_SIGNAL_MODE");
  const fastHours = num("TIGER_TREND_FAST_HOURS",20,2,99,true), slowHours = num("TIGER_TREND_SLOW_HOURS",50,3,100,true);
  if (fastHours >= slowHours) throw new ConfigError("TIGER_TREND_FAST_HOURS must be below TIGER_TREND_SLOW_HOURS");
  const adminToken = env.COACH_ADMIN_TOKEN?.trim() || undefined;
  if (adminToken && adminToken.length < 24) throw new ConfigError("COACH_ADMIN_TOKEN must be at least 24 characters");
  return {
    exits,
    coach: {
      enabled: !upstream && coachEnabled === "true",
      autoApply: !upstream && coachAutoApply === "true",
      apiKey: env.AI_GATEWAY_API_KEY?.trim() || undefined,
      adminToken,
      model: str("COACH_MODEL", "anthropic/claude-sonnet-4.6"),
    },
    strategies: {
      tiger: {
        minMomentumPct: num("TIGER_MIN_MOMENTUM_PCT", 0.1, 0.01, 5),
        momentumAtrMult: num("TIGER_MOMENTUM_ATR_MULT", 0.25, 0.01, 5),
        maxHoldMinutes: num("TIGER_MAX_HOLD_MINUTES", ACTIVE_MAX_HOLD_MINUTES, 5, 1440),
        signalMode: signalMode as "momentum" | "trend_momentum" | "trend_breakout",
        entryBars: num("TIGER_BREAKOUT_BARS",20,2,100,true),
        exitBars: num("TIGER_EXIT_BARS",10,2,100,true), fastHours, slowHours,
      },
      mochi: {
        minTrendScore: num("MOCHI_MIN_TREND_SCORE", 4, 1, 9, true),
        volTargetPct: num("MOCHI_VOL_TARGET_PCT", 25, 0.1, 100),
        trimScoreDrop: num("MOCHI_TRIM_SCORE_DROP", 3, 1, 9, true),
        maxHoldMinutes: num("MOCHI_MAX_HOLD_MINUTES", 360, 15, 10080),
      },
    },
    mode,
    strategyEngine,
    gemini: {
      apiKey: env.GEMINI_API_KEY?.trim() || "",
      model: str("GEMINI_MODEL", "gemini-4-argon"),
      timeoutMs: num("GEMINI_TIMEOUT_MS", 3000, 100, 300000),
      dailyUsdCap: num("GEMINI_DAILY_USD_CAP", 3, 0),
      usdPerMTok: num("GEMINI_USD_PER_MTOK", 4, Number.MIN_VALUE),
      usdPerMTokOut: num("GEMINI_USD_PER_MTOK_OUT", 20, Number.MIN_VALUE),
      minIntervalMs: num("GEMINI_MIN_INTERVAL_MS", 60000, 0),
      thinkingLevel: env.GEMINI_THINKING_LEVEL?.trim() || undefined,
    },
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
      usdPerMTok: num("JEV_USD_PER_MTOK", 0.042, decisionProvider === "jev" ? Number.MIN_VALUE : 0),
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
    tickMs: num("DECISION_INTERVAL_MS", 10000, 1000),
    configurationWarnings: ["PROTECTIVE_INTERVAL_MS", "MAX_DECISION_AGE_MS", "TIGER_MIN_TREND_SCORE",
      "TIGER_MAX_CHASE_RANGE_FRAC", "TIGER_MAX_FUNDING_PCT", "TIGER_MAX_FLAT_MINUTES", "MOCHI_MAX_FLAT_MINUTES",
      "BREEZY_MIN_SIZE_USD"].filter(key => env[key]?.trim()).map(key => `${key} is obsolete and ignored; remove it. See docs/CONFIGURATION.md.`),
    maxTickerAgeMs: num("MAX_TICKER_AGE_MS", 15000, 100),
    dataRefreshMs: num("DATA_REFRESH_MS", 60000, 1000),
    paperSlippageBps: num("PAPER_SLIPPAGE_BPS", 2, 0, 100),
    risk: {
      startEquityUsd: total / 2,
      maxLeverage: num("MAX_LEVERAGE", 2, 0.01, 2),
      maxNotionalUsdPerBee: num("MAX_NOTIONAL_USD_PER_BEE", 700, 0.01),
      dailyLossStopPct: 8,
      retireAtPct: 40,
      maxFlatMinutes: Infinity,
      liveSizeMultiplier: num("LIVE_SIZE_MULTIPLIER", 0.25, 0.01, 1),
      liveRampHours: num("LIVE_RAMP_HOURS", 2, 0),
      takerFeeRate: num("TAKER_FEE_RATE", 0.0005, 0, 0.1),
    },
    bees: { bizzy: cats.tiger, breezy: cats.mochi, boozy: cats.tiger },
    breezy: { minOpenProb: cats.mochi.minActionProbability, minSizeUsd: 10 }, // Historical brain fixtures only.
    bizzy: { sizeFraction: upstream ? 0.5 : 1, universeSize: upstream ? 8 : 3, timeStopMinutes: 240 },
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

/** Replace only the shipped replacement-engine defaults, never arbitrary owner rules. */
function migrateStrategyRules(rules: string | undefined): string | undefined {
  const obsolete = [
    "Take convincing BREAKOUT entries and ride them to the day close. CUT_LOSS when the breakout is failing.",
    "Trade a confirmed daily volatility breakout, avoid chasing, and close before UTC midnight. WAIT is valid.",
    "Follow the nine-channel 4h Donchian ensemble with volatility sizing and channel trailing stops. Keep cash without a strong trend.",
    "Trade confirmed five-minute breakouts with a supportive fifteen-minute trend. Avoid chasing; exit within two hours. WAIT is valid.",
    "Follow an hourly intraday trend with fifteen-minute entry checks, volatility sizing and channel trailing stops. Exit within six hours. Keep cash without a strong trend.",
  ];
  return rules && obsolete.includes(rules) ? undefined : rules;
}
