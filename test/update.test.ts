import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";
import { compareVersions, UpdateCheck } from "../src/update.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

const RELEASE = { tag_name: "v2026.10.02", html_url: "https://github.com/imikerussell/beebots/releases/tag/v2026.10.02", draft: false, prerelease: false };

describe("update check", () => {
  it("compares dotted date versions numerically, with or without a v", () => {
    expect(compareVersions("2026.10.02", "2026.09.25")).toBe(1);
    expect(compareVersions("v2026.09.25", "2026.09.25")).toBe(0);
    expect(compareVersions("2026.09.25", "2026.09.25.1")).toBe(-1);
    expect(compareVersions("2026.10.1", "2026.9.30")).toBe(1);
    expect(compareVersions("dev", "2026.09.25")).toBeNull();
  });

  it("reports a newer release", async () => {
    const u = new UpdateCheck({ repo: "imikerussell/beebots", current: "2026.09.25", enabled: true, fetch: fakeFetch(200, RELEASE) });
    await u.check();
    expect(u.status()).toEqual({ current: "2026.09.25", latest: "2026.10.02" });
  });

  it("stays quiet on the same or an older release, drafts and pre-releases", async () => {
    for (const [current, rel] of [
      ["2026.10.02", RELEASE],
      ["2026.11.01", RELEASE],
      ["2026.09.25", { ...RELEASE, prerelease: true }],
      ["2026.09.25", { ...RELEASE, draft: true }],
    ] as const) {
      const u = new UpdateCheck({ repo: "imikerussell/beebots", current, enabled: true, fetch: fakeFetch(200, rel) });
      await u.check();
      expect(u.status()).toBeNull();
    }
  });

  it("never nags a dev build, a disabled check, or when GitHub fails", async () => {
    for (const [current, enabled, f] of [
      ["dev", true, fakeFetch(200, RELEASE)],
      ["2026.09.25", false, fakeFetch(200, RELEASE)],
      ["2026.09.25", true, fakeFetch(404, { message: "Not Found" })],
      ["2026.09.25", true, (async () => { throw new Error("offline"); }) as unknown as typeof fetch],
    ] as const) {
      const u = new UpdateCheck({ repo: "imikerussell/beebots", current, enabled, fetch: f });
      await u.check();
      expect(u.status()).toBeNull();
    }
  });

  it("ignores a tag that is not a version", async () => {
    const u = new UpdateCheck({ repo: "imikerussell/beebots", current: "2026.09.25", enabled: true, fetch: fakeFetch(200, { ...RELEASE, tag_name: "<script>" }) });
    await u.check();
    expect(u.status()).toBeNull();
  });

  it("survives the response redaction the dashboard gets", async () => {
    const u = new UpdateCheck({ repo: "imikerussell/beebots", current: "2026.09.25", enabled: true, fetch: fakeFetch(200, RELEASE) });
    await u.check();
    expect(redact({ update: u.status() })).toEqual({ update: u.status() });
  });
});
