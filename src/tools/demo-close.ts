// DEMO only: close whatever X-Perp each bee holds on OKX demo with a reduce-only market order,
// then check it is flat and reconcile fees for its recent orders against OKX fills.
// pnpm demo:close
import { BEES, type OkxCreds } from "../config.js";
import { OkxExecutor } from "../exec/executor.js";
import { createOkxCli } from "../okx/cli.js";
import { createPublicApi } from "../okx/public.js";
import { safeError } from "../redact.js";

type Row = Record<string, string>;
const env = process.env;
const creds: Partial<Record<(typeof BEES)[number], OkxCreds>> = {};
for (const b of BEES) {
  const p = b.toUpperCase();
  creds[b] = { apiKey: env[`${p}_OKX_DEMO_API_KEY`] ?? "", secretKey: env[`${p}_OKX_DEMO_API_SECRET`] ?? "", passphrase: env[`${p}_OKX_DEMO_API_PASSPHRASE`] ?? "" };
}
const cli = createOkxCli({ site: "eea", timeoutMs: 15_000, maxConcurrent: 2 });
const instruments = new Map((await createPublicApi("https://eea.okx.com", true).instruments()).map((i) => [i.instId, i]));
const exec = new OkxExecutor(cli, creds, true, (id) => instruments.get(id), 2); // demo hard-wired
const run = (bee: (typeof BEES)[number], args: string[]) => cli.run<Row[]>({ args, bee, creds: creds[bee], demo: true });
let problems = 0;

for (const bee of BEES) {
  try {
    const held = (await run(bee, ["futures", "positions"])).filter((r) => Number(r.pos) !== 0);
    for (const p of held) {
      const inst = instruments.get(p.instId!);
      const qty = Math.abs(Number(p.pos));
      const res = await exec.market(bee, { instId: p.instId!, side: Number(p.pos) > 0 ? "sell" : "buy", contracts: qty, reduceOnly: true, clOrdId: `${bee.slice(0, 2)}tc${Date.now().toString(36)}` });
      if (!res.ok) {
        problems++;
        console.log(`${bee.padEnd(6)} ✗ close ${inst?.coin} failed: ${res.error.code} ${res.error.message}`);
        continue;
      }
      const entry = Number(p.avgPx);
      const realised = (Number(p.pos) > 0 ? 1 : -1) * (res.avgPx - entry) * qty * (inst?.ctVal ?? 0);
      console.log(`${bee.padEnd(6)} ✓ closed ${qty} ${inst?.coin} @ ${res.avgPx} (entry ${entry}) · realised $${realised.toFixed(6)} · fee $${res.feeUsd.toFixed(6)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const left = (await run(bee, ["futures", "positions"])).filter((r) => Number(r.pos) !== 0);
    if (left.length) problems++;
    // Fees on the bee's filled orders (last 7 days) vs fills, to the cent.
    const orders = (await run(bee, ["futures", "orders", "--history"])).filter((o) => o.state === "filled");
    const ids = new Set(orders.map((o) => o.ordId!));
    const orderFees = orders.reduce((a, o) => a - Number(o.fee || 0), 0);
    const fillFees = await exec.feesFor(bee, [...new Set(orders.map((o) => o.instId!))], ids);
    const fillSum = fillFees ? [...fillFees.values()].reduce((a, b) => a + b, 0) : NaN;
    const match = Math.abs(orderFees - fillSum) < 0.005;
    if (!match) problems++;
    console.log(`${"".padEnd(6)} ${left.length ? "✗ still holds a position" : "✓ flat on OKX"} · ${orders.length} filled orders · order fees $${orderFees.toFixed(6)} vs fills $${fillSum.toFixed(6)} ${match ? "✓ match" : "✗ MISMATCH"}`);
  } catch (err) {
    problems++;
    const e = safeError(err);
    console.log(`${bee.padEnd(6)} ✗ error ${e.code} ${e.message}`);
  }
}
console.log(problems ? `\n${problems} problem(s)` : "\nall bees closed, flat, fees reconciled");
process.exit(problems ? 1 : 0);
