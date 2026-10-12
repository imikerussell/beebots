import type { Config } from "./config.js";
import { SystemOneClient } from "./systemone.js";
export interface JevBudget {
  spent(day: string): number;
  charge(day: string, usd: number): void;
}
/** Explicit hosted backend. No SDK required: the documented HTTP contract matches System One. */
export class Jev extends SystemOneClient {
  constructor(
    opts: Config["jev"],
    budget?: JevBudget,
    fetcher: typeof fetch = fetch,
    now = Date.now,
  ) {
    const totals = new Map<string, number>();
    const ledger = budget ?? {
      spent: (d: string) => totals.get(d) ?? 0,
      charge: (d: string, usd: number) => {
        totals.set(d, (totals.get(d) ?? 0) + usd);
      },
    };
    const day = () => new Date(now()).toISOString().slice(0, 10);
    let backoffUntil = 0;
    super(
      {
        origin: opts.origin,
        model: opts.model,
        token: opts.apiKey,
        timeoutMs: opts.timeoutMs,
        concurrency: opts.concurrency,
        maxOptions: 26,
        label: opts.transport === "vercel" ? "Jev cloud (Vercel)" : "Jev cloud",
        requireToken: true,
        // TypeSafe's API rounds probabilities and scores to two decimal places.
        // https://github.com/vercel/ai/blob/main/packages/typesafe-ai/src/typesafe-ai-decision-model.ts
        responseDecimals: 2,
        configurationHint:
          opts.transport === "vercel"
            ? "Set AI_GATEWAY_API_KEY and JEV_MODEL=typesafe-ai/jev"
            : "Set TYPESAFE_API_KEY and a supported pinned JEV_MODEL",
      },
      fetcher,
      {
        beforeRequest: () => {
          if (ledger.spent(day()) >= opts.dailyUsdCap)
            throw new Error(
              "Jev estimated daily API budget reached; new model requests paused, protective checks continue",
            );
          if (now() < backoffUntil)
            throw new Error(
              "Jev rate-limit backoff; protective checks continue",
            );
        },
        observeStatus: (status) => {
          if (status === 429 || status >= 500) backoffUntil = now() + 60000;
        },
        observeResponse: (raw) => {
          const tokens = (raw as { usage?: { input_tokens?: unknown } } | null)
            ?.usage?.input_tokens;
          if (
            typeof tokens !== "number" ||
            !Number.isFinite(tokens) ||
            tokens < 0
          )
            return 0;
          const cost = (tokens * opts.usdPerMTok) / 1e6;
          ledger.charge(day(), cost);
          return cost;
        },
      },
    );
    this.budgetStatus = () => ({
      estimatedSpentTodayUsd: ledger.spent(day()),
      dailyUsdCap: opts.dailyUsdCap,
      retryAt: backoffUntil > now() ? backoffUntil : null,
    });
  }
  private budgetStatus: () => {
    estimatedSpentTodayUsd: number;
    dailyUsdCap: number;
    retryAt: number | null;
  };
  override status() {
    return { ...super.status(), ...this.budgetStatus() };
  }
}
