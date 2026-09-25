import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/gate.js";

describe("owner password hashing", () => {
  it("verifies the right password only", () => {
    const h = hashPassword("correct horse");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h).not.toContain("correct horse");
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("correct horsE", h)).toBe(false);
    expect(verifyPassword("", h)).toBe(false);
  });

  it("salts every hash", () => {
    expect(hashPassword("same password")).not.toBe(hashPassword("same password"));
  });

  it("refuses a malformed stored hash instead of throwing", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "md5$abc")).toBe(false);
    expect(verifyPassword("anything", "scrypt$0$0$0$x$y")).toBe(false);
  });
});
