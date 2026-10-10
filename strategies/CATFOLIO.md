# Catfolio intraday strategies

Version: `catfolio-3-intraday`. These replace the earlier daily/four-hour adaptations. The historical Breezy and Bizzy modules remain research references; they are not the scheduled brains.

| Rule | Tiger | Mochi |
|---|---|---|
| Universe | BTC, ETH, SOL | BTC, ETH |
| Trend bars | 15 minutes | 1 hour |
| Entry bars | 5 minutes | 15 minutes |
| Trend threshold | +3 | +4 and no bearish channels |
| Entry setup | Close above preceding 12 five-minute highs; positive 15-minute momentum | Strongest eligible hourly trend; positive 45-minute momentum |
| Initial stop | 2 × five-minute ATR | 2 × hourly ATR |
| Maximum holding time | 120 minutes | 360 minutes |
| Entries / UTC day | 8 | 4 |
| Entry cooldown | 15 minutes | 30 minutes |
| Maximum notional / equity | 50% | 50% |
| Stop risk / equity including estimated fees | 0.5% | 0.25% |
| Daily loss stop | 5% | 2% |

Nine Donchian horizons use 3, 5, 8, 12, 18, 24, 36, 48 and 72 completed trend bars. Tiger covers 45 minutes–18 hours; Mochi covers 3–72 hours. Each channel is long, short or off; the score is long channels minus short channels. Only completed candles enter calculations. Contiguous recent histories are required, and volatility uses 90 returns annualized with the actual number of bars per year.

Tiger's breakout threshold excludes the confirming candle itself. Price must remain above the threshold and within 25% of the preceding hour's range beyond it. Funding must be known and ≤0.03% per settlement. There is no UTC-midnight entry blackout or daily breakout requirement.

Mochi sizes by score / 9, capped at a 25% annualized portfolio-volatility target and the notional/risk limits. A recent 24-hour closing extreme breaks score ties. A three-point decline from entry offers one half-trim, persisted across restarts.

Both require the initial ATR stop distance to cover at least twice the estimated round-trip fees, spread and adverse slippage. This is a movement-size filter, not an expected-return estimate. Both trail the supportive channel midpoint without loosening stops and exit deterministically on a lost trend or maximum holding time. Fresh quotes are required for execution.

Jev evaluates eligible menus every minute; deterministic protection runs every five seconds. Entry caps, cooldowns, fee budgets, loss stops, one-position limits, lot-size rounding, long-only trading and model-response validation remain enforced. WAIT is valid; there are no forced trades, adds or averaging down. More frequent signals are not evidence of better returns. These changes have rule/execution tests, not a profitability backtest.

The existing ledger is preserved. Audits record the strategy version, effective rules and both sets of intraday inputs. Old and new trading results should be separated by strategy version when comparing performance.
