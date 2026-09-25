// "Update available": checks the repo's latest GitHub Release a few times a day and tells the dashboard when it is newer
// than the version baked into this image (APP_VERSION, set by the release build). Read-only: it never installs anything.
// Builds without a version (local builds, "dev") never nag. UPDATE_CHECK=false turns it off.
import { log } from "./log.js";

const FIRST_CHECK_MS = 60_000;
const EVERY_MS = 6 * 3_600_000;
const TIMEOUT_MS = 15_000;

/** No URL on purpose: every response passes through redact(), which masks long path-like strings. The dashboard links to
 *  <REPO_LINK>/releases/latest itself. */
export interface UpdateStatus {
  current: string;
  latest: string;
}

/** "v2026.09.25" and "2026.09.25" are the same release. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/** Numeric compare of dotted versions (2026.09.25 < 2026.10.1 < 2026.10.1.1). Null when either side is not numeric. */
export function compareVersions(a: string, b: string): number | null {
  const pa = normalizeVersion(a).split(".");
  const pb = normalizeVersion(b).split(".");
  if (![...pa, ...pb].every((p) => /^\d+$/.test(p))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export class UpdateCheck {
  private timer: NodeJS.Timeout | null = null;
  private latest: string | null = null;

  constructor(
    private opts: { repo: string; current: string; enabled: boolean; fetch?: typeof fetch },
  ) {}

  /** Whether this build can be checked at all (a release build with a numeric version). */
  get active(): boolean {
    return this.opts.enabled && /^\d+(\.\d+)*$/.test(normalizeVersion(this.opts.current)) && /^[\w.-]+\/[\w.-]+$/.test(this.opts.repo);
  }

  start(): void {
    if (!this.active) return;
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** What the dashboard shows: null unless a newer release exists. */
  status(): UpdateStatus | null {
    if (!this.active || !this.latest) return null;
    if (compareVersions(this.latest, this.opts.current) !== 1) return null;
    return { current: normalizeVersion(this.opts.current), latest: normalizeVersion(this.latest) };
  }

  async check(): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    try {
      const res = await f(`https://api.github.com/repos/${this.opts.repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "beebots-update-check" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        log.debug("update check: no release", { status: res.status });
        return;
      }
      const j = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
      if (typeof j.tag_name !== "string" || j.draft === true || j.prerelease === true) return;
      if (compareVersions(j.tag_name, "0") === null) return;
      this.latest = j.tag_name;
      const s = this.status();
      if (s) log.info("update available", { current: s.current, latest: s.latest });
    } catch (err) {
      log.debug("update check failed", { err: String(err) });
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule(EVERY_MS));
    }, ms);
    this.timer.unref?.();
  }
}
