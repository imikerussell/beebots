import type {
  DecisionAnswer,
  DecisionAsk,
  DecisionProvider,
  DecisionResult,
} from "./decision.js";

type ObjectValue = Record<string, unknown>;
export const object = (x: unknown, name: string): ObjectValue => {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new Error(`Malformed ${name}`);
  return x as ObjectValue;
};
const bounded = (x: unknown, max: number, name: string): number => {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > max)
    throw new Error(`Invalid ${name}`);
  return x;
};
export function probabilities(
  x: unknown,
  labels: string[],
): Record<string, number> {
  const p = object(x, "probabilities");
  if (
    Object.keys(p).length !== labels.length ||
    labels.some((l) => !Object.hasOwn(p, l))
  )
    throw new Error("Missing or extra probability entries");
  const out = Object.fromEntries(
    labels.map((l) => [l, bounded(p[l], 1, `probability ${l}`)]),
  );
  if (Math.abs(Object.values(out).reduce((a, b) => a + b, 0) - 1) > 0.001)
    throw new Error("Probabilities do not sum to one");
  return out;
}
export function validateResponse(
  raw: unknown,
  ask: DecisionAsk,
  model: string,
  latencyMs: number,
): DecisionAnswer {
  const r = object(raw, "response"),
    answers = object(r.answers, "answers");
  if (r.model !== model)
    throw new Error(
      "Response model identity does not match the configured model",
    );
  const a = object(answers.action, "action"),
    c = object(answers.conviction, "conviction");
  if (a.type !== "choice" || c.type !== "score")
    throw new Error("Incompatible choice/score response types");
  const labels = Object.keys(ask.menu);
  if (typeof a.choice !== "string" || !labels.includes(a.choice))
    throw new Error("Choice is not in the submitted menu");
  const p = probabilities(a.probabilities, labels);
  if (p[a.choice]! + 0.001 < Math.max(...Object.values(p)))
    throw new Error("Choice is not a highest probability option");
  const levels = ask.convictionLabels.map((_, i) => String(i));
  const sp = probabilities(c.probabilities, levels);
  const score = bounded(c.score, levels.length - 1, "conviction score");
  const expected = levels.reduce((sum, l) => sum + Number(l) * sp[l]!, 0);
  if (Math.abs(score - expected) > 0.01)
    throw new Error("Score disagrees with score probabilities");
  const legend = object(c.legend, "score legend");
  if (levels.some((l) => legend[l] !== ask.convictionLabels[Number(l)]))
    throw new Error("Score legend does not match ordered rubric");
  const usage = object(r.usage, "usage");
  const tokens = bounded(
    usage.input_tokens,
    Number.MAX_SAFE_INTEGER,
    "input tokens",
  );
  return {
    ok: true,
    choice: a.choice,
    probabilities: p,
    confidence: bounded(a.confidence, 1, "action confidence"),
    convictionRaw: score,
    conviction: score,
    scoreProbabilities: sp,
    scoreConfidence: bounded(c.confidence, 1, "score confidence"),
    inputTokens: tokens,
    latencyMs,
    model,
    source: "model",
  };
}

export interface SystemOneOptions {
  origin: string;
  model: string;
  token?: string;
  timeoutMs: number;
  concurrency: number;
  maxOptions: number;
  label: string;
  requireToken?: boolean;
  configurationHint: string;
}
export interface SystemOneHooks {
  preflight?: (
    signal: AbortSignal,
    fetcher: typeof fetch,
    headers: Record<string, string>,
  ) => Promise<Record<string, unknown>>;
  beforeRequest?: () => void;
  observeResponse?: (raw: unknown, status: number) => number;
}

