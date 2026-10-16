# Portfolio strategy review — 16 October 2026

Objective: **best returns after costs with controlled drawdowns**, using the current capital and leverage limits. The evidence supports correcting execution and evaluation defects. It does not establish a profitable replacement portfolio. All changes described here are local project changes; this investigation did not deploy a build, change the running account, place orders or call a paid inference provider.

## What the deployed paper portfolio actually did

Read-only `/report`, `/snapshot`, `/profile`, `/coach` and recent `/history` were captured from the deployed dashboard around 09:24 UTC on 16 October. The run had lasted approximately 5.84 days. These are account observations, not backtest results:

| Measure | Dark Wall-E | Good Wall-E |
|---|---:|---:|
| Starting allocation | $250 | $250 |
| Equity at capture | $239.12 | $248.73 |
| Trading net P&L | **−$10.88 (−4.35%)** | **−$1.27 (−0.51%)** |
| Trading fees | $7.19 | $0.27 |
| Estimated decision API cost, separate | $0.87 | $1.09 |
| Net including that API estimate | −$11.74 | −$2.36 |
| Entries / exits | 70 / 69 | 8 / 8 |
| Total exposure | 17.14 hours | 57.48 hours |
| Maximum observed drawdown | 4.94% | 0.79% |

Dark's total exposure divided by entries is approximately 14.7 minutes per entry. That is an aggregate ratio, not the median completed-trade duration. Its $7.19 of fees is material relative to the $10.88 loss, while trading was also losing before fees. Adding leverage or taking more entries would scale an unproven or negative edge.

The actual deployment had a 2× leverage ceiling and 200% per-cat notional cap, unlike the older pasted configuration's 1×/50%. Dark allowed 16 entries per day, not eight. Good's trainer had reduced its minimum score to two and conviction to 1.25. The runtime settings matter more than old environment snippets.

Execution was **paper simulation using OKX crypto derivative market data**, not real futures orders. Leverage caps permit leveraged exposure; they do not require using it. Stop-risk sizing often binds first. For example, $250 × 0.5% risk = $1.25. A 1% stop plus 0.15% estimated execution costs permits only about $108.70 notional before other caps. Underexposure alone does not explain poor returns.

Only recent history was available through the capped endpoint; the full deployed SQLite ledger was not available locally. Therefore this audit cannot honestly attribute every historical loss to a specific exit, market or model decision. The new report reconstruction supplies that attribution when deployed against the original ledger.

## Findings mapped into the project

| Finding | Consequence | Implemented change |
|---|---|---|
| Jev reconsidered 15-minute/four-hour signals every ten seconds | Repeated sampling of the same evidence, extra API costs and opportunities to churn | Persist one consumed decision per completed signal bar, including failures/vetoes and restart; protection still runs each engine tick |
| Dark could CLOSE a continuing trade or immediately FLIP; Good could also exit/switch discretionarily | Short holds and execution costs without a new completed-bar thesis | Deterministic signal invalidation exits; model HOLD while the signal persists; no immediate flips/switches |
| Completed-bar returns/ATR/MACD were mixed with live last price | Feature values changed without a new candle | Use confirmed candle closes for signal calculations; live quotes still drive execution and protection |
| One-hour OI change could use the oldest sample from two hours | The model received a mislabeled feature | Use the nearest sample to one hour, within five minutes |
| No explicit cost/chase feasibility gate | Tiny moves or late entries could be consumed by execution costs | Configurable stop/cost ratio and adverse chase limits for both cats; visible diagnostic values |
| Good could enter after crossing its existing Donchian trail | Immediate next-tick stop-out and another round of fees | Reject a live price already beyond the directional channel stop |
| Choice probability depended on an expanding menu | Thresholds mixed market selection with willingness to trade | Rank candidates deterministically; default top candidate versus WAIT; configurable candidate count |
| Trainer could relax entry gates from blocked decisions without profitable completed trades | Activity could be mistaken for improvement | Advisory default; automatic relaxation requires completed current-version outcomes, positive after-fee net and relevant blockers |
| 24-hour trainer evidence could not contain 30 Good four-hour observations | Trainer would never become ready after cadence correction | Seven-day window, distinct bar episodes, reset after applied changes; no protection-pulse inflation |
| Exit fills were insufficient as a proxy for trade outcomes | Partial fills, adds/trims and strategy changes distorted attribution | Reconstruct full round trips and all fill fees; report expectancy, profit factor, holding duration and turnover by coin, side, exit and strategy version |

Important boundaries: the cost filter compares execution costs with stop distance, **not expected profit**. One-candidate menus change the meaning of historical probability thresholds; no win-rate calibration is claimed. Trainer outcome requirements remain small-sample checks, not an optimizer or proof. Funding and AI costs are reported separately rather than allocated unreliably to individual trades. Slippage is already embedded in fill prices and is not subtracted twice.

## Research implications

