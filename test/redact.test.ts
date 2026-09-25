import { describe, expect, it } from "vitest";
import { redact, redactString, safeError } from "../src/redact.js";

describe("redact masks what must never be on camera", () => {
  it("masks a UUID-shaped API key", () => {
    expect(redactString("key 3f2b9c1e-8a4d-4f6b-9e2a-1c7d5b8e0f3a used")).not.toMatch(/3f2b9c1e/);
  });
  it("masks secret-named fields wholesale", () => {
    const out = redact({ apiKey: "abc", secret_key: "def", passphrase: "p@ss", OK_ACCESS_SIGN: "sig", authorization: "Bearer xyz" });
    expect(Object.values(out)).toEqual(["[redacted]", "[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
  });
  it("masks bearer tokens and OK-ACCESS headers inline", () => {
    expect(redactString("Authorization: Bearer ts_live_abcdefghijklmnop")).not.toMatch(/abcdefghijklmnop/);
    expect(redactString('"OK-ACCESS-PASSPHRASE": "hunter2"')).not.toMatch(/hunter2/);
  });
  it("masks IPv4, IPv6, emails and 0x addresses", () => {
    const s = redactString("from 203.0.113.42 and 192.168.1.10 via 2001:0db8:85a3:0000:0000:8a2e:0370:7334 mail a.person@example.com to 0x52908400098527886E0F7030069857D2E4169EE7");
    expect(s).not.toMatch(/203\.0\.113\.42|192\.168|2001:0db8|example\.com|52908400/);
  });
  it("masks long base64 signatures and hex secrets", () => {
    expect(redactString("sign=dGhpcyBpcyBhIHZlcnkgc2VjcmV0IHNpZ25hdHVyZQ==")).not.toMatch(/dGhpcyBp/);
    expect(redactString("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe("[redacted]");
  });
  it("masks home directory paths and account ids", () => {
    expect(redactString("/Users/someone/.okx/config.toml")).toBe("~/.okx/config.toml");
    expect(redact({ uid: "123456789", subAcct: "mybee01" })).toEqual({ uid: "[redacted]", subAcct: "[redacted]" });
  });
});

describe("redact leaves normal trading data alone", () => {
  it("keeps prices, sizes and instrument ids", () => {
    const ev = { bee: "boozy-bee", coin: "PENGU", instId: "PENGU-USD_UM_XPERP-310711", px: 0.012345, notionalUsd: 220.5, feeUsd: 0.11, description: "flip", tokens: 312 };
    expect(redact(ev)).toEqual(ev);
  });
  it("keeps BTC prices, version strings and times", () => {
    for (const s of ["BTC 84461.8", "jev-1.13.0", "1.2345", "12:00", "rsi 28.1 pctB -0.05", "latency 412 ms"]) expect(redactString(s)).toBe(s);
  });
  it("keeps order ids and clOrdIds", () => {
    expect(redactString("ordId 2891203987612390912 clOrdId bimfgx1k2b01")).toBe("ordId 2891203987612390912 clOrdId bimfgx1k2b01");
  });
});

describe("safeError", () => {
  it("reduces an error to code + first line, redacted", () => {
    const e = Object.assign(new Error("Unauthorized for 203.0.113.9\nheaders: OK-ACCESS-KEY: 3f2b9c1e-8a4d-4f6b-9e2a-1c7d5b8e0f3a"), { code: "50113" });
    const s = safeError(e);
    expect(s.code).toBe("50113");
    expect(s.message).toBe("Unauthorized for [ip]");
  });
});
