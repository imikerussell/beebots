import type { BeeContext, BeeState, Position } from "../src/bees/types.js";
import { loadConfig, type BeeId, type Config, type StyleId } from "../src/config.js";
import { freshBee } from "../src/ledger.js";
import type { CoinStats, Instrument, MarketView, Ticker, TrendStats } from "../src/market/types.js";

export const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ TYPESAFE_API_KEY: "test-key", ...env });
}

export function coin(coinName: string, over: Partial<CoinStats> = {}, px = 100): CoinStats {
  return {
    instId: `${coinName}-USD_UM_XPERP-310404`,
    coin: coinName,
    last: px,
    mid: px,
    bid: px * 0.99995,
    ask: px * 1.00005,
    spreadBp: 1,
    vol24hUsd: 20e6,
    rsi14: 50,
    pctB: 0.5,
    bbWidthPct: 2,
    bbMid: px,
    atr14Pct: 0.5,
    macdHistPct: 0,
    ret1hPct: 0,
    ret24hPct: 0,
    ret7dPct: 0,
    volZ: 0,
    fundingPct: 0.01,
    fundingZ: 0,
    oiUsd: 1e6,
    oiChg1hPct: 0,
    newsZ: null,
    sentiment: null,
    ...over,
  };
}

export function trend(over: Partial<TrendStats> = {}): TrendStats {
  return { score: 0, longOn: 0, shortOn: 0, slicesAvailable: 9, atr4hPct: 1.5, rv90Pct: 50, trailStop: null, tenDayExtreme: 0, ...over };
}

export function view(stats: CoinStats[], over: Partial<MarketView> = {}): MarketView {
  const instruments = new Map<string, Instrument>();
  const tickers = new Map<string, Ticker>();
  for (const s of stats) {
    // One contract is worth $1 at the fixture price, whatever the coin.
    instruments.set(s.instId, { instId: s.instId, coin: s.coin, kind: "crypto", ctVal: 1 / s.mid, lotSz: 1, minSz: 1, tickSz: 0.01, state: "live" });
    tickers.set(s.instId, { instId: s.instId, last: s.last, bid: s.bid, ask: s.ask, mid: s.mid, spreadBp: s.spreadBp, vol24hUsd: s.vol24hUsd, open24h: s.last, ts: NOW });
  }
  return {
    ts: NOW,
    instruments,
    tickers,
    stats: new Map(stats.map((s) => [s.instId, s])),
    gated: stats.map((s) => s.instId),
    spreadBlocked: [],
    newsAvailable: false,
    ...over,
  };
}

/** Tests name a bee after its style (bee("breezy")); the slot id does not matter to a brain. */
export function bee(id: StyleId | BeeId, over: Partial<BeeState> = {}): BeeState {
  return { ...freshBee(id as BeeId, 333, NOW - 60 * 60_000), dayKey: "2026-09-24", ...over };
}

export function position(s: CoinStats, over: Partial<Position> = {}): Position {
  return { instId: s.instId, coin: s.coin, side: "long", contracts: 100, entryPx: s.mid, openedAt: NOW - 10 * 60_000, stopPx: null, riskUsd: 10, ...over };
}

export function ctx(id: StyleId, b: BeeState, v: MarketView, cfg = testConfig(), now = NOW): BeeContext {
  return { bee: b, view: v, cfg, knobs: cfg.bees[id], now, uplR: b.position && b.position.riskUsd > 0 ? b.uplUsd / b.position.riskUsd : null };
}
