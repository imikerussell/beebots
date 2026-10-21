// Settings only: never print the environment, credentials, provider headers or arbitrary owner text.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { loadConfig } from "../config.js";
import { loadSettings } from "../settings.js";

const args = process.argv.slice(2), runtime = args.includes("--runtime");
const file = args.find(a => !a.startsWith("--") && args[args.indexOf(a)-1] !== "--diff");
if (!runtime && !file) throw Error("Usage: effective-config --runtime | <env-file> [--diff <reference.json>]");
const env = runtime ? process.env : parseEnv(readFileSync(file!, "utf8"));
const cfg = loadConfig(env, loadSettings(env.SETTINGS_PATH?.trim() || "./data/catfolio-settings.json"));
const chooser = cfg.decisionProvider === "gemini" ? cfg.gemini : cfg.decisionProvider === "jev" ? cfg.jev : cfg.local;
const settings = { strategyEngine: cfg.strategyEngine, mode: cfg.mode,
  bees: { bizzy: cfg.cats.tiger, breezy: cfg.cats.mochi }, risk: cfg.risk,
  bizzy: cfg.bizzy, breezy: cfg.breezy, exits: cfg.strategyEngine === "catfolio" ? cfg.exits : "upstream profit locks and trailing",
  chooser: { provider: cfg.decisionProvider, model: chooser.model,
    apiKeyPresent: cfg.decisionProvider === "lmstudio" ? !!cfg.local.token : !!(cfg.decisionProvider === "gemini" ? cfg.gemini.apiKey : cfg.jev.apiKey),
    ...(cfg.decisionProvider === "lmstudio" ? {} : { dailyUsdCap: cfg.decisionProvider === "gemini" ? cfg.gemini.dailyUsdCap : cfg.jev.dailyUsdCap }),
    ...(cfg.decisionProvider === "gemini" ? {usdPerMTokIn: cfg.gemini.usdPerMTok, usdPerMTokOut: cfg.gemini.usdPerMTokOut, minIntervalMs: cfg.gemini.minIntervalMs} : {}),
  },
};
const diffPath = args[args.indexOf("--diff")+1];
const differences: Array<{path: string; actual: unknown; intended: unknown}> = [];
const compare = (actual: unknown, intended: unknown, prefix = "") => {
  if (intended && typeof intended === "object" && !Array.isArray(intended)) {
    for (const [key, value] of Object.entries(intended)) if (!key.startsWith("_"))
      compare((actual as Record<string,unknown> | undefined)?.[key], value, prefix ? `${prefix}.${key}` : key);
  } else if (actual !== intended) differences.push({path: prefix, actual: actual ?? null, intended});
};
if (args.includes("--diff")) {
  if (!diffPath) throw Error("--diff requires a reference JSON file");
  compare(settings, JSON.parse(readFileSync(diffPath,"utf8")));
}
console.log(JSON.stringify({source: runtime ? "runtime" : "file-simulation", upstream: "imikerussell/beebots@6cf999a", settings, configurationWarnings: cfg.configurationWarnings, differences},null,2));
