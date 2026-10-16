/** Causal, deterministic research simulator. This is not a replay of Jev decisions. */
import type { Candle } from "../market/types.js";
export type Side = "long" | "short";
export interface ResearchSignal {
  side: Side; rank: number; atrPct: number; sizeFrac: number; signalClose: number; entryBoundary?: number; volatilityNotionalPct?: number; invalidatingStop?: number;
}
export interface ResearchBar {
  candle: Candle;
  /** Signals known only after this candle closes. */
  signal: ResearchSignal | null;
  exitLong: boolean; exitShort: boolean;
  trailLong?: number | null; trailShort?: number | null;
  ready: boolean;
  fundingRate?: number;
}
export interface BacktestConfig {
  name: string; start: number; end: number; initialEquity: number; riskPct: number; maxNotionalPct: number;
  stopAtrMult: number; maxHoldMinutes: number; cooldownMinutes: number; maxEntriesPerDay: number;
  feeBudgetUsdDay: number; dailyLossStopPct: number;
  feeBps: number; slippageBps: number; halfSpreadBps: number;
  absoluteNotionalCap?: number; retireAtEquityPct?: number;
  costMultiple: number; trailOnlyAfterProfitR?: number; minStopCostRatio?: number; maxChaseAtr?: number;
}
export interface ResearchTrade {
  coin: string; side: Side; entryTs: number; exitTs: number; entryPx: number; exitPx: number;
  notional: number; fees: number; fundingCost: number; grossPnl: number; netPnl: number; reason: string;
}
export interface BacktestResult {
  name: string; start: string; endExclusive: string; initialEquity: number; finalEquity: number;
  returnPct: number; maxDrawdownPct: number; trades: number; winners: number; winRatePct: number;
  profitFactor: number | null; grossPnl: number; fees: number; fundingCost: number; turnover: number; turnoverEquity: number;
  exposurePct: number; netPnl: number; closed: ResearchTrade[]; equity: { ts: number; value: number }[];
}
interface PendingOpen { coin: string; signal: ResearchSignal; ts: number }
interface Position {
  coin: string; side: Side; qty: number; entryPx: number; entryTs: number; initialStopDistance: number;
  stop: number; fees: number; fundingCost: number; notional: number; lastClose: number;
}
export const BAR_MS = 15 * 60_000;
export function runBacktest(series: Map<string, ResearchBar[]>, cfg: BacktestConfig): BacktestResult {
  const maps = new Map([...series].map(([coin, bars]) => [coin, new Map(bars.map(bar => [bar.candle.ts, bar]))]));
  const trades: ResearchTrade[] = [], equity: BacktestResult["equity"] = [];
  const feeRate = cfg.feeBps * cfg.costMultiple / 10_000;
  const impact = (cfg.slippageBps + cfg.halfSpreadBps) * cfg.costMultiple / 10_000;
  let cash = cfg.initialEquity, position: Position | null = null;
  let pendingOpen: PendingOpen | null = null;
  let pendingClose: string | null = null, lastExit = -Infinity, fees = 0, fundingCost = 0, turnover = 0;
  let day = "", entriesToday = 0, feesToday = 0, dayStartEquity = cash, exposed = 0, totalBars = 0;
  let peak = cash, maxDrawdownPct = 0, lossStopped = false, retired = false;
  const fillPx = (mid: number, buy: boolean) => mid * (1 + (buy ? impact : -impact));
  function close(px: number, ts: number, reason: string) {
    if (!position) return;
    const p = position, execution = fillPx(px, p.side === "short"), dir = p.side === "long" ? 1 : -1;
    const grossPnl = dir * p.qty * (execution - p.entryPx), fee = p.qty * execution * feeRate;
    cash += grossPnl - fee; fees += fee; feesToday += fee; turnover += p.qty * execution;
    trades.push({ coin: p.coin, side: p.side, entryTs: p.entryTs, exitTs: ts, entryPx: p.entryPx, exitPx: execution,
      notional: p.notional, fees: p.fees + fee, fundingCost: p.fundingCost, grossPnl, netPnl: grossPnl - p.fees - fee - p.fundingCost, reason });
    position = null; pendingClose = null; lastExit = ts;
  }
  for (let ts = cfg.start; ts < cfg.end; ts += BAR_MS) {
    const utcDay = new Date(ts).toISOString().slice(0, 10);
    if (utcDay !== day) {
      day = utcDay; entriesToday = 0; feesToday = 0; lossStopped = false;
      dayStartEquity = cash + (position ? (position.side === "long" ? 1 : -1) * position.qty * (position.lastClose - position.entryPx) : 0);
    }
    let p = position as Position | null;
    if (p) {
      const bar = maps.get(p.coin)?.get(ts);
      if (bar?.fundingRate !== undefined) {
        const payment = (p.side === "long" ? 1 : -1) * p.qty * bar.candle.o * bar.fundingRate;
        cash -= payment; fundingCost += payment; p.fundingCost += payment;
      }
      if (bar) {
        const openEquity = cash + (p.side === "long" ? 1 : -1) * p.qty * (bar.candle.o - p.entryPx);
        if (openEquity <= cfg.initialEquity * (cfg.retireAtEquityPct ?? 0) / 100) {retired=true;close(bar.candle.o,ts,"retired");}
        else if (openEquity <= dayStartEquity * (1-cfg.dailyLossStopPct/100)) {lossStopped=true;close(bar.candle.o,ts,"daily_loss_stop");}
        else if (pendingClose) close(bar.candle.o,ts,pendingClose);
      }
      else if (!bar) pendingClose = "missing_bar_exit_at_next_available_open";
    }
    const order: PendingOpen | null = pendingOpen; pendingOpen = null;
    if (!position && !retired && !lossStopped && order && order.ts === ts && ts - lastExit >= cfg.cooldownMinutes * 60_000 && entriesToday < cfg.maxEntriesPerDay && cash > dayStartEquity * (1 - cfg.dailyLossStopPct / 100)) {
      const bar = maps.get(order.coin)?.get(ts);
      if (bar) {
        const s = order.signal, entry = fillPx(bar.candle.o, s.side === "long"), stopFraction = s.atrPct / 100 * cfg.stopAtrMult;
        const roundTripCost = 2 * (feeRate + impact), distance = entry * stopFraction;
        const chase = (s.side === "long" ? 1 : -1) * (bar.candle.o - s.signalClose) / s.signalClose / (s.atrPct / 100);
        const breakoutValid = s.entryBoundary === undefined || (s.side === "long" ? bar.candle.o >= s.entryBoundary : bar.candle.o <= s.entryBoundary);
        const trendStopValid = s.invalidatingStop === undefined || (s.side === "long" ? bar.candle.o > s.invalidatingStop : bar.candle.o < s.invalidatingStop);
        if (breakoutValid && trendStopValid && stopFraction > 0 && stopFraction >= roundTripCost * (cfg.minStopCostRatio ?? 0) && chase <= (cfg.maxChaseAtr ?? Infinity)) {
          const notional = Math.max(0, Math.min(Math.min(cash * cfg.maxNotionalPct / 100,cfg.absoluteNotionalCap ?? Infinity) * s.sizeFrac, cash * (s.volatilityNotionalPct ?? Infinity) / 100, cash * cfg.riskPct / 100 / (stopFraction + roundTripCost)));
          const fee = notional * feeRate;
          if (notional > 0 && feesToday < cfg.feeBudgetUsdDay) {
            cash -= fee; fees += fee; feesToday += fee; turnover += notional; entriesToday++;
            position = { coin: order.coin, side: s.side, qty: notional / entry, entryPx: entry, entryTs: ts,
              initialStopDistance: distance, stop: entry + (s.side === "long" ? -distance : distance), fees: fee, fundingCost: 0, notional, lastClose: entry };
          }
        }
      }
    }
    p = position;
    if (p) {
      exposed++;
      const bar = maps.get(p.coin)?.get(ts);
      if (bar) {
        const candle = bar.candle;
        if ((p.side === "long" && candle.l <= p.stop) || (p.side === "short" && candle.h >= p.stop)) {
          close(p.side === "long" ? Math.min(p.stop, candle.o) : Math.max(p.stop, candle.o), ts, "stop");
        } else {
          p.lastClose = candle.c;
          if (ts + BAR_MS - p.entryTs >= cfg.maxHoldMinutes * 60_000) pendingClose = "time_exit";
          else if (bar.ready && (p.side === "long" ? bar.exitLong : bar.exitShort)) pendingClose = "signal_exit";
          const trail = p.side === "long" ? bar.trailLong : bar.trailShort;
          // A close-derived trailing stop becomes active next bar, never earlier within this candle.
          const profitR = (p.side === "long" ? 1 : -1) * (candle.c - p.entryPx) / p.initialStopDistance;
          if (bar.ready && (cfg.trailOnlyAfterProfitR === undefined || profitR >= cfg.trailOnlyAfterProfitR) && trail !== null && trail !== undefined && Number.isFinite(trail)) p.stop = p.side === "long" ? Math.max(p.stop, trail) : Math.min(p.stop, trail);
        }
      }
    }
    const marked = cash + (position ? (position.side === "long" ? 1 : -1) * position.qty * (position.lastClose - position.entryPx) : 0);
    if (marked <= cfg.initialEquity * (cfg.retireAtEquityPct ?? 0) / 100) {retired=true;if(position)pendingClose="retired";}
    else if(marked <= dayStartEquity*(1-cfg.dailyLossStopPct/100)){lossStopped=true;if(position)pendingClose="daily_loss_stop";}
    peak = Math.max(peak, marked); maxDrawdownPct = Math.max(maxDrawdownPct, 100 * (peak - marked) / peak);
    equity.push({ ts: ts + BAR_MS, value: marked }); totalBars++;
    if (!position && !pendingClose && !retired && !lossStopped && ts + BAR_MS < cfg.end && ts + BAR_MS - lastExit >= cfg.cooldownMinutes * 60_000) {
      const candidates: PendingOpen[] = [...maps].flatMap(([coin, bars]): PendingOpen[] => {
        const bar = bars.get(ts); return bar?.ready && bar.signal ? [{ coin, signal: bar.signal, ts: ts + BAR_MS }] : [];
      }).sort((a, b) => b.signal.rank - a.signal.rank || a.coin.localeCompare(b.coin));
      pendingOpen = candidates[0] ?? null;
    }
  }
  if (position) close(position.lastClose, cfg.end, "segment_end");
  if (equity.length) equity[equity.length - 1]!.value = cash;
  peak = Math.max(peak, cash); maxDrawdownPct = Math.max(maxDrawdownPct, 100 * (peak - cash) / peak);
  const wins = trades.filter(t => t.netPnl > 0), losses = trades.filter(t => t.netPnl < 0);
  const positive = wins.reduce((s, t) => s + t.netPnl, 0), negative = -losses.reduce((s, t) => s + t.netPnl, 0);
  return { name: cfg.name, start: new Date(cfg.start).toISOString(), endExclusive: new Date(cfg.end).toISOString(), initialEquity: cfg.initialEquity,
    finalEquity: cash, returnPct: (cash / cfg.initialEquity - 1) * 100, maxDrawdownPct, trades: trades.length,
    winners: wins.length, winRatePct: trades.length ? wins.length / trades.length * 100 : 0, profitFactor: negative ? positive / negative : null,
    grossPnl: trades.reduce((s, t) => s + t.grossPnl, 0), fees, fundingCost, turnover, turnoverEquity: turnover / cfg.initialEquity,
    exposurePct: totalBars ? exposed / totalBars * 100 : 0, netPnl: cash - cfg.initialEquity, closed: trades, equity };
}

