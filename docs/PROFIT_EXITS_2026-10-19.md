# Profit protection and Jev exit reviews — 19 October 2026

Strategy version: `catfolio-9-profit-protection`.

The active bots now protect a profitable position in two ways. Code ratchets a cost-covering stop, an independently configured ATR trail and a peak-profit stop. Jev can also choose to hold, close the winner or take a single partial profit when the supplied evidence supports that choice. A model HOLD, error or exhausted provider budget cannot veto a triggered protective exit.

These changes implement exit behavior; they do not establish improved future returns. Earlier historical comparisons did not validate these exit settings, and their reported results must not be reused as evidence for version 9. Entry signals, capital allocation and leverage limits are unchanged by this update.

## Deploy on Arcane

1. Publish and deploy an image containing version 9, following [the Arcane deployment instructions](ARCANE.md). Changing environment values on the older image does not install this implementation. If using the mutable `edge` image tag, pull the new image and redeploy; restarting the old container alone does not fetch a new build.
2. Preserve the database volume, `DOCKER_DB_PATH`, starting capital and allocation. **No database reset is needed.** Existing fills, balances and positions remain in place.
3. The following values are the new build's defaults. Adding them to Arcane's environment is optional, but makes the chosen behavior explicit. Save and recreate/redeploy the engine after environment edits; do not run two engines against the same database.
4. Verify `/profile` reports `strategyVersion=catfolio-9-profit-protection`, and check its effective exit settings under `cats[].exits`. Check `/health`, `/snapshot` and recent decisions. Each cat's profile also describes the exit settings in its strategy facts, and fresh decision audit records identify version 9.

```dotenv
# Dark Wall-E: protect and review the faster momentum position.
TIGER_BREAKEVEN_AT_R=0.5
TIGER_BREAKEVEN_BUFFER_BPS=1
TIGER_TRAIL_ACTIVATION_R=0.75
TIGER_TRAIL_ATR_MULT=1
TIGER_PROFIT_LOCK_AT_R=1
TIGER_MAX_PROFIT_GIVEBACK_PCT=35
TIGER_PARTIAL_TAKE_PROFIT_ENABLED=true
TIGER_PARTIAL_TAKE_PROFIT_AT_R=1.5
TIGER_PARTIAL_TAKE_PROFIT_FRACTION=0.5
TIGER_EXIT_REVIEW_MIN_R=0.5
TIGER_EXIT_REVIEW_INTERVAL_SECONDS=60
TIGER_EXIT_MIN_ACTION_PROBABILITY=0.4

# Good Wall-E: allow more room for the slower four-hour trend.
MOCHI_BREAKEVEN_AT_R=1
MOCHI_BREAKEVEN_BUFFER_BPS=1
MOCHI_TRAIL_ACTIVATION_R=1.5
MOCHI_TRAIL_ATR_MULT=1.5
MOCHI_PROFIT_LOCK_AT_R=2
MOCHI_MAX_PROFIT_GIVEBACK_PCT=40
MOCHI_PARTIAL_TAKE_PROFIT_ENABLED=true
MOCHI_PARTIAL_TAKE_PROFIT_AT_R=2
MOCHI_PARTIAL_TAKE_PROFIT_FRACTION=0.5
MOCHI_EXIT_REVIEW_MIN_R=1
MOCHI_EXIT_REVIEW_INTERVAL_SECONDS=300
MOCHI_EXIT_MIN_ACTION_PROBABILITY=0.4
```

No new provider key or model is required. Keep the existing `DECISION_PROVIDER`, Jev transport/model/key and daily budget configuration. Eligible positions can generate more inference requests than entry-only decisions did, so the existing provider credits and `JEV_DAILY_USD_CAP` still matter. A provider HTTP error is not a model decision to hold.

To disable optional partial profit-taking, set the corresponding `PARTIAL_TAKE_PROFIT_ENABLED=false`; the other protections remain active. Setting `BREAKEVEN_AT_R`, `TRAIL_ACTIVATION_R` or `PROFIT_LOCK_AT_R` to zero disables that specific automatic component. `MAX_PROFIT_GIVEBACK_PCT=100` also disables peak-profit locking. `EXIT_REVIEW_MIN_R=0` disables discretionary profit reviews, including their partial-profit option. Turning off a component does not loosen a stop already ratcheted by it.

