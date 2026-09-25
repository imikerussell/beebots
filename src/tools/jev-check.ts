// Phase 4 check: N real Jev calls on live snapshots (dry: no orders). Verifies cost = input_tokens x $/Mtok.
// pnpm jev:check [N=100]
import { BREEZY_COINS } from "../bees/breezy.js";
import { BRAINS } from "../bees/index.js";
import { loadConfig, STYLES as BEES, type BeeId } from "../config.js";
import { Jev } from "../jev.js";
import { freshBee } from "../ledger.js";
import { MarketFeed } from "../market/data.js";
import { createPublicApi } from "../okx/public.js";
import { buildSnapshot } from "../snapshot.js";

const N = Number(process.argv[2] ?? 100);
const cfg = loadConfig({ ...process.env, DRY_RUN: "true" });
const feed = new MarketFeed(
  createPublicApi(cfg.okx.apiBase),
  { min24hVolUsd: cfg.universe.min24hVolUsd, allowNonCrypto: false, spreadGateBps: Math.max(...BEES.map((b) => cfg.bees[b].spreadGateBps)), trendCoins: [...BREEZY_COINS] },
  null,
  () => [],
);
await feed.refresh();
// Allow for a real network round trip on this check; the engine keeps JEV_TIMEOUT_MS.
const jev = new Jev({ ...cfg.jev, timeoutMs: Math.max(cfg.jev.timeoutMs, 5000) });

type Row = { bee: string; ok: boolean; tokens: number; cost: number; latency: number; choice?: string; p?: number; err?: string };
const rows: Row[] = [];
for (let i = 0; i < N; i++) {
  const id = BEES[i % 3]!;
  const brain = BRAINS[id];
  const ctx = { bee: freshBee(id as unknown as BeeId, cfg.risk.startEquityUsd, Date.now() - 60_000), view: feed.view(), cfg, knobs: cfg.bees[id], now: Date.now(), uplR: null };
  const menu = brain.menu(ctx);
  const snap = buildSnapshot(brain, ctx);
  const r = await jev.decide({ strategy: brain.strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels });
  if (r.ok) rows.push({ bee: id, ok: true, tokens: r.inputTokens, cost: r.costUsd, latency: r.latencyMs, choice: r.choice, p: r.probabilities[r.choice] });
  else rows.push({ bee: id, ok: false, tokens: 0, cost: 0, latency: r.latencyMs, err: `${r.reason} ${r.error?.code ?? ""} ${r.error?.message ?? ""}` });
  if (i < 3 || !r.ok) console.log(i, id, r.ok ? `${r.choice} p=${r.probabilities[r.choice]!.toFixed(2)} conv=${brain.convictionLabels[r.conviction]} tokens=${r.inputTokens} ${r.latencyMs}ms model=${r.model}` : rows.at(-1)!.err);
}

const ok = rows.filter((r) => r.ok);
const lat = ok.map((r) => r.latency).sort((a, b) => a - b);
const pct = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0;
console.log(`\n${ok.length}/${N} ok, ${N - ok.length} failed`);
for (const id of BEES) {
  const b = ok.filter((r) => r.bee === id);
  // Phase 3, measured: same questions with an empty state gives the snapshot's own token cost.
  const brain = BRAINS[id];
  const ctx = { bee: freshBee(id as unknown as BeeId, cfg.risk.startEquityUsd, Date.now() - 60_000), view: feed.view(), cfg, knobs: cfg.bees[id], now: Date.now(), uplR: null };
  const base = await jev.decide({ strategy: brain.strategy, state: "" as unknown as Record<string, unknown>, menu: brain.menu(ctx), convictionLabels: brain.convictionLabels });
  const snapTokens = base.ok ? (b[0]?.tokens ?? 0) - base.inputTokens : NaN;
  const t = b.map((r) => r.tokens);
  const picks = Object.entries(b.reduce<Record<string, number>>((a, r) => ((a[r.choice!] = (a[r.choice!] ?? 0) + 1), a), {})).sort((x, y) => y[1] - x[1]).slice(0, 4);
  console.log(`${id.padEnd(6)} tokens/call avg ${(t.reduce((a, x) => a + x, 0) / (t.length || 1)).toFixed(0)} (snapshot ${snapTokens}, ${snapTokens < 400 ? "< 400 OK" : ">= 400 OVER"})  picks ${picks.map(([c, n]) => `${c}x${n}`).join(" ")}`);
}
const tokens = ok.reduce((a, r) => a + r.tokens, 0);
const logged = ok.reduce((a, r) => a + r.cost, 0);
const expected = (tokens * cfg.jev.usdPerMTok) / 1e6;
console.log(`latency p50 ${pct(0.5)}ms p90 ${pct(0.9)}ms p99 ${pct(0.99)}ms; over ${cfg.jev.timeoutMs}ms: ${lat.filter((l) => l > cfg.jev.timeoutMs).length}`);
console.log(`tokens ${tokens}; logged cost $${logged.toFixed(8)}; tokens x $${cfg.jev.usdPerMTok}/1M = $${expected.toFixed(8)}; ${Math.abs(logged - expected) < 1e-12 ? "MATCH" : "MISMATCH"}`);
const perCall = tokens / (ok.length || 1);
console.log(`at TICK_MS=${cfg.tickMs}: ~$${((3 * 86_400_000) / cfg.tickMs * perCall * cfg.jev.usdPerMTok / 1e6).toFixed(2)}/day (cap $${cfg.jev.dailyUsdCap})`);