/** BTC buy-and-hold benchmark; funding applies only to the futures version. */
export function buyHoldBenchmark(bars: ResearchBar[], allocationPct: number, costMultiple: number, includeFunding: boolean) {
  if (!bars.length) throw new Error("Benchmark requires observed bars");
  const initial = 250, notional = initial * allocationPct / 100;
  const feeRate = 5/10_000*costMultiple, impact = 3/10_000*costMultiple;
  const qty = notional/(bars[0]!.candle.o*(1+impact));
  let cash = initial-notional-notional*feeRate, peak = initial, maxDrawdownPct = 0, fundingCost = 0;
  for(let i=0;i<bars.length;i++) {
    const b=bars[i]!;
    if(includeFunding&&i>0&&b.fundingRate!==undefined){const cost=qty*b.candle.o*b.fundingRate;cash-=cost;fundingCost+=cost;}
    const value=cash+qty*b.candle.c;
    peak=Math.max(peak,value);maxDrawdownPct=Math.max(maxDrawdownPct,(peak-value)/peak*100);
  }
  const exit=qty*bars.at(-1)!.candle.c*(1-impact),finalEquity=cash+exit*(1-feeRate);
  maxDrawdownPct=Math.max(maxDrawdownPct,(peak-finalEquity)/peak*100);
  return {allocationPct,includeFunding,returnPct:(finalEquity/initial-1)*100,maxDrawdownPct,fundingCost};
}
