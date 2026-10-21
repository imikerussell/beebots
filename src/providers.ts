import type { DecisionProvider } from "./decision.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { Jev } from "./jev.js";
import { LmStudio } from "./lmstudio.js";
import { Gemini } from "./gemini.js";
/** One selected provider serves both cats. Selection never changes automatically on failure. */
export function createDecisionProvider(
  cfg: Config,
  db?: Db,
  fetcher: typeof fetch = fetch,
): DecisionProvider & { close(): void } {
  if (cfg.decisionProvider === "gemini") return new Gemini(cfg.gemini, db, fetcher);
  if (cfg.decisionProvider === "lmstudio")
    return new LmStudio(cfg.local, fetcher);
  return new Jev(
    cfg.jev,
    db
      ? {
          spent: (day) => Number(db.getMeta(`jev_spend_${day}`) ?? 0),
          charge: (day, usd) =>
            db.transaction(() =>
              db.setMeta(
                `jev_spend_${day}`,
                String(Number(db.getMeta(`jev_spend_${day}`) ?? 0) + usd),
              ),
            ),
        }
      : undefined,
    fetcher,
  );
}
/** Safe, reproducible backend configuration: never includes either credential. */
export function decisionConfiguration(cfg: Config) {
  if (cfg.decisionProvider === "gemini") return { ...cfg.gemini, apiKey: undefined, provider: "gemini" };
  return cfg.decisionProvider === "lmstudio"
    ? { ...cfg.local, token: undefined, provider: "lmstudio" }
    : {
        ...cfg.jev,
        apiKey: undefined,
        provider: "jev",
      };
}
