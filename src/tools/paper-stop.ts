import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
const cfg = loadConfig();
if (cfg.mode !== "dry") throw new Error("This command only closes PAPER runs");
writeFileSync(
  `${cfg.dbPath}.stop`,
  "Close all paper positions and open no new exposure\n",
  { mode: 0o600 },
);
console.log(
  "Close requested. Keep the engine running until /snapshot shows closed.flat=true. It needs fresh market data to simulate exits.",
);
