// Secret and personal-data guard. Every log line and every SSE event passes through here.

// A field is sensitive if any camelCase / snake_case / kebab-case word of its name is in this set.
const SENSITIVE_WORDS = new Set([
  "key", "apikey", "secret", "passphrase", "password", "token", "authorization", "auth", "signature", "sign",
  "cookie", "bearer", "uid", "subacct", "subaccount", "ip", "ipv4", "ipv6", "host", "hostname", "email",
  "addr", "address", "phone", "wallet",
]);

function isSensitiveKey(k: string): boolean {
  const words = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_\-.]+/);
  return words.some((w) => SENSITIVE_WORDS.has(w)) || SENSITIVE_WORDS.has(k.toLowerCase());
}

const MASK = "[redacted]";

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers and bearer tokens
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 " + MASK],
  // OK-ACCESS-* headers written inline
  [/(OK-ACCESS-(?:KEY|SIGN|PASSPHRASE|TIMESTAMP))["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "$1: " + MASK],
  // key=value / "key": "value" pairs with a sensitive name
  [/(["']?(?:api[_-]?key|secret[_-]?key|secret|passphrase|password|token|access[_-]?token|authorization|uid|subacct)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1" + MASK],
  // Email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // EVM / hex addresses and tx hashes
  [/\b0x[0-9a-fA-F]{16,}\b/g, "[hex]"],
  // IPv4 (not preceded or followed by a digit or dot, so prices like 1.2345 stay intact)
  [/(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g, "[ip]"],
  // IPv6 (at least 3 groups with ::, or 8 full groups)
  [/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, "[ip6]"],
  [/\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}:?){0,6}[0-9a-fA-F]{1,4}\b/g, "[ip6]"],
  // Home-directory paths that name a user
  [/\/(?:Users|home)\/[^/\s"']+/g, "~"],
  // UUIDs (OKX API keys are UUID-shaped)
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, MASK],
  // Long hex blobs (secrets, signatures)
  [/\b[0-9a-fA-F]{32,}\b/g, MASK],
  // Long base64 blobs (signatures are 44 chars of base64)
  [/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/])/g, MASK],
];

/** Mask secrets, IPs, emails, addresses and long blobs in a string. */
export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-redact any value. Sensitive field names are masked wholesale; strings are pattern-scrubbed. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return MASK as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value instanceof Error) return redactString(`${value.name}: ${value.message}`) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k) && v !== null && v !== undefined && typeof v !== "number" && typeof v !== "boolean") {
      out[k] = MASK;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out as T;
}

/**
 * OKX and Jev errors can echo request headers or account ids.
 * Reduce any error to `code + message`, then redact.
 */
export function safeError(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const code = String(e.code ?? e.status ?? e.name ?? "ERR");
    const msg = typeof e.message === "string" ? e.message : String(err);
    return { code: redactString(code).slice(0, 40), message: redactString(msg.split("\n")[0] ?? "").slice(0, 240) };
  }
  return { code: "ERR", message: redactString(String(err)).slice(0, 240) };
}
