import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicGet, type HistoryFile } from "./fetch-history.js";
export interface FundingHistory { coin: string; instId: string; start: string; endExclusive: string; retrievedAt: string; points: { ts: number; rate: number }[] }
export async function downloadFunding(dir = "data/research") {
  const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")) as { evaluationStart: string; endExclusive: string; files: HistoryFile[] };
  const start = Date.parse(manifest.evaluationStart), end = Date.parse(manifest.endExclusive);
  const tasks = manifest.files.filter(f => f.bar === "15m");
  for (const task of tasks) {
    const points = new Map<number, { ts: number; rate: number }>(); let cursor = end;
    for (;;) {
      const rows = await publicGet<{ fundingTime: string; realizedRate: string; fundingRate: string }[]>("https://eea.okx.com", "/api/v5/public/funding-rate-history", { instId: task.instId, limit: "100", after: String(cursor) });
      const values = rows.map(r => ({ ts: Number(r.fundingTime), rate: Number(r.realizedRate || r.fundingRate) }));
      for (const value of values) if (value.ts >= start && value.ts < end && Number.isFinite(value.rate)) points.set(value.ts, value);
      const earliest = Math.min(...values.map(v => v.ts));
      if (!values.length || earliest <= start) break;
      if (earliest >= cursor) throw new Error(`Funding pagination stalled: ${task.coin}`);
      cursor = earliest;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const result: FundingHistory = { coin: task.coin, instId: task.instId, start: manifest.evaluationStart, endExclusive: manifest.endExclusive,
      retrievedAt: new Date().toISOString(), points: [...points.values()].sort((a,b)=>a.ts-b.ts) };
    await writeFile(resolve(dir, `${task.coin}-funding.json`), `${JSON.stringify(result)}\n`);
    process.stdout.write(`${task.coin}: ${points.size} funding settlements\n`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await downloadFunding(process.argv[2]);
