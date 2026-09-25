// Read-only: currencies held in each bee's DEMO trading and funding accounts. Prints currency + amount only.
import { BEES } from "../config.js";
import { createOkxCli } from "../okx/cli.js";
import { safeError } from "../redact.js";

const cli = createOkxCli({ site: "eea", timeoutMs: 10_000, maxConcurrent: 2 });
for (const bee of BEES) {
  const p = bee.toUpperCase();
  const creds = { apiKey: process.env[`${p}_OKX_DEMO_API_KEY`] ?? "", secretKey: process.env[`${p}_OKX_DEMO_API_SECRET`] ?? "", passphrase: process.env[`${p}_OKX_DEMO_API_PASSPHRASE`] ?? "" };
  const run = <T>(args: string[]) => cli.run<T>({ args, bee, creds, demo: true });
  const fmt = (rows: Array<Record<string, string>>, amt: string) =>
    rows.filter((r) => Number(r[amt]) > 0).map((r) => `${r.ccy} ${Number(r[amt]).toLocaleString("en-US", { maximumFractionDigits: 4 })}`).join(", ") || "empty";
  try {
    const [bal] = await run<Array<{ details?: Array<Record<string, string>> }>>(["account", "balance"]);
    const funding = await run<Array<Record<string, string>>>(["account", "asset-balance"]).catch(() => null);
    console.log(`${bee.padEnd(6)} trading: ${fmt(bal?.details ?? [], "eq")}`);
    console.log(`${"".padEnd(6)} funding: ${funding ? fmt(funding, "bal") : "not readable"}`);
  } catch (err) {
    const e = safeError(err);
    console.log(`${bee.padEnd(6)} FAILED ${e.code} ${e.message}`);
  }
}
