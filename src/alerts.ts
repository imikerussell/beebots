import { log } from "./log.js";
import { redactString, safeError } from "./redact.js";

/** POST a plain-text line to ALERT_WEBHOOK_URL (works as-is with ntfy.sh topics). Same text at most once per 10 min. */
export class Alerts {
  private sent = new Map<string, number>();

  constructor(private url: string | undefined) {}

  send(text: string, now = Date.now()): void {
    const t = redactString(`[beebots] ${text}`);
    log.warn("alert", { text: t });
    if (!this.url) return;
    const last = this.sent.get(t);
    if (last && now - last < 10 * 60_000) return;
    this.sent.set(t, now);
    fetch(this.url, { method: "POST", body: t, headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(5000) }).catch((err) =>
      log.warn("alert webhook failed", { err: safeError(err) }),
    );
  }
}
