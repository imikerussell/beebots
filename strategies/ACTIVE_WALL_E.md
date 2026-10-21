# Dark Wall-E: completed-bar long/short strategies

Current version: `catfolio-9-profit-protection`. These are experimental paper strategies, not demonstrated profitable systems. See the [profit-exit controls](../docs/PROFIT_EXITS_2026-10-19.md); the earlier [measured audit](../docs/STRATEGY_REVIEW_2026-10-16.md) and [retrospective comparison](../docs/STRATEGY_BACKTEST_2026-10-16.md) do not validate version 9 exits.

## Entry opportunities

The owner universe contains BTC, ETH, SOL, HYPE, XRP, DOGE, ADA, LINK, AVAX, SUI, LTC and BCH. Require current confirmed candles, an eligible exchange market, configured liquidity/spread limits and a valid ATR stop. Entry stop distance must be at least `TIGER_MIN_STOP_COST_RATIO` (default 3) times estimated round-trip fees, spread and adverse slippage. Reject prices more than `TIGER_MAX_ENTRY_CHASE_ATR` (default 0.5) ATR beyond the confirming close in the trade direction. Neither filter estimates future profit.

`TIGER_SIGNAL_MODE` selects:

- `momentum` (default): absolute one-hour return >= max(`TIGER_MIN_MOMENTUM_PCT`, `TIGER_MOMENTUM_ATR_MULT` × 15-minute ATR%), with matching MACD direction. Defaults are 0.1% and 0.25.
- `trend_momentum`: the same momentum signal, aligned with hourly close and EMA20/EMA50 (configurable).
- `trend_breakout`: completed 15-minute close above/below the prior 20-bar high/low, aligned with the hourly EMA regime. The confirming bar is excluded from its own channel. Current price must remain outside the breakout boundary. This mode does not use the momentum gates.

Rank qualifying markets by absolute one-hour return / ATR. Offer the top `TIGER_MAX_ENTRY_CANDIDATES` (default 1) against WAIT. The model sees momentum, MACD, ATR, RSI, return, funding/OI/volume statistics, regime and estimated execution costs. Its selected-action probability and continuous 0–3 conviction must satisfy the configured thresholds. Neither value is a calibrated probability of trading profit. Fewer menu options change the probability distribution, so old threshold outcomes are not directly comparable.

## Decision cadence and exits

One entry decision attempt per current completed 15-minute bar, persisted before inference. Provider errors, vetoes, fills, stops and restarts do not grant another entry attempt on that bar. A late market is omitted until the next bar; owner/configuration changes create a new revision. Eligible winners also receive a separate profit review every configured interval (default 60 seconds above 0.5 net R). Between-bar reviews may hold or reduce exposure. When only HOLD is possible, code handles it without a model call.

Jev may select CLOSE_PROFIT or optional TAKE_PROFIT when current net profit qualifies; it cannot immediately flip a position. Selected discretionary exits need `TIGER_EXIT_MIN_ACTION_PROBABILITY` (default 0.4), without the entry conviction requirement. Momentum modes also exit deterministically when both one-hour return and MACD oppose the position. Breakout mode exits beyond the prior `TIGER_EXIT_BARS` (default 10) opposite channel or on an opposite hourly regime. Stops and time/loss limits take precedence over model choices.

Initial stop: `TIGER_STOP_ATR_MULT` × 15-minute ATR (default 1.5). Separately configured protection defaults to cost-covering breakeven after 0.5 net R, a 1 ATR trail after 0.75 net R, and retaining 65% of peak net profit after 1 net R. Stops only tighten. Optional partial profit-taking offers a one-time 50% reduction at 1.5 current net R, subject to exchange minimum sizes and Jev selection. Maximum hold: `TIGER_MAX_HOLD_MINUTES` (default 120). Current capital, stop-risk, exposure, daily fee/entry/loss and cooldown limits apply; entry and fee caps do not block reductions. No forced entry or risk-budget increase is introduced.

Protection and marking still use the serialized engine tick, normally ten seconds. Outstanding inference may delay the next tick. Existing positions are preserved on upgrade and then follow the new deterministic exits; stops are not reset. Old trainer overlays retire, and the trainer is advisory unless `COACH_AUTO_APPLY=true` is explicitly configured.
