# Effective configuration and trainer controls

Applies to `catfolio-7-configurable-strategies`. `.env.example` lists supported settings. Arcane's saved environment is the deployment source; editing a local `.env` does not update Arcane. Restart the engine after editing its environment, preserving the database volume and starting allocation. `DRY_RUN=true` / `MODE=paper` keeps execution simulated. The supplied Compose files enforce paper mode.

## Owner limits and actual sizing

`MAX_LEVERAGE`, `MAX_NOTIONAL_USD_PER_BEE` and each cat's `MAX_NOTIONAL_PCT` cap exposure. The maximum notional is the minimum of leverage × current equity × 0.97, the dollar ceiling, and the per-cat equity percentage. Leverage is a ceiling, not an instruction to fill it.

`TIGER_STOP_RISK_PCT` and `MOCHI_STOP_RISK_PCT` now really limit new exposure: equity × risk percentage divided by stop-distance fraction plus estimated round-trip fees, spread and adverse slippage. Adds also account for existing stop risk. Lot rounding only reduces size; a budget below the exchange minimum skips the order. Gaps, funding and execution differences can exceed this estimate; it is not a guaranteed loss limit. Existing positions are not forcibly resized on upgrade.

Good also caps size at absolute trend score / 9 of maximum notional and equity × `MOCHI_VOL_TARGET_PCT` / measured annualized volatility. The old 50% sizing floor and forced minimum dollar size are gone. Larger exposure does not establish better expected returns.

Capital allocation, leverage, stop-risk budgets, loss limits, trade/fee limits, cooldowns, spread/liquidity gates, stop ATR multipliers, holding limits, execution mode and API credentials are **owner-controlled**. The trainer cannot edit them. Both long and short trades remain supported.

## Strategy parameters

| Environment setting | Effect | Trainer range / maximum change per review |
|---|---|---|
| `TIGER_MIN_CONVICTION`, `MOCHI_MIN_CONVICTION` | Minimum continuous expected rubric score, 0–3; never rounded | 0.25–3 / 0.25 |
| `TIGER_MIN_ACTION_PROBABILITY`, `MOCHI_MIN_ACTION_PROBABILITY` | Minimum probability assigned to the selected entry or reversal | 0.10–0.95 / 0.05 |
| `TIGER_MIN_MOMENTUM_PCT` | Minimum absolute one-hour return in percent | 0.05–1 / 0.05 |
| `TIGER_MOMENTUM_ATR_MULT` | ATR-relative momentum threshold; actual minimum is max(this × 15-minute ATR%, minimum momentum%) | 0.1–2 / 0.1 |
| `MOCHI_MIN_TREND_SCORE` | Minimum absolute nine-channel Donchian score; only matching-direction entries are offered | 1–9 / 1, integers |
| `MOCHI_VOL_TARGET_PCT` | Annualized volatility sizing target, percent | 10–60 / 5 |
| `MOCHI_TRIM_SCORE_DROP` | Directional score decline from entry that offers one half-trim | 1–6 / 1, integers |
| `TIGER_STOP_ATR_MULT`, `MOCHI_STOP_ATR_MULT` | Initial stop distance; Dark uses 15-minute ATR, Good four-hour ATR | Owner only |
| `TIGER_MAX_HOLD_MINUTES`, `MOCHI_MAX_HOLD_MINUTES` | Deterministic maximum holding time, including outages and capped accounts | Owner only |

The owner may configure values within the broader validation ranges in `src/config.ts`. Trainer bounds are deliberately narrower. Defaults remain experimental baselines, not optimized or profitability-validated settings.

Both strategies can WAIT and neither forces an entry. Good checks fresh indicators, complete channels, volatility, volume and spread; it closes on a qualified opposite trend. It can trim once per position, remembers that trim across restart, and never automatically buys the trimmed exposure back. Adds require a winner above +1R, a valid current trend, available target size and stop-risk room.

## Trainer lifecycle

The trainer may change rules, allowed coins and **at most one numeric strategy parameter every four hours per cat**. It receives the exact current values and bounds. Numeric changes require a flat position, a matching `from` value and a permitted step. Risk/credential fields and cross-cat parameter names are rejected by schema or validation.

Relaxing an entry threshold requires at least 30 relevant recorded vetoes/blockers and current fresh signals with no unrelated blockers. Other numeric changes require at least five fully completed trades under the current strategy. Thousands of repeated HOLD decisions do not count as completed trades. These checks establish minimum evidence, not a statistical guarantee of improvement.

Evidence covers at most 24 hours and starts again after the latest accepted change or reset. Completed-trade P&L includes actual simulated fills and fees; slippage is already in fills. Funding and inference costs remain separate in the account/report. The prompt prioritizes net results and drawdown over activity, asks the trainer to assess subsequent outcomes and reverse unsuccessful experiments, and permits no change. There is no guaranteed optimizer or automatic statistical rollback system.

Applied values persist in the database. The dashboard shows the effective parameters, each numeric `from → to` change, and review history. Owner reset restores baseline rules, coins and all numeric values. An explicit environment baseline change supersedes an older saved overlay at restart. In-flight model answers become invalid when trainer settings change.

Version 7 retires both bots' old trainer overlays while keeping review history, balances, positions and fills. Old strategies' observations do not justify new parameter changes. Existing positions immediately become subject to the configured holding limits, so an older Good position may close on the first tick after upgrade. Protection remains inside the serialized trading tick; an already-triggered exit skips its model request, but another outstanding request can still delay subsequent ticks.

## Remove obsolete settings

These names are ignored with explicit startup warnings and appear in snapshot `configurationWarnings` until removed:

```text
PROTECTIVE_INTERVAL_MS
MAX_DECISION_AGE_MS
TIGER_MIN_TREND_SCORE
TIGER_MAX_CHASE_RANGE_FRAC
TIGER_MAX_FUNDING_PCT
TIGER_MAX_FLAT_MINUTES
MOCHI_MAX_FLAT_MINUTES
BREEZY_MIN_SIZE_USD
```

Use `DECISION_INTERVAL_MS` for the serialized trading/protection cadence. Dark uses momentum and MACD, not the retired daily-breakout chasing/funding filter. Good uses four-hour bars, not the old hourly replacement strategy. Duplicate environment keys should be removed; retain one explicit value per setting.

## Validate a deployment

After publishing and restarting the chosen build, verify `/health`, `/profile`, `/snapshot`, `/coach` and `/report`. Check strategy facts, owner limits, numeric trainer values and warnings against the saved Arcane environment. Do not reset the database to apply these changes. Compare sufficient new-strategy closed trades and after-cost returns before changing capital or leverage; the test suite verifies mechanics, not future returns.