## What the thresholds measure

The denominator of R is the remaining position's **initial gross stop risk**, stored as `riskUsd`. For a new position this is contracts × contract value × the absolute distance from entry price to its initial stop. Moving the stop toward profit does not shrink that denominator. An add recalculates risk for the combined position; a reduction prorates it to the remaining contracts.

The numerator used by the new exit controls is the estimated net P&L from closing the **remaining** position now. It includes the actual average entry price, allocated opening fees, recorded position funding, the current executable bid or ask, configured adverse slippage and an estimated exit fee. Entry spread and slippage are already embedded in the entry fill price, so they are not charged again. Previously realized trims are not added to the remaining position's profit or its peak. Inference charges, future funding and funding not attributed to the position are excluded.

For example, a remaining position with $1 of initial stop risk and $0.50 of estimated closing profit has `netR=0.5`. Its gross marked gain will usually be larger because costs reduce net profit. The existing snapshot field `me.upl_r` remains gross; Jev's new `profit.net_r` and `profit.peak_net_r` are after-cost estimates.

Breakeven, ATR trailing and peak-profit locking arm from **peak net R**. Discretionary reviews and the partial-profit option require **current net R**, positive estimated net P&L and fresh usable market data. They are not enabled merely because the position was profitable earlier.

## Automatic stops

The engine compares enabled stop candidates and retains the tightest one. Long stops can only rise; short stops can only fall. Good's existing Donchian channel stop is retained as another candidate. Initial stops still use `TIGER_STOP_ATR_MULT` or `MOCHI_STOP_ATR_MULT`; the new `TRAIL_ATR_MULT` controls profit trailing separately and does not change initial sizing.

- **Cost-covering breakeven:** after the activation threshold, target enough net exit proceeds to recover allocated opening fees, recorded net funding costs and estimated closing execution costs, plus `BREAKEVEN_BUFFER_BPS` of entry notional. The buffer defaults to one basis point, or 0.01% of entry notional.
- **ATR trail:** after activation, use the best observed favorable mid-price minus one configured ATR distance for a long, or plus that distance for a short. Dark uses 15-minute ATR; Good uses four-hour ATR. An expanding ATR cannot loosen an already stored stop.
- **Peak-profit lock:** after activation, target retention of `100 - MAX_PROFIT_GIVEBACK_PCT` percent of the highest observed estimated net profit per unit. At Dark's default 35% giveback, a $2 remaining-position net peak targets at least $1.30 under the current cost estimate. This is a stop target, not a guaranteed realized amount.

The cost-covering target works symmetrically for longs and shorts. Let `Q` be remaining contracts × contract value, `E` average entry price, `F` remaining opening fees, `U` recorded funding credit (negative for a debit), `f` the exit fee rate, and `s` adverse slippage as a fraction. Let `n` be the desired net profit per unit. For breakeven with buffer, `n = E × BREAKEVEN_BUFFER_BPS / 10000`; for a peak lock, `n` is the retained portion of peak net profit per unit.

```text
long close factor  cL = (bid / mid) × (1 - s)
short close factor cS = (ask / mid) × (1 + s)

long net P&L  = Q × (mid × cL - E) - F + U - Q × mid × cL × f
short net P&L = Q × (E - mid × cS) - F + U - Q × mid × cS × f

long target stop  = [E + (F - U)/Q + n] / [cL × (1 - f)]
short target stop = [E - (F - U)/Q - n] / [cS × (1 + f)]
```

This estimates a mid-price trigger at the current spread and slippage assumptions. Wider spreads, additional funding debits or changed settings can make a previously armed retained-profit target immediately breached. The engine may then reduce or close the position; it does not move the stop backward to accommodate the loss. Markets can gap through a stop, data can be stale, and execution can fail or differ from the estimate.

## Where Jev participates

