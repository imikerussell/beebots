> **Argon update (21 October 2026):** For Gemini and the upstream strategies, use [the migration guide](UPSTREAM_ARGON_2026-10-21.md). Set `DECISION_PROVIDER=gemini` and `STRATEGY_ENGINE=upstream` explicitly. The signal and profit-review knobs described below belong to `STRATEGY_ENGINE=catfolio`. The independent protective watch runs for both engines. Existing environment values override new defaults.

# Effective configuration and trainer controls

Applies to `catfolio-9-profit-protection`. `.env.example` lists supported settings. Arcane's saved environment is the deployment source; editing a local `.env` does not update Arcane. Deploy the new image before configuring the new exit controls, then restart the engine after environment changes while preserving the database volume and starting allocation. `DRY_RUN=true` / `MODE=paper` keeps execution simulated. The supplied Compose files enforce paper mode. See the [profit-exit implementation and copyable Arcane settings](PROFIT_EXITS_2026-10-19.md), [strategy audit](STRATEGY_REVIEW_2026-10-16.md) and [retrospective comparison](STRATEGY_BACKTEST_2026-10-16.md); no profitable portfolio has been established.

## Owner limits and actual sizing

`MAX_LEVERAGE`, `MAX_NOTIONAL_USD_PER_BEE` and each cat's `MAX_NOTIONAL_PCT` cap exposure. The maximum notional is the minimum of leverage × current equity × 0.97, the dollar ceiling, and the per-cat equity percentage. Leverage is a ceiling, not an instruction to fill it.

`TIGER_STOP_RISK_PCT` and `MOCHI_STOP_RISK_PCT` now really limit new exposure: equity × risk percentage divided by stop-distance fraction plus estimated round-trip fees, spread and adverse slippage. Adds also account for existing stop risk. Lot rounding only reduces size; a budget below the exchange minimum skips the order. Gaps, funding and execution differences can exceed this estimate; it is not a guaranteed loss limit. Existing positions are not forcibly resized on upgrade.

Good also caps size at absolute trend score / 9 of maximum notional and equity × `MOCHI_VOL_TARGET_PCT` / measured annualized volatility. The old 50% sizing floor and forced minimum dollar size are gone. Larger exposure does not establish better expected returns.

Capital allocation, leverage, stop-risk budgets, loss limits, trade/fee limits, cooldowns, spread/liquidity gates, initial and trailing stop settings, profit protection, partial profit-taking, exit-review cadence and probability gates, holding limits, execution mode and API credentials are **owner-controlled**. The trainer cannot edit them. Both long and short trades remain supported.

## Strategy parameters

| Environment setting | Effect | Trainer range / maximum change per review |
|---|---|---|
| `TIGER_MIN_CONVICTION`, `MOCHI_MIN_CONVICTION` | Minimum continuous expected rubric score, 0–3; never rounded | 0.25–3 / 0.25 |
| `TIGER_MIN_ACTION_PROBABILITY`, `MOCHI_MIN_ACTION_PROBABILITY` | Minimum probability assigned to the selected entry; this is not a win probability | 0.10–0.95 / 0.05 |
| `TIGER_MIN_MOMENTUM_PCT` | Minimum absolute one-hour return in percent | 0.05–1 / 0.05 |
| `TIGER_MOMENTUM_ATR_MULT` | ATR-relative momentum threshold; actual minimum is max(this × 15-minute ATR%, minimum momentum%) | 0.1–2 / 0.1 |
| `MOCHI_MIN_TREND_SCORE` | Minimum absolute nine-channel Donchian score; only matching-direction entries are offered | 1–9 / 1, integers |
| `MOCHI_VOL_TARGET_PCT` | Annualized volatility sizing target, percent | 10–60 / 5 |
| `MOCHI_TRIM_SCORE_DROP` | Directional score decline from entry that offers one half-trim | 1–6 / 1, integers |
| `TIGER_STOP_ATR_MULT`, `MOCHI_STOP_ATR_MULT` | Initial stop distance; Dark uses 15-minute ATR, Good four-hour ATR | Owner only |
| `TIGER_MAX_HOLD_MINUTES`, `MOCHI_MAX_HOLD_MINUTES` | Deterministic maximum holding time, including outages and capped accounts | Owner only |
| `TIGER_SIGNAL_MODE` | `momentum` (default), `trend_momentum` or `trend_breakout`; alternatives remain experimental | Owner only |
| `TIGER_TREND_FAST_HOURS`, `TIGER_TREND_SLOW_HOURS` | Hourly EMA regime, defaults 20/50; used by the two trend modes | Owner only |
| `TIGER_BREAKOUT_BARS`, `TIGER_EXIT_BARS` | Prior completed 15-minute entry/exit channels, defaults 20/10; breakout mode only | Owner only |
| `TIGER_MIN_STOP_COST_RATIO`, `MOCHI_MIN_STOP_COST_RATIO` | Minimum ATR stop distance divided by estimated round-trip costs; default 3 | Owner only |
| `TIGER_MAX_ENTRY_CHASE_ATR`, `MOCHI_MAX_ENTRY_CHASE_ATR` | Maximum adverse move from the completed close before entry, in ATR units; default 0.5 | Owner only |
| `TIGER_MAX_ENTRY_CANDIDATES`, `MOCHI_MAX_ENTRY_CANDIDATES` | Ranked candidates offered alongside WAIT; default 1, maxima 12/2 | Owner only |

