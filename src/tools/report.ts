import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { Db } from "../db.js";
import { morningReport } from "../report.js";
const cfg = loadConfig();
if (!existsSync(cfg.dbPath)) throw new Error(`No run at ${cfg.dbPath}`);
const db = new Db(cfg.dbPath, true);
try {
  console.log(JSON.stringify(morningReport(db), null, 2));
} finally {
  db.close();
}
