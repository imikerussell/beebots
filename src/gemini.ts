import { ArgonChooser } from "./argon.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { DecisionAsk, DecisionProvider, DecisionResult } from "./decision.js";

/** Catfolio adapter around the upstream Gemini chooser; no paid request happens during construction. */
export class Gemini implements DecisionProvider {
  private chooser: ArgonChooser;
  private shutdown = new AbortController();
  private requests = 0;
  private failures = 0;
  private active = 0;
  private latencyMs: number | null = null;
  private lastRequestAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private error: string | null = null;
  constructor(private opts: Config["gemini"], db?: Db, fetcher: typeof fetch = fetch, private now = Date.now) {
    const day = new Date(now());
    const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    this.chooser = new ArgonChooser({ ...opts, provider: "gemini", now, signal: this.shutdown.signal,
      spentTodayUsd: db?.chooserSpendSince(midnight) ?? 0,
      ledger: db,
      fetchFn: async (input, init) => {
        this.requests++; this.active++; this.lastRequestAt = now();
        try { return await fetcher(input, init); }
        finally { this.active--; }
      },
    });
  }
  async decide(ask: DecisionAsk): Promise<DecisionResult> {
    if (this.shutdown.signal.aborted) return { ok: false, reason: "provider_closed", latencyMs: 0 };
    const result = await this.chooser.decide(ask);
    if (this.shutdown.signal.aborted) return {ok:false,reason:"provider_closed",latencyMs:result.latencyMs,costUsd:result.ok ? result.costUsd : 0};
    this.latencyMs = result.latencyMs;
    if (!result.ok) { this.failures++; this.error = result.error?.message ?? result.reason; return result; }
    if (result.source === "gemini") { this.lastSuccessAt = this.now(); this.error = null; }
    else if (["timeout", "error", "off_menu"].includes(result.fallbackReason ?? "")) {
      this.failures++; this.error = `Gemini ${result.fallbackReason}; code chooser active`;
    }
    return { ...result, source: result.source === "gemini" ? "model" : result.source === "rules" ? "rules" : "code",
      decidedBy: result.source === "gemini" ? "gemini" : result.source === "rules" ? "rules" : "code",
      scoreProbabilities: {}, scoreConfidence: result.confidence,
      metadata: { probabilityKind: "self_reported", fallbackReason: result.fallbackReason ?? null },
    };
  }
  status() {
    // Reading capTripped rolls the chooser to the current UTC day.
    void this.chooser.capTripped;
    return { provider: "gemini", model: this.opts.model, requests: this.requests, failures: this.failures,
      latencyMs: this.latencyMs, connected: this.lastSuccessAt !== null && !this.error,
      error: this.error, lastRequestAt: this.lastRequestAt, lastSuccessAt: this.lastSuccessAt,
      activeRequests: this.active, queuedRequests: 0, estimatedSpentTodayUsd: this.chooser.spentTodayUsd,
      dailyUsdCap: this.opts.dailyUsdCap, reservedUsd: this.chooser.reservedUsd,
      budgetRefused: this.chooser.budgetRefusedToday, lastFallback: this.chooser.lastFallback,
      minIntervalMs: this.opts.minIntervalMs, probabilityKind: "self_reported" as const,
    };
  }
  close() { this.shutdown.abort(); }
}
