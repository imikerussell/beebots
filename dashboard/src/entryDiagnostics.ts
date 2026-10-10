import type { EntryDiagnostic } from "./types.js";

const number = (v: number | null | undefined, decimals = 2) =>
  v != null && Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : "not recorded";
const pct = (v: number | null | undefined) => v != null && Number.isFinite(v) ? `${number(v, 3)}%` : "not recorded";
const duration = (v: number | null | undefined) => v != null && Number.isFinite(v) ? `${number(v / 60000, 1)} min` : "not recorded";

export function dataBlocked(c: EntryDiagnostic) {
  return c.blockers.some(b => ["stale_indicators", "missing_market_data", "missing_confirmed_entry_close"].includes(b));
}

export function entryExplanations(c: EntryDiagnostic): string[] {
  // Also fix the presentation of old records that mixed stale data with market conclusions.
  if (dataBlocked(c)) {
    const reason = c.blockers.includes("stale_indicators")
      ? c.indicatorsAgeMs == null || c.maxIndicatorsAgeMs == null
        ? "Entry checks paused: indicators were too old. Their exact age and freshness limit were not recorded."
        : `Entry checks paused: indicators are ${duration(c.indicatorsAgeMs)} old; limit ${duration(c.maxIndicatorsAgeMs)}.`
      : c.blockers.includes("missing_market_data")
        ? "Entry checks paused: no usable market data."
        : `Entry checks paused: no current completed ${c.entryMinutes ?? "entry"}-minute candle. Age since close: ${duration(c.confirmedAgeMs)}; limit ${duration(c.maxConfirmedAgeMs)}.`;
    return [reason, c.feedError ? `Last refresh failure: ${c.feedError}` : "Refresh failure details were not recorded for this decision.",
      "Trend, momentum and breakout checks need fresh candles before they can be assessed."];
  }
  return c.blockers.map(reason => {
    switch (reason) {
      case "missing_breakout_levels": return "Waiting for today's open and the complete previous day's range.";
      case "breakout_not_reached": return `Price $${number(c.mid)} has not reached breakout trigger $${number(c.breakoutTrigger)}.`;
      case "missing_trend_data": return "Waiting for Donchian trend candle history.";
      case "minTrendScore": return `Trend score ${number(c.trendScore, 0)}; needs at least ${number(c.minTrendScore, 0)} on ${c.trendMinutes ?? "?"}-minute bars.`;
      case "momentum_not_positive": return `${c.momentumMinutes ?? "Recent"}-minute momentum ${pct(c.momentumPct)}; must be above 0%.`;
      case "move_too_small_after_costs": return `Volatility filter: ATR stop distance ${pct(c.stopDistancePct)}; needs at least ${pct(c.minStopDistancePct)} (2 × estimated round-trip costs of ${pct(c.roundTripCostPct)}).`;
      case "breakout_not_confirmed": return `${c.entryMinutes ?? 5}-minute close $${number(c.confirmedClose)} must exceed $${number(c.breakoutTrigger)}; current price $${number(c.mid)} must stay at or above that level.`;
      case "price_extended": return `Current price $${number(c.mid)} exceeds the chase limit of $${number(c.maxEntryPrice)}.`;
      case "spread_gate": return `Spread ${number(c.spreadBps)} bps; maximum ${number(c.maxSpreadBps)} bps.`;
      case "liquidity_gate": return `24-hour volume $${number(c.volumeUsd, 0)}; minimum $${number(c.minVolumeUsd, 0)}.`;
      case "funding_gate": return `Funding ${pct(c.fundingPct)}; must be known and no higher than ${pct(c.maxFundingPct)}.`;
      case "trade_cap": return `${number(c.tradesToday, 0)} entries today; maximum ${number(c.maxTradesPerDay, 0)}.`;
      case "opposing_short_slices": return `${number(c.shortSlices, 0)} bearish trend channels; requires zero.`;
      case "incomplete_trend_history": return `Trend history incomplete: ${number(c.trendSlices, 0)} of 9 channels available.`;
      case "missing_atr_stop": return "Cannot calculate a valid ATR stop from the available candles.";
      case "missing_intraday_range": return "Cannot calculate a valid preceding-hour breakout range.";
      case "market_universe_gate": return "Instrument failed the shared market eligibility checks.";
      case "invalid_volatility_size": return "Trend and volatility inputs do not produce a positive position size.";
      case "coin_not_allowed": return "This coin is outside the strategy’s allowed market list.";
      default: return reason.replaceAll("_", " ");
    }
  });
}
