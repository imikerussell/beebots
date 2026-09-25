// Is every bee flat on OKX? Reads positions and pending orders per bee for MODE (live or demo) straight from OKX.
// Exit 0 = all flat with nothing pending. Prints coin, side and size only; never keys, UIDs or IPs.
// node dist/tools/flat-check.js            check only (deploy/close.sh runs this after the engine winds down)
// node dist/tools/flat-check.js --close    fallback if the engine could not close: cancel pending orders and close
//                                          each position with a reduce-only market order, then check again
import { BEES, type OkxCreds } from "../config.js";
import { OkxExecutor } from "../exec/executor.js";
import { createOkxCli } from "../okx/cli.js";
import { createPublicApi } from "../okx/public.js";
import { safeError } from "../redact.js";

type Row = Record<string, string>;
const env = process.env;
const mode = env.MODE === "demo" ? "demo" : env.MODE === "live" ? "live" : null;
if (!mode || env.DRY_RUN === "true") {
  console.log("dry run: nothing is held on OKX");
  process.exit(0);
}
const demo = mode === "demo";
const infix = demo ? "OKX_DEMO_API" : "OKX_API";
const creds: Partial<Record<(typeof BEES)[number], OkxCreds>> = {};
for (const b of BEES) {
  const p = b.toUpperCase();
  creds[b] = { apiKey: env[`${p}_${infix}_KEY`] ?? "", secretKey: env[`${p}_${infix}_SECRET`] ?? "", passphrase: env[`${p}_${infix}_PASSPHRASE`] ?? "" };
}
const cli = createOkxCli({ site: "eea", timeoutMs: 15_000, maxConcurrent: 2 });
const run = (bee: (typeof BEES)[number], args: string[]) => cli.run<Row[]>({ args, bee, creds: creds[bee], demo });
const held = async (bee: (typeof BEES)[number]) => (await run(bee, ["futures", "positions"])).filter((r) => Number(r.pos) !== 0);
const pending = async (bee: (typeof BEES)[number]) => await run(bee, ["futures", "orders"]);

if (process.argv.includes("--close")) {
  const instruments = new Map((await createPublicApi(cli, env.OKX_API_BASE || "https://eea.okx.com", demo).instruments()).map((i) => [i.instId, i]));
  const exec = new OkxExecutor(cli, creds, demo, (id) => instruments.get(id), Number(env.MAX_LEVERAGE || 2));
  for (const bee of BEES) {
    try {
      for (const o of await pending(bee)) {
        await run(bee, ["futures", "cancel", o.instId!, "--ordId", o.ordId!]);
        console.log(`${bee.padEnd(6)} cancelled a pending order on ${o.instId!.split("-")[0]}`);
      }
      for (const p of await held(bee)) {
        const qty = Math.abs(Number(p.pos));
        const res = await exec.market(bee, { instId: p.instId!, side: Number(p.pos) > 0 ? "sell" : "buy", contracts: qty, reduceOnly: true, clOrdId: `${bee.slice(0, 2)}fc${Date.now().toString(36)}` });
        console.log(`${bee.padEnd(6)} ${res.ok ? `closed ${qty} ${p.instId!.split("-")[0]} @ ${res.avgPx}` : `close FAILED ${res.error.code} ${res.error.message}`}`);
      }
    } catch (err) {
      const e = safeError(err);
      console.log(`${bee.padEnd(6)} error ${e.code} ${e.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}

let problems = 0;
for (const bee of BEES) {
  try {
    const pos = await held(bee);
    const ords = await pending(bee);
    if (pos.length || ords.length) problems++;
    const desc = pos.map((p) => `${Number(p.pos) > 0 ? "long" : "short"} ${Math.abs(Number(p.pos))} ${p.instId!.split("-")[0]}`).join(", ");
    console.log(`${bee.padEnd(6)} ${mode} ${pos.length ? `HOLDS ${desc}` : "flat"} · ${ords.length} pending order(s)`);
  } catch (err) {
    problems++;
    const e = safeError(err);
    console.log(`${bee.padEnd(6)} ${mode} could not read OKX: ${e.code} ${e.message}`);
  }
}
console.log(problems ? `\nNOT FLAT: ${problems} bee(s) hold a position or pending order, or could not be read` : `\nall bees flat on OKX ${mode}, nothing pending`);
process.exit(problems ? 1 : 0);
