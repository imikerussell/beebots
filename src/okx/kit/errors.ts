// Vendored from OKX Agent Trade Kit (github.com/okx/agent-trade-kit, MIT, see ./LICENSE),
// packages/core/src/utils/errors.ts as shipped in @okx_ai/okx-trade-cli 1.4.8 (recovered from its source map).
// Trimmed to the classes the public REST client uses; the class bodies are unchanged.

export type ErrorType =
  | "ConfigError"
  | "AuthenticationError"
  | "RateLimitError"
  | "ValidationError"
  | "OkxApiError"
  | "NetworkError"
  | "InternalError";

export class OkxMcpError extends Error {
  public readonly type: ErrorType;
  public readonly code?: string;
  public readonly suggestion?: string;
  public readonly endpoint?: string;
  public readonly traceId?: string;

  public constructor(
    type: ErrorType,
    message: string,
    options?: {
      code?: string;
      suggestion?: string;
      endpoint?: string;
      traceId?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = type;
    this.type = type;
    this.code = options?.code;
    this.suggestion = options?.suggestion;
    this.endpoint = options?.endpoint;
    this.traceId = options?.traceId;
  }
}

export class RateLimitError extends OkxMcpError {
  public constructor(
    message: string,
    suggestion?: string,
    endpoint?: string,
    traceId?: string,
  ) {
    super("RateLimitError", message, { suggestion, endpoint, traceId });
  }
}

export class OkxApiError extends OkxMcpError {
  public constructor(
    message: string,
    options?: {
      code?: string;
      suggestion?: string;
      endpoint?: string;
      traceId?: string;
      cause?: unknown;
    },
  ) {
    super("OkxApiError", message, options);
  }
}

export class NetworkError extends OkxMcpError {
  public constructor(message: string, endpoint?: string, cause?: unknown) {
    super("NetworkError", message, {
      endpoint,
      cause,
      suggestion:
        "Please check network connectivity and retry the request in a few seconds.",
    });
  }
}

