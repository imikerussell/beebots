import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../src/setup.js";
import { loadSettings } from "../src/settings.js";
describe("local setup", () => {
  it("writes exactly two editable local profiles without cloud keys, preserving existing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cats-setup-")),
      path = join(dir, "settings.json");
    vi.stubEnv("MODE", "paper");
    try {
      setup(path);
      const settings = loadSettings(path)!;
      expect(settings.cats.map((c) => c.id)).toEqual(["tiger", "mochi"]);
      expect(readFileSync(path, "utf8")).not.toMatch(/Key|token|OpenAI|Jev/);
      expect(() => setup(path)).toThrow(/Preserving existing/);
      const legacy = '{"version":1,"bees":[{},{},{}]}';
      writeFileSync(path, legacy);
      expect(() => loadSettings(path)).toThrow(/choose a NEW/);
      expect(readFileSync(path, "utf8")).toBe(legacy);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