The original crypto Donchian research studies daily, much longer horizons with volatility targeting and trade-reduction rules. It does not validate a four-hour adaptation with a six-hour maximum hold. Changing its bar duration and liquidation schedule changes the strategy. This motivates horizon-matched experiments, not borrowing the published performance figures. [Original authors' paper](https://concretumgroup.com/wp-content/uploads/2026/02/Catching-Crypto-Trends.pdf)

Jev's choice primitive distributes probability across the offered labels; it does not supply a forecast that a trade will make money. The score primitive assesses an ordered rubric. Neither `p=1` nor high conviction establishes positive expected return. Repeatedly asking until the model permits an entry is not independent confirmation. [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice), [TypeSafe Score](https://docs.typesafe.ai/primitives/score)

Futures fees apply on both opening and closing, with funding and execution costs additionally affecting results. Historical comparisons therefore include all fill costs and actual funding settlements. A signal that looks good before costs may still be unusable. [OKX X-Perps cost explanation](https://www.okx.com/en-gb/help/okx-x-perps-eea-fees-overview)

Trying many configurations and then presenting the best observed result overstates evidence. The comparison contains fixed parameter examples, reports losing results, and labels the later period as a retrospective evaluation segment after parity corrections—not a pristine unseen test set. Any future promotion needs a new untouched interval. [Bailey and López de Prado, Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)

## What the historical comparison says

Public OKX candles cover 18 July–16 October, with additional four-hour warmup history. The later segment is 16 September–16 October. Uses $250 per cat and the deployed owner limits, next-bar execution, fees, spread/slippage, funding, stop gaps and loss limits. These are deterministic proxies: historical Jev choices, trainer changes, adds/trims and ten-second intrabar behavior are not replayed.

| Portfolio proxy, later segment | Return after trading costs | Maximum drawdown | Return at doubled execution costs |
|---|---:|---:|---:|
| Deployed strategy proxies | −6.58% | 8.16% | −14.56% |
| Updated default momentum + Good four-hour cadence/six-hour hold | −5.15% | 7.44% | −12.54% |
| Experimental breakout/24-hour hold + Good/72-hour hold | −3.53% | 6.65% | −5.47% |

The less negative experimental result is **not a profitable replacement**. Every Dark variant and combined portfolio remained negative. A Good score-two/72-hour component returned +0.49% across only 14 trades, with mixed results in the earlier segment; that is insufficient independent evidence. No candidate was promoted as a proven improvement, and no additional parameter search was used to manufacture a winner. Full components, benchmarks, assumptions, hashes and commands are in the [backtest report](STRATEGY_BACKTEST_2026-10-16.md).

## Environment changes for the next paper build

Keep the existing allocation, database path, leverage, risk budgets and holding limits while evaluating the mechanical changes. These explicit settings select the shipped baseline and the new safeguards:

```dotenv
DRY_RUN=true
MODE=paper
COACH_AUTO_APPLY=false
TIGER_SIGNAL_MODE=momentum
TIGER_MIN_STOP_COST_RATIO=3
TIGER_MAX_ENTRY_CHASE_ATR=0.5
TIGER_MAX_ENTRY_CANDIDATES=1
MOCHI_MIN_STOP_COST_RATIO=3
MOCHI_MAX_ENTRY_CHASE_ATR=0.5
MOCHI_MAX_ENTRY_CANDIDATES=1
```

All new values above are defaults; adding them makes the deployed choice explicit. `COACH_ENABLED=true` can remain for advisory reviews. Version 8 and advisory startup retire old automatic overlays, so Good's owner baseline (for example score four/conviction two in the supplied environment) will replace the trainer's lowered values. Inspect `/profile` and `/coach` after restart. Do not change the database just to adopt the build.

For a **separate paper experiment only**, `TIGER_SIGNAL_MODE=trend_breakout`, `TIGER_BREAKOUT_BARS=20`, `TIGER_EXIT_BARS=10`, `TIGER_TREND_FAST_HOURS=20`, `TIGER_TREND_SLOW_HOURS=50`, `TIGER_MAX_HOLD_MINUTES=1440` and `MOCHI_MAX_HOLD_MINUTES=4320` describe the longer-horizon example. It remained negative as a portfolio; it is not the new default or a recommendation to increase exposure. Use a separate recorded experiment and do not extend held positions accidentally by swapping settings mid-run.

The existing owner setting `TIGER_MAX_ENTRIES_PER_DAY=0` can pause new Dark entries while maintaining deterministic protection of an existing position. The equivalent Mochi setting behaves the same way. Resetting entry allowances does not create an edge and should not be used to defeat a loss/fee limit.

## Evaluation before increasing exposure

Freeze the version, parameters and model identity; keep the trainer advisory. Evaluate prospectively on a new time interval. Compare net portfolio equity including all reported costs, drawdown, closed-trade expectancy, profit factor, turnover and time in market against cash and exposure-matched benchmarks. Require performance across different market conditions and cost stress rather than a few winners or a high model score. Record each attempted configuration, including losers.

Remaining limits include correlated BTC/altcoin exposure across the two independent budgets, rolling-history Donchian state approximation, no exchange liquidation/depth simulation, delayed protection during an outstanding inference request, and lack of calibrated trade-success probabilities. The test suite verifies execution/accounting invariants; it cannot guarantee profitable trading or a maximum drawdown.
