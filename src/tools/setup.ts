import { loadConfig } from "../config.js";
import { setup } from "../setup.js";
const cfg = loadConfig();
setup(cfg.settingsPath);
console.log(
  `Created ${cfg.settingsPath} with editable Tiger and Mochi profiles.\nEdit .env to select LM_STUDIO_MODEL, then run pnpm local:check. No keys or generated portraits are required.`,
);
