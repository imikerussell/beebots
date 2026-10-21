# Catfolio configurable strategies

Current strategy version: `catfolio-9-profit-protection`; rubric version: `selected-setup-conviction-2`. The lifecycle originated from [beebots 6d3fe0d](https://github.com/imikerussell/beebots/tree/6d3fe0d4f72dd25676c2f5caac0b83dff05031fb). Current strategies deliberately differ from that baseline. The historical Bizzy/Breezy modules and frozen engine/risk references remain for comparison, not as the active strategy contract.

## Strategies

- Dark (`tiger`): default symmetric one-hour momentum and 15-minute MACD; optional hourly-regime momentum or channel-breakout experiments. One entry attempt per completed 15-minute bar, top candidate versus WAIT, cost/chase filters, ATR stops and maximum holding time. Deterministic signal exits and separate model profit reviews; no immediate flips.
- Good (`mochi`): nine Donchian channels on four-hour BTC/ETH bars. One attempt per completed four-hour bar, cost/chase/already-crossed-channel-stop filters, configurable score and conviction/probability gates, score/volatility sizing, four-hour ATR stops, one trim and qualified winner adds. Signed score <=0 closes the held direction. No immediate flips/switches, forced entries, minimum exposure floor or automatic rebalancing.

Both obey owner-defined stop-risk budgets including estimated round-trip costs, in addition to notional/leverage caps and lot minimums. The trainer is advisory by default; explicit automatic mode may change only allowed strategy fields within bounds and evidence checks. Capital and loss limits remain fixed by the owner. See [CONFIGURATION](../docs/CONFIGURATION.md).

Both use [cost-aware profit protection](../docs/PROFIT_EXITS_2026-10-19.md): buffered breakeven, independent ATR profit trailing, a configurable net-profit giveback target and optional one-time partial profit-taking. Jev evaluates qualifying winners between signal bars at separate configured intervals. Selected reducing actions use an exit probability gate without entry conviction; hard protection cannot be vetoed by the model. Extra profit reviews do not count as entry-strategy evidence for the trainer.

## Execution and protection

The engine uses a serialized protection/trading tick, normally ten seconds, and a separate history refresh. Consumed signal bars persist before inference, preventing repeated model sampling or same-bar reopening after a stop/restart. Stops, loss/retirement limits, holding limits and signal exits are deterministic. An already-triggered close bypasses its model call. Outstanding inference can still delay later ticks. Model failure prevents new exposure.

Daily entry/fee caps suppress openings, while deterministic and model-selected reductions remain available. Adds do not increment the new-position counter; switches/new entries do. A partial/rejected close cannot open the second leg of a switch. A filled trim records its one-time flag in the persisted position. Trainer changes invalidate in-flight decisions; numeric changes require a flat account.

Paper execution uses fresh quotes, bid/ask, adverse slippage and fees. Funding is an eight-hour approximation with no downtime backfill. Liquidation, queue/depth and market impact are not simulated. The fill, initial stop and account save are not one crash-atomic exchange transaction; these changes do not establish crash-atomic execution guarantees.

## Verification

Tests exercise both long/short directions, parameter changes affecting real menus and risk actions, stop-risk sizing, fee estimates, lot floors, weak-entry abstention, persistent one-time trims, winner adds, timed and trend-reversal exits during outages, caps, partial closes, restarts, trainer evidence/step/bounds checks and numeric rollback. Deterministic multi-tick replay checks orders and balances. Frozen source comparisons remain for retained legacy paths; byte-for-byte parity is no longer a requirement for the current engine.

These checks verify mechanics. They do not establish profitable thresholds, a durable trading advantage or the quality of live trainer optimization. Preserve the existing ledger and compare new-strategy outcomes after costs before increasing capital or leverage.
