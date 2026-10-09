// Explicit read-only model check. Jev selection makes one billed hosted API request, never an order.
import { loadConfig } from "../config.js";
import { Db } from "../db.js";
import { CONVICTION } from "../decision.js";
import { createDecisionProvider } from "../providers.js";
const cfg = loadConfig();
if (cfg.decisionProvider === "lmstudio") {
  await import("./local-check.js");
} else {
  const db = new Db(cfg.dbPath);
  const provider = createDecisionProvider(cfg, db);
  try {
    console.log(
      `Jev cloud check (${cfg.jev.transport}): ${cfg.jev.model}. This typed decision request can incur API charges. No orders.`,
    );
    const result = await provider.decide({
      strategy: "Connection test. Select WAIT when no confirmed setup exists.",
      state: {
        connectionTest: true,
        market: "No confirmed setup",
        execution: "disabled",
      },
      menu: {
        WAIT: { desc: "Keep cash", intent: { kind: "hold" } },
        OPEN_TEST: {
          desc: "Hypothetical entry; never executed",
          intent: { kind: "hold" },
        },
      },
      convictionLabels: CONVICTION,
    });
    console.log(
      JSON.stringify(
        { ...result, provider: "jev", execution: "disabled" },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 1;
  } finally {
    provider.close();
    db.close();
  }
}