/** One bounded client is shared by both cats. Timeout includes queue wait; abort removes queued work. */
export class SystemOneClient implements DecisionProvider {
  private active = 0;
  private queue: Array<() => void> = [];
  private controllers = new Set<AbortController>();
  private stopped = false;
  private stats = {
    requests: 0,
    failures: 0,
    latencyMs: null as number | null,
    connected: false,
    error: null as string | null,
  };
  constructor(
    private opts: SystemOneOptions,
    private fetcher: typeof fetch = fetch,
    private hooks: SystemOneHooks = {},
  ) {}
  status() {
    return {
      provider: this.opts.label,
      model: this.opts.model,
      ...this.stats,
    };
  }
  close() {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
  }
  private acquire(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.queue = this.queue.filter((f) => f !== take);
        reject(new Error("Inference timed out or stopped"));
      };
      const take = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) return abort();
        this.active++;
        resolve();
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      if (this.active < this.opts.concurrency) take();
      else this.queue.push(take);
    });
  }
  async decide(ask: DecisionAsk): Promise<DecisionResult> {
    const start = performance.now();
    const labels = Object.keys(ask.menu);
    // Endpoint choice minimum is two. Never invent a second choice or send an invalid singleton.
    if (labels.length === 1 && ask.menu[labels[0]!]!.intent.kind === "hold") {
      return {
        ok: true,
        choice: labels[0]!,
        probabilities: { [labels[0]!]: 1 },
        confidence: 1,
        conviction: 0,
        convictionRaw: 0,
        scoreProbabilities: {},
        scoreConfidence: 0,
        inputTokens: 0,
        latencyMs: 0,
        model: "deterministic-rules",
        source: "rules",
      };
    }
    if (
      labels.length < 2 ||
      labels.length > this.opts.maxOptions ||
      ask.convictionLabels.length < 2 ||
      ask.convictionLabels.length > 10
    )
      return { ok: false, reason: "invalid_menu_or_rubric", latencyMs: 0 };
    if (
      this.stopped ||
      !this.opts.model ||
      (this.opts.requireToken && !this.opts.token)
    ) {
      this.stats.connected = false;
      this.stats.failures++;
      this.stats.error = this.opts.configurationHint;
      return {
        ok: false,
        reason: "not_configured",
        error: { code: "MODEL", message: this.stats.error },
        latencyMs: 0,
      };
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let acquired = false;
    let costUsd = 0;
    try {
      await this.acquire(controller.signal);
      acquired = true;
      if (performance.now() - start >= this.opts.timeoutMs) {
        controller.abort();
        throw new Error("Queue deadline expired");
      }
      const headers = {
        "Content-Type": "application/json",
        ...(this.opts.token
          ? { Authorization: `Bearer ${this.opts.token}` }
          : {}),
      };
      this.hooks.beforeRequest?.();
      this.stats.requests++;
      const loaded = await this.hooks.preflight?.(
        controller.signal,
        this.fetcher,
        headers,
      );
      const response = await this.fetcher(`${this.opts.origin}/v1/systemone`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: this.opts.model,
          state: ask.state,
          questions: {
            action: {
              type: "choice",
              instructions: `${ask.strategy} Select exactly one action from the current menu. WAIT and HOLD are valid.`,
              criteria: Object.fromEntries(
                labels.map((l) => [l, ask.menu[l]!.desc]),
              ),
            },
            conviction: {
              type: "score",
              instructions:
                "Rate the overall strength of the market setup using this ordered rubric. This question is independent of the action choice; it is not a profit probability.",
              criteria: ask.convictionLabels,
            },
          },
        }), // No temperature override: preserve the artifact's scoring calibration.
      });
      const raw: unknown = await response.json();
      costUsd = this.hooks.observeResponse?.(raw, response.status) ?? 0;
      if (controller.signal.aborted)
        throw new Error("Inference timed out; result discarded");
      if (!response.ok || (raw && typeof raw === "object" && "error" in raw)) {
        throw new Error(
          `${this.opts.label} HTTP ${response.status}: /v1/systemone choice/score unavailable or rejected. ${this.opts.configurationHint}. No fallback.`,
        );
      }
      const result = validateResponse(
        raw,
        ask,
        this.opts.model,
        Math.round(performance.now() - start),
      );
      result.metadata = loaded;
      result.costUsd = costUsd;
      this.stats.connected = true;
      this.stats.error = null;
      this.stats.latencyMs = result.latencyMs;
      return result;
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      // Do not include server response bodies, request headers, or authentication tokens in logs.
      const message = controller.signal.aborted
        ? "Inference timed out or stopped; request cancelled"
        : err instanceof Error
          ? err.message
          : "Inference failed";
      this.stats.failures++;
      this.stats.connected = false;
      this.stats.error = message;
      this.stats.latencyMs = latencyMs;
      return {
        ok: false,
        reason: controller.signal.aborted
          ? "timeout"
          : "incompatible_or_unavailable",
        error: { code: "INFERENCE", message },
        costUsd,
        latencyMs,
      };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      if (acquired) {
        this.active--;
        this.queue.shift()?.();
      }
    }
  }
}
