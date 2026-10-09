# Catfolio strategies — catfolio-2-breezy-bizzy

Exactly two active strategies: **Mochi adapts Breezy** and **Tiger adapts Bizzy**. `src/cats.ts` schedules these adaptations, reusing upstream `src/bees/breezy.ts` and `src/bees/bizzy.ts` sizing/stops/exits and the shared indicator engine. Original documents are preserved in [BREEZY_BEE.md](BREEZY_BEE.md) and [BIZZY_BEE.md](BIZZY_BEE.md), explicitly marked historical. Their old leverage, never-flat and automatic-add rules are not enabled.

## Mochi: calculated multi-horizon trend following

- BTC/ETH, long-only. On completed **4h closes**, replay Donchian slices with lookbacks 5, 10, 20, 30, 60, 90, 150, 250, 360. A close above the prior channel's highest close activates a long slice; its midpoint stop ratchets upward. The mirrored short slice contributes to the directional score but cannot open a short position.
- Require all nine slices available, score (long minus short) ≥6 and no short slices. Prefer the highest score; an aligned 10-day closing extreme breaks ties. WAIT and the strongest eligible coin are offered. No short-term MACD gate that would arbitrarily override the slow trend.
- Let `E` be own equity, `M = E × maxNotionalPct/100`, `V` measured annualized realized volatility (%), `T` target volatility (default 25%). The restored sizing fraction is `min(score/9, E × T/V / M, 1)`. There is **no size floor**. Missing, zero or nonfinite volatility prevents new exposure. Annualization uses 365 × 6 bars/year; 90 four-hour returns represent about 15 days, not 90 days.
- Initial stop: `entry − 2 × ATR14(4h)`. Ratchet to the average channel stop of aligned slices; never lower an existing stop. This restores Breezy's four-hour risk horizon instead of the removed wrapper's 15m ATR stop.
- A score drop of at least 3 from the recorded entry score offers TRIM_HALF. This is optional and occurs at most once per position; the fill and trim flag are persisted together. No repeated halving or adds. Below-minimum trims are skipped.
- A fresh score ≤0 triggers a deterministic full exit. Hard stops and daily loss stops also operate without inference. HOLD/CLOSE remain available, and holding a winner across UTC days is allowed.

The underlying family is motivated by [Zarattini, Pagani and Barbon's research](https://concretumgroup.com/wp-content/uploads/2026/02/Catching-Crypto-Trends.pdf), which evaluates multi-horizon channels with volatility sizing. Our four-hour frequency, two-coin universe, single position, model abstention, extra stops and small-account costs differ materially from its daily portfolio. The paper's reported returns are not forecasts for Mochi. The finite 400-bar history initializes slice state from that window, so long-lived states may differ from a full-history research backtest.

## Tiger: measured daily breakout

The [current upstream Bizzy implementation](https://github.com/imikerussell/beebots/blob/main/src/bees/bizzy.ts) uses a Larry Williams-style daily volatility breakout. Its older RSI/Bollinger fade helpers remain historical. We preserve the daily breakout mechanism and replace full leveraged sizing with Catfolio's own-capital and stop-risk limits.

- BTC/ETH/SOL, long-only. Compute `trigger = today's UTC midnight open + k × yesterday's high–low range`, default `k=0.5`.
- Require all 24 distinct, completed hourly bars for yesterday, plus the actual midnight opening bar. Missing data cannot stand in for a complete day's range. The new day's open is known before its first bar closes; yesterday's range never uses today's highs or future bars.
- Require a completed 15m close above the trigger, current price still above it, positive 1h momentum, and complete 4h ensemble score ≥3. A transient intrabar spike alone does not qualify.
- Avoid chasing: current price must be no more than 0.25 × yesterday's range above the trigger. Require known funding ≤0.03% per settlement; this is a carry-cost filter, not an annualized threshold.
- Initial stop at the entry day's open, preserving the failed-breakout meaning. No fast 15m trail added on top. Exit at **23:59 UTC** regardless of model availability; no entries within 60 minutes of that time. Fresh quotes are still required to execute.
- Default **one entry per UTC day**, even if stopped out. This restores Bizzy's one-shot character and reduces repeated attempts/fees versus the prior six-entry wrapper. `TIGER_MAX_ENTRIES_PER_DAY` can be changed deliberately. No shorts, full-2x orders, averaging down or recovery sizing.

Confirmation, no-chase, funding and trend thresholds are transparent design choices, not fitted winners. They can miss profitable breakouts and increase delayed-entry costs. Late-night UTC runs may correctly leave Tiger in cash until the next day. This implementation has no validated out-of-sample profitability result.

## Shared deterministic risk and model role

The model chooses only among code-qualified actions plus WAIT/HOLD/CLOSE. It can abstain, but cannot invent a setup, a size or a stop. Probabilities describe action preference, not the chance of making money. A chosen action must still qualify against current state after inference.

Final notional is the minimum of strategy-adjusted notional cap, stop-distance risk budget including estimated entry/exit fees, and own available capital. Contracts round **down**, and exchange minimums can veto an otherwise valid setup. Tiger's maxima are 100% own equity / 1% stop risk; Mochi's are 50% / 0.25%. Both have one position maximum. Volatility sizing is an exposure ceiling, not a guaranteed portfolio volatility or loss bound.

Protective checks every five seconds remain separate from model decisions every minute. Stops, lost-trend exits, day-end exits and loss limits bypass entry/fee caps. Neither cat gets transfers/top-ups or adds after losses. A restored position keeps its persisted stop; any new trailing adjustment only reduces risk.

## Validation and evaluation

`pnpm test` covers rising/falling/flat nine-channel histories, volatility sizing, strongest-coin selection, four-hour stops, one-time persisted trims/restart, day-open stops, confirmed breakout/no-chase/funding/day-end filters, complete daily data, unavailable-model exits, lot sizes and isolated balances. These are rule/execution tests, **not a profitability backtest**. The dashboard displays descriptions generated from effective parameters; audits record strategy version, parameters, market data, model response and resulting action.

For evidence of an edge, next evaluate a time-ordered historical holdout across bull, bear and sideways regimes, with warm-up, fees, funding, bid/ask and worse-slippage scenarios; then forward-test without retuning on each night's outcome. Historical candles do not recreate the model's contemporaneous choices or full order-book liquidity. Compare against cash and simple buy-and-hold, report drawdown and turnover, and do not select a strategy from one profitable night. No such profitability claim is made by this change.