Entry evaluation remains limited to each completed 15-minute bar for Dark and four-hour bar for Good. A fresh signal bar has priority. Between bars, a qualifying winner gets at most one additional review per configured interval: 60 seconds above 0.5 net R for Dark, 300 seconds above 1 net R for Good. These extra reviews can only hold or reduce exposure; they cannot open, add or switch positions. The consumed review interval is persisted before inference, including a failed request. A new signal-bar decision also consumes a currently eligible profit interval so it does not create an extra same-interval profit request.

Jev sees current and peak net USD/R, giveback percentage, cost-covering price, the partial-profit flag, any estimated legacy cost basis, and the strategy's market indicators. It compares the offered HOLD/HOLD_WINNER, CLOSE_PROFIT and optional TAKE_PROFIT choices. Continuing directional evidence supports holding; weakening evidence and surrendered profit can support a reduction. The model selects among the available actions; it cannot invent an action, override a hard stop or guarantee a profitable outcome.

`EXIT_MIN_ACTION_PROBABILITY=0.4` is the minimum probability weight assigned to the **selected** reducing action. For example, a selected CLOSE_PROFIT with `p=0.44` passes this gate. A close that was not selected is not executed merely because its weight exceeds 0.4. These are relative weights across the offered menu, not calibrated probabilities of investment success. Entry `MIN_ACTION_PROBABILITY` and `MIN_CONVICTION` do not veto discretionary exits; 100% certainty is not required. Fresh quotes and positive estimated net profit are checked again after inference before accepting a profit action.

TAKE_PROFIT is offered only when enabled, its current net-R threshold is reached, and both the rounded reduction and the remaining position satisfy exchange minimum contract sizes. A long closes by selling; a short closes by buying back, without opening an opposite position. The partial option becomes used after a successful fill, persists across restart and cannot repeatedly halve the same position. A rejected or unfilled order does not consume it; an uncertain exchange result followed by a reconciled quantity reduction is conservatively treated as used to prevent a second partial. Good's separate one-time score-deterioration TRIM_HALF still exists; it can execute in addition to the profit trim. Either completed trim prevents Good from adding the removed exposure back. While TAKE_PROFIT is on the menu, Good does not also offer ADD_TO_WINNER.

Trade-count and fee-budget caps cannot block reducing an existing position. Loss limits, maximum holding time, signal invalidation and protective stops retain priority over discretionary model choices. An exhausted Jev budget or provider outage prevents new model-selected reductions but leaves automatic protection available.

Protection is evaluated inside the existing **serialized trading tick**, scheduled by `DECISION_INTERVAL_MS`. It is independent of Jev's approval, but it does not run on a separate uninterrupted timer. An outstanding model or network request can delay the next tick. An already-triggered protective exit skips its own inference request; stale quotes, gaps and execution failures can still delay or worsen a sale.

## Persistence, upgrades and trainer scope

Normal restarts retain ratcheted stops, observed net-profit peaks, consumed review intervals and filled profit trims. An add changes the combined position's cost basis and resets its observed profit peak; a trim prorates fees, funding and risk while retaining the per-unit peak. New opening fees and attributable funding are tracked from fills and funding events.

Positions opened before version 9 use estimated opening fees if their actual remaining fee basis is unavailable; Jev sees `cost_basis_estimated=1`. Missing prior position funding is not invented, and historical net-profit peaks cannot be reconstructed from the current position alone. The new observation history begins with the first usable post-upgrade quote, while existing protective stops stay in place. Later changes to exit settings can apply immediately to persisted peaks. Existing positions may close on the first tick after an upgrade or configuration change.

All twelve new controls are owner settings, available separately for each bot. They are not trainer-tunable numeric parameters. The trainer may discuss choices among offered actions using the profit context; neither trainer text nor a model HOLD overrides deterministic protection. `COACH_AUTO_APPLY=false` remains the default. Version 9 retires incompatible prior trainer overlays and starts a new strategy evidence cohort without deleting balances, fills or review history. Extra between-bar profit reviews do not count toward the 30 completed signal-bar observations required for trainer readiness.

Evaluate version 9 using new completed trades, returns after costs, drawdown and how much observed profit was retained. Faster selling and tighter stops can also cut off continuing winners. The defaults are explicit, testable starting points; neither these settings nor mechanical tests prove a return improvement.
