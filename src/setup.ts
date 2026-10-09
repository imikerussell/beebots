// Local, editable profiles. No cloud account, generated personality, portrait or remote rule rewriting.
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { saveSettings, type Settings } from "./settings.js";
export function setup(path: string): void {
  if (existsSync(path))
    throw new Error(
      `Preserving existing ${path}. Edit it directly or choose a new SETTINGS_PATH.`,
    );
  const cfg = loadConfig();
  const s: Settings = {
    version: 2,
    cats: [
      { id: "tiger", name: cfg.slots.tiger.name, rules: cfg.slots.tiger.rules },
      { id: "mochi", name: cfg.slots.mochi.name, rules: cfg.slots.mochi.rules },
    ],
  };
  saveSettings(path, s);
}
