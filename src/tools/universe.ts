// Phase 2 check: print the gated X-Perp universe. Public data only, no keys.
// pnpm universe
import { gateUniverse } from "../market/universe.js";
import { createOkxCli } from "../okx/cli.js";
import { createPublicApi } from "../okx/public.js";

const minVol = Number(process.env.MIN_24H_VOL_USD || 1_000_000);
const cli = createOkxCli({ site: "eea", timeoutMs: 15_000 });
const demo = process.argv.includes("--demo");
const api = createPublicApi(cli, process.env.OKX_API_BASE || "https://eea.okx.com", demo);
if (demo) console.log("OKX DEMO market");

const [instruments, tickers] = await Promise.all([api.instruments(), api.tickers()]);
const live = instruments.filter((i) => i.state === "live");
const byKind = live.reduce<Record<string, number>>((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});
console.log(`X-Perps: ${instruments.length} total, ${live.length} live`, byKind);

for (const [label, gate] of [["boozy (15 bp)", Number(process.env.BOOZY_SPREAD_GATE_BPS || 15)], ["bizzy (5 bp)", Number(process.env.BIZZY_SPREAD_GATE_BPS || 5)]] as const) {
  const u = gateUniverse(instruments, tickers, { min24hVolUsd: minVol, spreadGateBps: gate, allowNonCrypto: false });
  console.log(`\n${label}: ${u.tradable.length} tradable, ${u.spreadBlocked.length} blocked by spread`);
  for (const id of u.tradable) {
    const t = tickers.get(id)!;
    const i = instruments.find((x) => x.instId === id)!;
    const minUsd = i.minSz * i.ctVal * t.last;
    console.log(`  ${id.padEnd(30)} vol $${(t.vol24hUsd / 1e6).toFixed(2).padStart(7)}M  spread ${t.spreadBp.toFixed(2).padStart(6)} bp  min $${minUsd.toFixed(2)}`);
  }
  if (u.spreadBlocked.length) console.log(`  spread-blocked: ${u.spreadBlocked.map((id) => `${id.split("-")[0]} ${tickers.get(id)!.spreadBp.toFixed(1)}bp`).join(", ")}`);
  if (u.unknown.length) console.log(`  unclassified (never traded): ${u.unknown.join(", ")}`);
}
