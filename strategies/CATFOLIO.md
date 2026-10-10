# Catfolio: upstream engine restoration

Source baseline: [imikerussell/beebots commit 6d3fe0d4f72dd25676c2f5caac0b83dff05031fb](https://github.com/imikerussell/beebots/tree/6d3fe0d4f72dd25676c2f5caac0b83dff05031fb), the upstream commit immediately before the Catfolio conversion. Strategy version: `catfolio-5-source-engine`.

## What runs

`src/engine.ts` is restored from that upstream file: lifecycle, serialized ticks, menus and model calls, benched-cap handling, funding, reconciliation, profit locks, close/resume behavior, order construction and fill processing. `src/risk.ts`, `src/lab/brain.ts`, `src/bees/bizzy.ts`, `src/bees/breezy.ts`, `src/bees/custom.ts` and `src/snapshot.ts` match the baseline exactly.

- Dark Wall-E (`tiger`) runs Bizzy: daily long-only breakout, original stops and sizing, one new position/day by default, exit at 23:59 UTC.
- Good Wall-E (`mochi`) runs Breezy: nine Donchian horizons on four-hour bars, BTC/ETH, both directions, volatility sizing with the original floor, +1R adds, three-point directional trims, flips, coin switches, channel trailing, flat forcing and target rebalancing. Three new positions/day by default.

The engine file has only these deliberate differences from the baseline:

1. Dependency imports use structural interfaces for the Catfolio database/provider/coach adapters.
2. Initial capital, reported returns and daily-loss context use each cat's configured allocation.
3. Slippage is recorded for Catfolio reports.
4. A switch cannot open its new leg if the close left any existing position. This fixes the upstream partial-close case.

`src/catfolio-engine.ts` surrounds that engine with provider selection, the 20-hour owner-approved trainer, audit records, dashboard events, capital validation and graceful shutdown. It does not implement another trading tick, action-selection path or protection loop. `src/cats.ts` binds cat identities and supplies descriptions/diagnostics through the upstream rules/coin wrapper.

## Source behavior and integration boundaries

A single serialized trading tick defaults to 10 seconds; market-history refresh defaults to 60 seconds. Stops and other deterministic exits run inside those trading ticks. An outstanding model request delays the next tick and its protection checks until the request resolves or times out. There is no independent five-second protection loop. Empty menus and a lone legal hold do not call the model; already-benched trade/fee caps use the original deterministic management path.

Source risk ordering is unchanged: stops/loss/retirement, model failure holds, discretionary opening gates, flat forcing, then position rebalancing. Forced entry and rebalance intentionally do not use the discretionary opening cooldown. Adds do not increment the new-position counter; switches do.

Source sizing uses leverage x equity x 0.97, capped by `MAX_NOTIONAL_USD_PER_BEE`. Catfolio's explicit per-cat notional ceilings remain supported (default 200%). Accounts retain configured capital and daily loss limits (default 8%). The replacement engine's stop-risk sizing, bullish-only gate, minimum trend score, short-term confirmation, fee-distance filter and two-/six-hour exits are absent.

The market feed still validates completed candles and previous-day ranges; execution adapters still validate quotes. Lot sizing retains finite-value validation and floors orders to stay within their budget; the paper simulator retains configured adverse slippage (default 2 bps). These are retained execution/data differences from upstream. Provider requests retain transport timeouts and response validation. The adapter rejects a response when coach rules changed during the request. These integrations do not reintroduce the replacement engine's per-coin risk gates, stale-response age checks or separate protective scheduler.

Persistence follows the source engine's ordering: decisions, orders, execution, ledger/fill updates and account saves. A fill and its initial stop/account save are not one atomic transaction. Do not assume the replacement engine's crash-atomic fill guarantee. The adapter preserves allocation checks and rejects interrupted paper orders on startup; it does not reconstruct missing ledger updates after a process crash.

## Upgrade and verification

Set `DECISION_INTERVAL_MS=10000` for the upstream cadence. `PROTECTIVE_INTERVAL_MS` and `MAX_DECISION_AGE_MS` no longer control the engine. Existing explicit leverage, notional, trade-cap and cooldown overrides still apply; compare the deployed environment with `.env.example`. Database history, balances and positions are preserved without replacement capital. Earlier strategy migrations and trainer review history remain intact.

Regression tests run the restored and frozen upstream engines through the same multi-tick scenarios and compare model requests, orders, decisions, caps, balances and positions. Coverage includes entries, holds, empty menus, shorts, flips, switches, trims, rebalances, benched caps, rollover, model outages, budget caps, stops, stale data, daily loss, retirement and experiment closure. File comparisons allow only the explicit integration differences listed above. Adapter tests cover dashboard/audit reporting, persistence, allocation checks, coach changes and partial/rejected closes. These tests verify behavior, not profitability.
