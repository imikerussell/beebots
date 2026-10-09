import { writePrivateJson } from "../settings.js";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import { CONVICTION, type DecisionAsk } from "../decision.js";
import { LmStudio } from "../lmstudio.js";

const cfg = loadConfig();
const headers = cfg.local.token
  ? { Authorization: `Bearer ${cfg.local.token}` }
  : undefined;
console.log(
  `LM Studio origin: ${cfg.local.origin}\nConfigured model: ${cfg.local.model || "(unset)"}`,
);
console.log(
  `Recorded app: ${cfg.local.appVersion}; engine: ${cfg.local.engineVersion}; artifact: ${cfg.local.artifact}`,
);
let loaded = false;
let inventory: unknown = null;
try {
  const r = await fetch(`${cfg.local.origin}/api/v1/models`, {
    headers,
    signal: AbortSignal.timeout(cfg.local.timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as {
    models?: Array<{
      key: string;
      format?: string;
      loaded_instances?: Array<{ id: string }>;
    }>;
  };
  if (!Array.isArray(data.models))
    throw new Error("Unrecognized /api/v1/models response");
  inventory = data;
  console.log(
    "Downloaded models and loaded instance identifiers:",
    JSON.stringify(
      data.models.map((m) => ({
        key: m.key,
        format: m.format,
        loaded_instances: m.loaded_instances,
      })),
      null,
      2,
    ),
  );
  loaded = data.models.some((m) =>
    m.loaded_instances?.some((i) => i.id === cfg.local.model),
  );
} catch (e) {
  console.error(
    `Cannot verify loaded model via LM Studio native API: ${e instanceof Error ? e.message : e}`,
  );
}
// Probe route even when no model is configured, with a nonexistent identifier. Never autoload another model.
const ask: DecisionAsk = {
  strategy: "Read-only connection test. Market has no setup. Select WAIT.",
  state: {
    connectionTest: true,
    market: "No confirmed trend or breakout",
    mode: "PAPER; no execution",
  },
  menu: {
    WAIT: { desc: "Keep cash", intent: { kind: "hold" } },
    OPEN_TEST: {
      desc: "Hypothetical entry; never executed",
      intent: { kind: "hold" },
    },
  },
  convictionLabels: CONVICTION,
};
let routeProbe: unknown = null;
if (!loaded) {
  try {
    const r = await fetch(`${cfg.local.origin}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      signal: AbortSignal.timeout(cfg.local.timeoutMs),
      body: JSON.stringify({
        model: "catfolio-compatibility-probe-not-loaded",
        state: "Read-only route test",
        questions: {
          action: {
            type: "choice",
            instructions: "Select WAIT",
            criteria: { WAIT: null, HOLD: null },
          },
          conviction: {
            type: "score",
            instructions: "Signal strength",
            criteria: CONVICTION,
          },
        },
      }),
    });
    const body = (await r.json()) as { error?: unknown };
    routeProbe = {
      httpStatus: r.status,
      unexpectedEndpoint:
        typeof body.error === "string" &&
        body.error.includes("Unexpected endpoint or method"),
    };
    console.log("Read-only route probe:", routeProbe);
  } catch {
    routeProbe = { error: "Route probe unavailable" };
  }
}
const provider = new LmStudio({
  ...cfg.local,
  model: loaded ? cfg.local.model : "catfolio-compatibility-probe-not-loaded",
});
const result = await provider.decide(ask);
console.log(JSON.stringify(result, null, 2));
provider.close();
const evidence = join(dirname(cfg.settingsPath), "local-connection-check.json");
writePrivateJson(evidence, {
  checkedAt: new Date().toISOString(),
  local: { ...cfg.local, token: undefined },
  inventory,
  loaded,
  routeProbe,
  response: result,
});
console.log(`Saved read-only test evidence to ${evidence}`);
if (!loaded || !result.ok) {
  console.error(
    "NOT VERIFIED. Required: LM Studio exposing POST /v1/systemone, a decision-capable llama.cpp runtime, and a loaded Nimble decision GGUF. Choose its actual loaded instance id. Regular chat/MLX support is not sufficient. Update app AND runtime if the endpoint is unavailable. Re-run until both choice and ordered score validate; no provider fallback exists.",
  );
  process.exitCode = 1;
} else
  console.log(
    "PASS: real local choice AND score responses validated. No orders were placed. Save app/runtime/artifact versions and hash in .env for reproducibility.",
  );
