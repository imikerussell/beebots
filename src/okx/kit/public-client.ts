// Vendored from OKX Agent Trade Kit (github.com/okx/agent-trade-kit, MIT, see ./LICENSE),
// packages/core/src/client/rest-client.ts as shipped in @okx_ai/okx-trade-cli 1.4.8 (recovered from its source map).
//
// This is the kit's `OkxRestClient.publicGet()` path only, the one `okx market ...` runs for every public call:
// same query-string builder, same headers, same `x-simulated-trading` rule, same client-side token-bucket rate
// limiter, same response/error handling (code "0"/"1" = ok, 50011/50061 = RateLimitError, anything else =
// OkxApiError). Left out on purpose: signing and OAuth (public calls carry no auth), the Pilot proxy resolver (it
// spawns a helper binary, and on EEA it resolves to a direct connection anyway), the proxy agent and verbose logging.
// One addition: a bare HTTP 429 (no OKX code in the body) is also a RateLimitError, so the caller can back off.

import { NetworkError, OkxApiError, RateLimitError } from "./errors.js";
import { RateLimiter, type RateLimitConfig } from "./rate-limiter.js";

export type QueryValue = string | number | boolean | string[] | number[] | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface OkxApiResponse<TData> {
  code?: string;
  msg?: string;
  data?: TData;
}

export interface RequestResult<TData> {
  endpoint: string;
  requestTime: string;
  data: TData;
  raw: OkxApiResponse<TData>;
}

export interface PublicClientConfig {
  /** e.g. https://eea.okx.com (the kit's `site = "eea"` base URL). */
  baseUrl: string;
  timeoutMs: number;
  userAgent?: string;
  site?: string;
}

// Subset of the kit's OKX_CODE_BEHAVIORS table that a public GET can hit.
export const RETRYABLE_OKX_CODES = new Set(["50011", "50061", "50001", "50004", "50013", "50026"]);

function isDefined(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function extractTraceId(headers: Headers): string | undefined {
  return headers.get("x-trace-id") ?? headers.get("x-request-id") ?? headers.get("traceid") ?? undefined;
}

function stringifyQueryValue(value: QueryValue): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(",");
  }
  return String(value);
}

export function buildQueryString(query?: QueryParams): string {
  if (!query) {
    return "";
  }

  const entries = Object.entries(query).filter(([, value]) => isDefined(value));
  if (entries.length === 0) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    params.set(key, stringifyQueryValue(value));
  }
  return params.toString();
}

export class OkxPublicClient {
  private readonly rateLimiter: RateLimiter;
  private readonly fetchFn: typeof globalThis.fetch;

  public constructor(
    private readonly config: PublicClientConfig,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.rateLimiter = new RateLimiter(30_000, false);
  }

  public get baseUrl(): string {
    return this.config.baseUrl;
  }

  /** GET, never HEAD (AGENTS.md hard rule 7). No auth headers, no keys. */
  public async publicGet<TData = unknown>(
    path: string,
    query?: QueryParams,
    rateLimit?: RateLimitConfig,
    simulatedTrading?: boolean,
  ): Promise<RequestResult<TData>> {
    const queryString = buildQueryString(query);
    const requestPath = queryString.length > 0 ? `${path}?${queryString}` : path;
    const url = `${this.config.baseUrl}${requestPath}`;

    if (rateLimit) {
      await this.rateLimiter.consume(rateLimit);
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    if (this.config.userAgent) {
      headers.set("User-Agent", this.config.userAgent);
    }
    if (simulatedTrading) {
      headers.set("x-simulated-trading", "1");
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, { method: "GET", headers, signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (error) {
      throw new NetworkError(`Failed to call OKX endpoint GET ${requestPath}.`, `GET ${requestPath}`, error);
    }

    const rawText = await response.text();
    const traceId = extractTraceId(response.headers);
    return this.processResponse<TData>(rawText, response, traceId, path, requestPath);
  }

  private throwOkxError(code: string, msg: string | undefined, path: string, traceId: string | undefined, fallbackSuggestion?: string): never {
    const message = msg && msg.trim() !== "" ? msg : `OKX API rejected request (code ${code}).`;
    const endpoint = `GET ${path}`;
    if (code === "50011" || code === "50061") {
      throw new RateLimitError(message, "Rate limited. Back off and retry after a delay.", endpoint, traceId);
    }
    throw new OkxApiError(message, { code, endpoint, suggestion: fallbackSuggestion, traceId });
  }

  private processResponse<TData>(rawText: string, response: Response, traceId: string | undefined, path: string, requestPath: string): RequestResult<TData> {
    let parsed: OkxApiResponse<TData>;
    try {
      parsed = (rawText ? JSON.parse(rawText) : {}) as OkxApiResponse<TData>;
    } catch (error) {
      if (!response.ok) {
        const messagePreview = rawText.slice(0, 160).replace(/\s+/g, " ").trim();
        if (response.status === 429) throw new RateLimitError(`HTTP 429 from OKX: ${messagePreview || "Too Many Requests"}`, undefined, `GET ${path}`, traceId);
        throw new OkxApiError(`HTTP ${response.status} from OKX: ${messagePreview || "Non-JSON response body"}`, {
          code: String(response.status),
          endpoint: `GET ${path}`,
          suggestion: "Verify endpoint path and request parameters.",
          traceId,
        });
      }
      throw new NetworkError(`OKX returned non-JSON response for GET ${requestPath}.`, `GET ${requestPath}`, error);
    }

    if (!response.ok) {
      if (parsed.code && parsed.code !== "0" && parsed.code !== "1") {
        this.throwOkxError(parsed.code, parsed.msg, path, traceId, "Retry later or verify endpoint parameters.");
      }
      if (response.status === 429) throw new RateLimitError(`HTTP 429 from OKX: ${parsed.msg ?? "Too Many Requests"}`, undefined, `GET ${path}`, traceId);
      throw new OkxApiError(`HTTP ${response.status} from OKX: ${parsed.msg ?? "Unknown error"}`, {
        code: String(response.status),
        endpoint: `GET ${path}`,
        suggestion: "Retry later or verify endpoint parameters.",
        traceId,
      });
    }

    const responseCode = parsed.code;
    if (responseCode && responseCode !== "0" && responseCode !== "1") {
      this.throwOkxError(responseCode, parsed.msg, path, traceId);
    }

    return {
      endpoint: `GET ${path}`,
      requestTime: new Date().toISOString(),
      data: (parsed.data ?? null) as TData,
      raw: parsed,
    };
  }
}
