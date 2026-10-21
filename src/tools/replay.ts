// Print the exact recorded input/configuration/answer/action; offline, no inference and no execution.
import { existsSync } from "node:fs";
import { createDecisionProvider, decisionConfiguration } from "../providers.js";
import type { DecisionAsk } from "../decision.js";
import { loadConfig } from "../config.js";
import { Db } from "../db.js";
const cfg = loadConfig(),
  id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id <= 0)
  throw new Error("Usage: pnpm replay <decision-id>");
if (!existsSync(cfg.dbPath)) throw new Error("No run at DB_PATH");
const db = new Db(cfg.dbPath, true);
try {
  const row = db.raw.prepare("SELECT * FROM decisions WHERE id=?").get(id);
  if (!row) throw new Error("Decision not found");
  const audit = JSON.parse(String(row.audit_json ?? "null")) as {
    source?: string;
    strategy: string;
    state: DecisionAsk["state"];
    menu: DecisionAsk["menu"];
    rubric: string[];
    config: { model: string; provider?: string };
  } | null;
  console.log(
    JSON.stringify({ ...row, audit_json: undefined, audit }, null, 2),
  );
  if (process.argv.includes("--infer")) {
    if (
      !audit?.strategy ||
      !audit.menu ||
      !audit.rubric ||
      (audit.source && audit.source !== "model_request")
    )
      throw new Error("This is a protective rule event, not a model request");
    if (
      !process.argv.includes("--compare-provider") &&
      (decisionConfiguration(cfg).model !== audit.config.model ||
        cfg.decisionProvider !== (audit.config.provider ?? "lmstudio"))
    )
      throw new Error(
        "Replay model differs from recorded model. Select the original identifier/configuration first.",
      );
    const budgetDb =
      cfg.decisionProvider !== "lmstudio" ? new Db(cfg.dbPath) : undefined;
    const provider = createDecisionProvider(cfg, budgetDb);
    const result = await provider.decide({
      strategy: audit.strategy,
      state: audit.state,
      menu: audit.menu,
      convictionLabels: audit.rubric,
    });
    console.log(
      JSON.stringify(
        {
          replay: result,
          provider: cfg.decisionProvider,
          originalProvider: audit.config.provider ?? "lmstudio",
          execution: "disabled",
        },
        null,
        2,
      ),
    );
    provider.close();
    budgetDb?.close();
    if (!result.ok) process.exitCode = 1;
  }
} finally {
  db.close();
}
