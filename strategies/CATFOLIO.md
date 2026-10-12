# Catfolio configurable strategies

Current strategy version: `catfolio-7-configurable-strategies`; rubric version: `selected-setup-conviction-2`. The lifecycle originated from [beebots 6d3fe0d](https://github.com/imikerussell/beebots/tree/6d3fe0d4f72dd25676c2f5caac0b83dff05031fb). Current strategies deliberately differ from that baseline. The historical Bizzy/Breezy modules and frozen engine/risk references remain for comparison, not as the active strategy contract.

## Strategies

- Dark (`tiger`): symmetric one-hour momentum and 15-minute MACD across its allowed coins. Configurable absolute and ATR-relative momentum thresholds, continuous conviction and selected-action probability gates, 15-minute ATR stops and maximum holding time. WAIT, HOLD, CLOSE and qualified reversals remain supported. No forced entries.
- Good (`mochi`): nine Donchian channels on four-hour BTC/ETH bars. Configurable minimum directional score, conviction/probability gates, score/volatility sizing, four-hour ATR stops, one trim per position, qualified winner adds and maximum holding time. It waits without an accepted entry and closes on a qualified opposite trend. No forced entries, minimum exposure floor or automatic rebalancing.

Both obey owner-defined stop-risk budgets including estimated round-trip costs, in addition to notional/leverage caps and lot minimums. The trainer can change only the supported numeric strategy fields within published bounds; capital and loss limits remain fixed by the owner. See [CONFIGURATION](../docs/CONFIGURATION.md) for exact settings, evidence checks, persistence and migration.

## Execution and protection

The engine uses a serialized trading tick, normally ten seconds, and a separate history refresh. Stops, loss/retirement limits, maximum holding times and Good's trend-reversal exit are deterministic. An already-triggered close bypasses its model call. There is still no independently scheduled protective order loop; outstanding inference can delay later ticks. Model failure prevents new exposure.

Daily entry/fee caps suppress openings, while deterministic exits remain available. Adds do not increment the new-position counter; switches/new entries do. A partial/rejected close cannot open the second leg of a switch. A filled trim records its one-time flag in the persisted position. Trainer changes invalidate in-flight decisions; numeric changes require a flat account.

Paper execution uses fresh quotes, bid/ask, adverse slippage and fees. Funding is an eight-hour approximation with no downtime backfill. Liquidation, queue/depth and market impact are not simulated. The fill, initial stop and account save are not one crash-atomic exchange transaction; these changes do not establish crash-atomic execution guarantees.

## Verification

Tests exercise both long/short directions, parameter changes affecting real menus and risk actions, stop-risk sizing, fee estimates, lot floors, weak-entry abstention, persistent one-time trims, winner adds, timed and trend-reversal exits during outages, caps, partial closes, restarts, trainer evidence/step/bounds checks and numeric rollback. Deterministic multi-tick replay checks orders and balances. Frozen source comparisons remain for retained legacy paths; byte-for-byte parity is no longer a requirement for the current engine.

These checks verify mechanics. They do not establish profitable thresholds, a durable trading advantage or the quality of live trainer optimization. Preserve the existing ledger and compare new-strategy outcomes after costs before increasing capital or leverage.