The owner may configure values within the broader validation ranges in `src/config.ts`. Trainer bounds are deliberately narrower. Defaults remain experimental baselines, not optimized or profitability-validated settings.

Both strategies can WAIT and neither forces an entry. The signal modes, channel horizons and execution filters are owner controls so a trainer cannot silently change the hypothesis being tested. The two momentum parameters are omitted from trainer controls in breakout mode, where they have no effect. Cost feasibility is not an estimate of future profit; funding is separate from this execution-cost estimate.

Dark gets at most one entry evaluation per completed 15-minute bar; Good gets one per completed four-hour bar. The consumed bar persists before inference, including provider errors and vetoes, so a restart or ten-second tick cannot resample the same opportunity. Markets missing the current completed candle are omitted for that bar. Owner/configuration changes create a new decision revision. Fresh signal-bar decisions have priority; eligible winning positions also receive separate model profit reviews between bars. A signal decision consumes any currently eligible profit-review interval, avoiding an extra same-interval profit request. Protection, mark-to-market and loss/time stops run within the serialized `DECISION_INTERVAL_MS` tick; an outstanding request can delay the next tick. This setting does not control signal frequency. Waiting protection pulses and extra between-bar profit reviews do not count as independent completed-bar trainer observations.

Dark exits deterministically when both return and MACD turn against it, or the configured breakout exit fails. Good exits when its signed trend score reaches zero or turns against it. Good also rejects entries whose live price has already crossed the channel stop. Jev can choose an eligible profit close or partial profit trim while the signal still persists; it cannot veto a protective exit or immediately flip a position. Good's score-deterioration trim and optional profit trim can each occur once per position, persist across restart, and prohibit subsequent adds. Otherwise adds require a winner above +1R, a valid current trend, available target size and stop-risk room. Profit reviews allow only HOLD, closes and trims, so they cannot add exposure. Existing maximum holds remain 120/360 minutes by default; longer experimental holds are never enabled automatically.

## Profit protection and model exits

The new build enables these defaults automatically. Explicit Arcane values are optional; use them to make the deployment settings visible. Each suffix below accepts both `TIGER_` and `MOCHI_`. All twelve controls are owner-only.

| Environment suffix | Dark default | Good default | Effect |
|---|---:|---:|---|
| `BREAKEVEN_AT_R` | 0.5 | 1 | Peak estimated net R that arms a cost-covering stop; 0 disables |
| `BREAKEVEN_BUFFER_BPS` | 1 | 1 | Additional buffer in basis points of entry notional |
| `TRAIL_ACTIVATION_R` | 0.75 | 1.5 | Peak estimated net R that arms independent ATR trailing; 0 disables |
| `TRAIL_ATR_MULT` | 1 | 1.5 | Trailing distance, separate from the initial `STOP_ATR_MULT`; 15-minute ATR for Dark, four-hour ATR for Good |
| `PROFIT_LOCK_AT_R` | 1 | 2 | Peak estimated net R that arms peak-profit protection; 0 disables |
| `MAX_PROFIT_GIVEBACK_PCT` | 35 | 40 | Portion of peak net profit the stop may surrender; 100 disables this protection |
| `PARTIAL_TAKE_PROFIT_ENABLED` | true | true | Offer Jev a partial profit trim when eligible; false disables the option |
| `PARTIAL_TAKE_PROFIT_AT_R` | 1.5 | 2 | Current estimated net R required for the partial option |
| `PARTIAL_TAKE_PROFIT_FRACTION` | 0.5 | 0.5 | Fraction of remaining contracts to close, rounded down to exchange lot size |
| `EXIT_REVIEW_MIN_R` | 0.5 | 1 | Current estimated net R required for discretionary profit review; 0 disables reviews |
| `EXIT_REVIEW_INTERVAL_SECONDS` | 60 | 300 | One eligible model review per interval, persisted before inference |
| `EXIT_MIN_ACTION_PROBABILITY` | 0.4 | 0.4 | Minimum weight assigned to the selected discretionary reducing action; entry conviction does not apply |

