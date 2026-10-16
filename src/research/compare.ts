/** Fixed chronological comparison. Definitions are fixed before reading the holdout; no optimizer. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atr, macd, trendStats } from "../market/indicators.js";
import { trendBreakoutSignal } from "../market/strategy-signals.js";
import type { Candle, TrendStats } from "../market/types.js";
import type { HistoryFile } from "./fetch-history.js";
import type { FundingHistory } from "./fetch-funding.js";
import { BAR_MS, runBacktest, buyHoldBenchmark, type BacktestConfig, type BacktestResult, type ResearchBar, type ResearchSignal } from "./backtest.js";

export function aggregateHourly(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 3 < candles.length; i++) {
    const first = candles[i]!;
    if (first.ts % 3_600_000 !== 0) continue;
    const group = candles.slice(i, i + 4);
    if (group.some((c, n) => !c.confirmed || c.ts !== first.ts + n * BAR_MS)) continue;
    out.push({ ts: first.ts, o: first.o, h: Math.max(...group.map(c => c.h)), l: Math.min(...group.map(c => c.l)),
      c: group[3]!.c, volUsd: group.reduce((s,c)=>s+c.volUsd,0), confirmed: true });
  }
  return out;
}
export interface FeatureSet { baseline: Map<string, ResearchBar[]>; guarded: Map<string, ResearchBar[]>; aligned: Map<string, ResearchBar[]>; breakout: Map<string, ResearchBar[]>; good: Map<string, ResearchBar[]>; goodCadence: Map<string, ResearchBar[]> }
export async function buildFeatures(dir: string): Promise<{ features: FeatureSet; start: number; end: number; manifest: unknown; fundingCoverage: unknown }> {
  const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")) as { evaluationStart: string; endExclusive: string; files: HistoryFile[] };
  const features: FeatureSet = { baseline: new Map(), guarded: new Map(), aligned: new Map(), breakout: new Map(), good: new Map(), goodCadence: new Map() };
  const fundingCoverage: { coin: string; count: number; first: string | null; last: string | null }[] = [];
  for (const meta of manifest.files.filter(f => f.bar === "15m")) {
    const history = JSON.parse(await readFile(resolve(dir, `${meta.coin}-15m.json`), "utf8")) as HistoryFile;
    const funding = JSON.parse(await readFile(resolve(dir, `${meta.coin}-funding.json`), "utf8")) as FundingHistory;
    fundingCoverage.push({ coin: meta.coin, count: funding.points.length, first: funding.points[0] ? new Date(funding.points[0].ts).toISOString() : null,
      last: funding.points.at(-1) ? new Date(funding.points.at(-1)!.ts).toISOString() : null });
    const rates = new Map(funding.points.map(p => [p.ts, p.rate]));
    const candles = history.candles, hourly = aggregateHourly(candles);
    const baselines: ResearchBar[] = [], guarded: ResearchBar[] = [], aligned: ResearchBar[] = [], breakout: ResearchBar[] = [], good: ResearchBar[] = [], goodCadence: ResearchBar[] = [];
    const isGood = ["BTC", "ETH"].includes(meta.coin);
    const c4h = isGood ? (JSON.parse(await readFile(resolve(dir, `${meta.coin}-4H.json`), "utf8")) as HistoryFile).candles : [];
    const trends = new Map<number, TrendStats>();
    if (isGood) for (let i = 360; i < c4h.length; i++) trends.set(c4h[i]!.ts + 4 * 3_600_000, trendStats(c4h.slice(Math.max(0,i-399),i+1)));
    let hourlyIndex = -1, trendIndex = -1, latestTrend: TrendStats | undefined;
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]!, now = candle.ts + BAR_MS;
      while (hourlyIndex + 1 < hourly.length && hourly[hourlyIndex + 1]!.ts + 3_600_000 <= now) hourlyIndex++;
      while (trendIndex + 1 < c4h.length && c4h[trendIndex + 1]!.ts + 4 * 3_600_000 <= now) {
        trendIndex++; latestTrend = trends.get(c4h[trendIndex]!.ts + 4 * 3_600_000);
      }
      const window = candles.slice(Math.max(0,i-199), i+1), hours = hourly.slice(Math.max(0,hourlyIndex-199), hourlyIndex+1);
      const shared = trendBreakoutSignal(window, hours, now), a = atr(window), m = macd(window.map(c => c.c));
      const aPct = a === null ? null : a / candle.c * 100;
      const ret = i >= 4 ? (candle.c / candles[i-4]!.c - 1) * 100 : null;
      const threshold = aPct === null ? Infinity : Math.max(0.1, 0.25 * aPct);
      const side = ret !== null && m && ret >= threshold && m.hist >= 0 ? "long" : ret !== null && m && ret <= -threshold && m.hist <= 0 ? "short" : null;
      // All comparisons share the six-day hourly warmup, so initial availability cannot favour a model.
      const ready = shared !== null;
      const volume24h = window.slice(-96).reduce((sum,c)=>sum+c.volUsd,0);
      const signal: ResearchSignal | null = ready && volume24h >= 1_000_000 && side && aPct ? { side, rank: Math.abs(ret!) / aPct, atrPct: aPct, sizeFrac: 1, signalClose: candle.c } : null;
      const base: ResearchBar = { candle, signal, ready, exitLong: side === "short", exitShort: side === "long",
        trailLong: a ? candle.c - 2*a : null, trailShort: a ? candle.c + 2*a : null, fundingRate: rates.get(candle.ts) };
      baselines.push(base);
      guarded.push({...base,exitLong:ret!==null&&m!==null&&ret<0&&m.hist<0,exitShort:ret!==null&&m!==null&&ret>0&&m.hist>0});
      aligned.push({ ...base, signal: signal && shared?.regime === signal.side ? signal : null,
        exitLong: ret !== null && m !== null && ret < 0 && m.hist < 0,
        exitShort: ret !== null && m !== null && ret > 0 && m.hist > 0 });
      breakout.push({ ...base, signal: shared?.side && volume24h >= 1_000_000 ? { side: shared.side, rank: Math.abs(ret!) / aPct!,
        atrPct: aPct!, sizeFrac: 1, signalClose: candle.c, entryBoundary: shared.side === "long" ? shared.entryHigh : shared.entryLow } : null,
        exitLong: !!shared && (shared.regime === "short" || candle.c < shared.exitLow),
        exitShort: !!shared && (shared.regime === "long" || candle.c > shared.exitHigh),
        trailLong: a ? candle.c - 2*a : null, trailShort: a ? candle.c + 2*a : null });
      if (isGood) {
        const t = latestTrend, valid = ready && t && t.slicesAvailable === 9 && t.atr4hPct! > 0 && t.rv90Pct! > 0;
        const trendSignal: ResearchSignal | null = valid && volume24h >= 10_000_000 && Math.abs(t.score) >= 2 ? { side: t.score > 0 ? "long" : "short", rank: Math.abs(t.score), atrPct: t.atr4hPct!,
          sizeFrac: Math.min(1,Math.abs(t.score)/9), volatilityNotionalPct:2500/t.rv90Pct!, signalClose: candle.c } : null;
        good.push({ candle, signal: trendSignal, ready: !!valid, exitLong: !!t && t.score <= -2, exitShort: !!t && t.score >= 2,
          trailLong: t && t.score > 0 ? t.trailStop : null, trailShort: t && t.score < 0 ? t.trailStop : null, fundingRate: rates.get(candle.ts) });
        goodCadence.push({...good.at(-1)!,signal:now%(4*3_600_000)===0&&Math.abs(t?.score??0)>=4&&trendSignal?{...trendSignal,invalidatingStop:t?.trailStop??undefined}:null,
          exitLong:!!t&&t.score<=0,exitShort:!!t&&t.score>=0});
      }
    }
    features.baseline.set(meta.coin, baselines); features.guarded.set(meta.coin, guarded); features.aligned.set(meta.coin, aligned); features.breakout.set(meta.coin, breakout);
    if (isGood) {features.good.set(meta.coin, good);features.goodCadence.set(meta.coin, goodCadence);}
    process.stdout.write(`Features: ${meta.coin}\n`);
  }
  return { features, start: Date.parse(manifest.evaluationStart) + 150*3_600_000, end: Date.parse(manifest.endExclusive), manifest, fundingCoverage };
}
function summary(result: BacktestResult): Omit<BacktestResult,"closed"|"equity"> { const stats = { ...result }; Reflect.deleteProperty(stats,"closed"); Reflect.deleteProperty(stats,"equity"); return stats; }
function combine(name: string, a: BacktestResult, b: BacktestResult) {
  let peak = a.initialEquity+b.initialEquity, drawdown = 0;
  const other = new Map(b.equity.map(e=>[e.ts,e.value]));
  for (const e of a.equity) { const total=e.value+(other.get(e.ts)??b.initialEquity); peak=Math.max(peak,total);drawdown=Math.max(drawdown,(peak-total)/peak*100); }
  return { name, returnPct: (a.finalEquity+b.finalEquity)/(a.initialEquity+b.initialEquity)*100-100, maxDrawdownPct:drawdown,
    netPnl:a.netPnl+b.netPnl,fees:a.fees+b.fees,fundingCost:a.fundingCost+b.fundingCost,trades:a.trades+b.trades };
}
export async function compareHistory(dir = "data/research") {
  const built = await buildFeatures(dir), split = built.end - 30*86_400_000;
  const configs = [
    { name:"dark_momentum_proxy_2h",series:built.features.baseline,hold:120,dark:true,candidate:false },
    { name:"dark_trend_momentum_2h",series:built.features.aligned,hold:120,dark:true,candidate:true },
    { name:"dark_trend_breakout_2h",series:built.features.breakout,hold:120,dark:true,candidate:true },
    { name:"dark_trend_breakout_24h",series:built.features.breakout,hold:1440,dark:true,candidate:true },
    { name:"good_donchian_proxy_6h",series:built.features.good,hold:360,dark:false,candidate:false },
    { name:"good_donchian_72h",series:built.features.good,hold:4320,dark:false,candidate:false },
    { name:"good_4h_cadence_6h",series:built.features.goodCadence,hold:360,dark:false,candidate:true },
    { name:"good_4h_cadence_72h",series:built.features.goodCadence,hold:4320,dark:false,candidate:true },
    { name:"dark_default_guarded_momentum_2h",series:built.features.guarded,hold:120,dark:true,candidate:true },
  ];
  const experiments: { window:string;costMultiple:number;results:ReturnType<typeof summary>[];portfolios:ReturnType<typeof combine>[];benchmarks:unknown }[]=[];
  for (const window of [{name:"development",start:built.start,end:split},{name:"holdout",start:split,end:built.end}]) for (const costMultiple of [1,2]) {
    const results = configs.map(c=>runBacktest(c.series, {name:c.name,start:window.start,end:window.end,initialEquity:250,riskPct:c.dark?0.5:0.25,
      maxNotionalPct:194,absoluteNotionalCap:700,retireAtEquityPct:40,stopAtrMult:2,maxHoldMinutes:c.hold,cooldownMinutes:c.dark?15:30,maxEntriesPerDay:c.dark?16:4,
      feeBudgetUsdDay:c.dark?2:1,dailyLossStopPct:c.dark?5:2,feeBps:5,slippageBps:2,halfSpreadBps:1,costMultiple,
      trailOnlyAfterProfitR:c.dark?1:undefined,minStopCostRatio:c.candidate?3:undefined,maxChaseAtr:c.candidate?0.5:undefined} satisfies BacktestConfig));
    const btc = built.features.baseline.get("BTC")!.filter(b=>b.candle.ts>=window.start&&b.candle.ts<window.end);
    const portfolios = [combine("current_proxies",results[0]!,results[4]!),combine("trend_momentum_plus_good6h",results[1]!,results[4]!),
      combine("breakout2h_plus_good6h",results[2]!,results[4]!),combine("breakout24h_plus_good72h",results[3]!,results[5]!),combine("breakout2h_plus_good4h6h",results[2]!,results[6]!),combine("breakout24h_plus_good4h72h",results[3]!,results[7]!),combine("default_guarded_plus_good4h6h",results[8]!,results[6]!)];
    experiments.push({window:window.name,costMultiple,results:results.map(summary),portfolios,benchmarks:{cashReturnPct:0,
      btcPriceBuyHold:buyHoldBenchmark(btc,100,costMultiple,false),btcHalfAllocationPriceBuyHold:buyHoldBenchmark(btc,50,costMultiple,false),
      btcHalfAllocationFuturesBuyHold:buyHoldBenchmark(btc,50,costMultiple,true),btcOwnerMaxExposureFuturesBuyHold:buyHoldBenchmark(btc,194,costMultiple,true),
      notes:"BTC benchmarks include entry and exit costs. 50% allocation is an unlevered reference;194% exposure matches the owner leverage headroom cap. Futures versions include funding. No stop loss."}});
    await writeFile(resolve(dir, `trades-${window.name}-${costMultiple}x.json`),JSON.stringify(results));
  }
  const sources = ["src/research/backtest.ts","src/research/compare.ts","src/market/strategy-signals.ts","src/market/indicators.ts","src/research/fetch-history.ts","src/research/fetch-funding.ts"];
  const implementation = Object.fromEntries(await Promise.all(sources.map(async path=>[path,createHash("sha256").update(await readFile(path)).digest("hex")])));
  const dataHashes = Object.fromEntries(await Promise.all((built.manifest as {files:HistoryFile[]}).files.map(async f=>{
    const name=`${f.coin}-${f.bar}.json`;return [name,createHash("sha256").update(await readFile(resolve(dir,name))).digest("hex")];
  })));
  for(const coin of built.features.baseline.keys()){
    const name=`${coin}-funding.json`;dataHashes[name]=createHash("sha256").update(await readFile(resolve(dir,name))).digest("hex");
  }
  const report = {implementation,dataHashes,ownerSettings:{allocatedEquityPerBot:250,notionalPct:200,maxLeverage:2,marginHeadroomPct:3,effectiveMaxNotionalPct:194,absoluteNotionalCap:700,darkDailyEntries:16,goodDailyEntries:4,stopRiskPct:{dark:0.5,good:0.25},baselineGoodMinTrendScore:2,candidateGoodMinTrendScore:4},createdAt:new Date().toISOString(),methodology:{label:"Exploratory retrospective chronological comparison; not an untouched holdout, historical Jev replay, or optimized portfolio result.",
    developmentStart:new Date(built.start).toISOString(),holdoutStart:new Date(split).toISOString(),endExclusive:new Date(built.end).toISOString(),
    costs:"Each fill:5bp fee+2bp slippage+1bp half spread; realized historical funding at settlement using bar-openprice proxy. Stress doubles execution costs only; cost-feasibility gates then adapt, so the trade count can change.",
    execution:"Signals use completed bars; execute next15m bar open. Intrabar ATR stop before any close-derived trailing update. Stop gaps fill at the worse of open and stop; segment-endclose marked with costs.",
    limitations:["No historical Jev probabilities, coach changes, discretionary exits, adds or trims replayed.","15m resolution misses within-bar order and real10second engine decisions.","Fractional synthetic quantities: exchange minimum lots, liquidity depth and partial fills not modeled.","Fixed assumed spread; no historical book reconstruction. Funding uses candle-open rather than mark price.","Liquidity gates use trailing24h summed quote candle volume as a proxy for the exchange ticker measure. Thresholds:$1m Dark and$10m Good.","Current surviving12coin universe creates survivorship/selection bias.","90days and one evaluation regime cannot establish expected future returns. Results were inspected during parity corrections, so this is exploratory retrospective evaluation, not an untouched holdout.","AI cost excluded because deterministic candidates make no model calls; training/evaluation discipline must be enforced before actual deployment."]},
    data:built.manifest,fundingCoverage:built.fundingCoverage,experiments};
  await writeFile(resolve(dir,"comparison.json"),`${JSON.stringify(report,null,2)}\n`);
  process.stdout.write(`${JSON.stringify(experiments,null,2)}\n`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await compareHistory(process.argv[2]);