R uses the remaining position's initial gross stop risk as its denominator; profit used by the new controls is **after estimated closing fees, current spread and adverse slippage, remaining opening fees and recorded position funding**. Initial fill prices already contain their spread/slippage, so these are not charged twice. Inference costs and unrecorded/future funding are excluded. The old `upl_r` snapshot field remains gross; new `profit.net_r` and `profit.peak_net_r` are after-cost estimates. A lower trailing ATR multiplier tightens the trail without changing entry sizing or the initial stop.

The tightest enabled barrier wins and stops never move away from the position's profitable direction. Good retains its channel trail as another candidate. Jev receives current and peak estimated net profit, giveback, cost-covering stop price, whether a profit trim happened, and whether legacy entry costs were estimated. It chooses HOLD, CLOSE_PROFIT or eligible TAKE_PROFIT using directional evidence and giveback. A selected exit with `p=0.44` passes the default `0.4` threshold; this is a relative menu weight, not a 44% chance of making money. No 100% certainty or entry conviction score is required.

Partial profit-taking is optional and model-selected. It is consumed only by a filled profit trim, requires both the sold and remaining contracts to meet exchange minimums, and does not repeatedly halve the position. Trade-count and fee caps do not block reducing exposure. Provider errors, exhausted credits or a model HOLD leave deterministic protection available on the next valid tick; they do not bypass stop execution. Protection is not a separate real-time timer: in-flight network/model work, stale quotes, gaps and execution failures can delay or worsen exits. The limits target behavior, not guaranteed sale prices or profits.

## Reset an exhausted entry allowance

Each cat's dashboard card offers **Reset entry limit** when its entry allowance is exhausted. Enter the owner key configured as `COACH_ADMIN_TOKEN`. The reset grants another batch of up to that cat's `MAX_ENTRIES_PER_DAY`, expiring at 00:00 UTC. No new environment setting is needed and the trainer does not need to be enabled.

The dashboard shows allowance usage separately from actual entries today. Resets preserve real entry counts, positions, fills, P&L, fees, cooldowns and strategy settings; they do not place an order. Fee budgets, loss stops and retirement cannot be reset with this control. A zero entry limit stays disabled. Each reset is persisted with an audit record and survives restart. Double submissions are rejected once the allowance is renewed. If a trading tick is in progress, retry once it finishes.

The authenticated endpoint is `POST /controls/reset-entry-limit` with JSON `{"cat":"tiger"}` or `{"cat":"mochi"}` and the header `Authorization: Bearer <owner key>`. The browser keeps the key only in the open form and clears it on success or close.

## Trainer lifecycle

`COACH_ENABLED=true` enables scheduled reviews. **`COACH_AUTO_APPLY=false` is the new default:** reviews are recorded as **Suggestion only** and do not change rules, coins or parameters. There is no pending-approval flow. Starting in advisory mode restores the environment baseline and retires any previously saved automatic overlay, preserving review history. `COACH_AUTO_APPLY=true` explicitly permits experimental rule/coin changes and **at most one numeric strategy parameter per review**, no more often than every four hours per cat. Numeric changes require a flat position, a matching `from` value and a permitted step. Risk/credential fields and cross-cat parameter names are rejected by schema or validation.

Every numeric change requires at least five fully completed trades under the current strategy. Relaxing an entry threshold additionally requires positive completed-trade net P&L after fees, at least 30 relevant veto/blocker episodes and a current fresh signal with no unrelated blockers. Funding and inference costs are not allocated to individual trades, so positive after-fee P&L does not establish all-cost profitability. These are minimum evidence checks, not statistical proof.

Readiness and evidence cover at most seven days and start again after the latest accepted change or reset. Reviews require 30 distinct completed signal-bar observations, excluding idle protection pulses and profit reviews; this takes roughly 7.5 hours for Dark and five days for Good when observations are available. Repeated records from one bar count once. Completed-trade P&L includes actual fills and all opening/add/trim/closing fees; slippage is already in fills. Funding and inference costs remain separate in the report. The prompt prioritizes net results and drawdown over activity and permits no change. There is no guaranteed optimizer or automatic statistical rollback system.

Applied values persist in the database. The dashboard shows the effective parameters, each numeric `from → to` change, and review history. Owner reset restores baseline rules, coins and all numeric values. An explicit environment baseline change supersedes an older saved overlay at restart. In-flight model answers become invalid when trainer settings change.

Version 9 retires both bots' old trainer overlays while keeping review history, balances, positions and fills. Old strategies' observations do not justify new parameter changes. Existing positions become subject to the configured profit protection immediately; an older position may close on the first tick after upgrade. Existing ratcheted stops are retained. New positions record their opening fees and funding; older positions estimate missing opening fees and cannot reconstruct unrecorded position funding or historical peaks. Peak profit, tightened stops, consumed review intervals and completed profit trims survive normal restarts. Protection remains inside the serialized trading tick; an already-triggered exit skips its model request, but another outstanding request can still delay subsequent ticks. No database reset is needed.

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
