# Historical research

These tools download public market data and run fixed deterministic comparisons. They do not place orders, call a model, modify the running bots, or optimize parameters. The baseline is a **deterministic proxy**, not a reconstruction of historical Jev actions or the deployed P&L.

Run from the repository root:

```sh
pnpm exec tsx src/research/fetch-history.ts 2026-10-16T00:00:00Z 90
pnpm exec tsx src/research/fetch-funding.ts
pnpm exec tsx src/research/compare.ts
pnpm exec vitest run test/research.test.ts
```

`data/research/` is already ignored by Git. Downloads are cached by explicit requested date bounds. `manifest.json` records requested and obtained coverage and every missing interval; `comparison.json` records source/data SHA256 hashes, assumptions, metrics, and results. `trades-development-1x.json` and the other window/cost files contain every synthetic trade and close-marked equity point. Raw files contain no credentials.

Data comes from the official public [OKX market and funding APIs](https://www.okx.com/docs-v5/en/): `/api/v5/market/history-candles` and `/api/v5/public/funding-rate-history`, using `https://eea.okx.com` and discovered live X-Perp FUTURES instruments. The downloader paginates, retries failed requests, keeps confirmed candles only, and never fills missing candles synthetically.

## Exploratory chronological comparison

- Fifteen-minute candles: 2026-07-18 00:00 UTC to 2026-10-16 00:00 UTC, end exclusive, for the existing 12-coin universe. Four-hour candles request 90 additional warmup days. BTC/ETH have the full warmup. Some later-listed altcoins have shorter four-hour histories; the Good comparison uses only BTC/ETH.
- All comparisons use the same 150-hour hourly-EMA warmup. Development: July 24 06:00 to September 16 00:00. Later evaluation: September 16 00:00 to October 16 00:00. Each segment starts flat with $250 per bot. The later period was inspected during simulator parity corrections and is not an untouched holdout. These are exploratory retrospective comparisons, not an independent prospective evaluation.
- Dark baseline: one-hour momentum magnitude at least `max(0.1%, 0.25 × ATR15m%)`, matching MACD histogram direction, selecting the greatest move/ATR ratio. Exit on opposing momentum, ATR stop or two-hour time limit. The model's probabilities, vetoes and discretionary actions are absent.
- Dark default guarded momentum: the same momentum entry, production cost/chase checks, completed-bar cadence and sign-reversal exit.
- Dark aligned momentum: same momentum signal, hourly EMA20/EMA50 regime agreement, exit when one-hour return and MACD histogram both reverse sign. Dark breakout: completed fifteen-minute close crosses the prior twenty bars' high/low with the same hourly regime. Both use the production `trendBreakoutSignal` helper. Breakout exits on a ten-bar opposite Donchian break or opposite hourly regime, ranks candidates by absolute one-hour return divided by the same 200-bar ATR used in production, and rejects opening prices that retrace inside the breakout channel. Breakout is evaluated at the existing two-hour limit and a separately specified 24-hour alternative.
- Good baseline: the existing nine-channel four-hour Donchian ensemble on the latest 400 completed bars, deployed minimum absolute score two, score/25% volatility sizing, two-ATR stop and channel trail. Exit on a qualified opposite score or six-hour time limit. A separately specified 72-hour alternative changes only the maximum hold. Two additional production-cadence comparisons use candidate minimum score four, reject prices beyond the active channel stop, and evaluate entries only on a new completed four-hour bar and exit when the score loses its direction (zero or opposite), at six-hour and 72-hour holding limits. Model switches, adds and trims are not replayed.
- Each bot holds at most one position. Runtime owner settings allow 200% notional, limited by 2× leverage with 3% headroom to 194%, and a $700 absolute ceiling; risk budgets are 0.5% Dark and 0.25% Good. Daily entry limits are sixteen/four, fee budgets $2/$1, daily loss limits 5%/2%, and cooldowns fifteen/thirty minutes. Trailing 24-hour quote candle volumes apply the $1m Dark/$10m Good liquidity gates as a proxy for the exchange ticker volume measure. The owner settings and baseline score two were read from the deployed profile on October 16. Candidate score four is an explicit alternative; unavailable historical Jev/trainer state is not reconstructed. A marked daily loss flattens at the observed open or next open after a closing-mark breach, latching new entries off until midnight UTC. Equity at or below 40% of starting allocation retires the bot for the remaining segment.
- Signals use only completed, contiguous bars. Orders execute at the next observed fifteen-minute open. Stops are evaluated before a close-derived trailing update, with adverse gap execution at the worse of open and stop. A missing held-position candle schedules closure at the next observed open. No entry occurs across a missing next bar.
- Every fill pays five basis points of taker fee, two basis points of adverse slippage, and one basis point of assumed half spread. Historical realized funding is charged/credited to positions carried across settlement, using bar-open price as a mark-price proxy. The doubled-cost test doubles execution costs, including their effects on risk sizing and candidate cost feasibility; it is not a fixed-trade repricing.
- Candidate entries require a stop distance at least three times estimated round-trip costs and reject adverse opening gaps beyond half an ATR. No fitting or parameter grid search is performed on either segment.
- Cash and BTC buy-and-hold are benchmarks. The BTC tables show full exposure, 50% allocation, a 50% allocation futures version including funding, and a 194% futures exposure reference matching owner headroom. Buy-and-hold has no stop. Reported drawdowns use marked closes, not unknown intrabar peaks.

## Limits on interpretation

A losing comparison is a failed candidate, even if it loses less than the baseline. No candidate here has demonstrated a reliable positive edge. Increasing leverage or capital would amplify the observed losses. The score-two/72-hour Good component has a small positive later-period return, based on only fourteen trades, while its development period loses money at doubled costs. No parameter search was performed, but the evaluation period has been inspected; a new independent paper period is required for confirmation.

Fifteen-minute simulation cannot reproduce the deployed ten-second loop, intrabar market order, discretionary Jev entries/exits, trainer changes, exact bid/ask history, mark-price funding, exchange contract minimums, depth, partial fills or AI expenses. The current coin universe also introduces selection/survivorship bias. These omissions prevent treating the output as a forecast or the actual deployed account's historical return. See [the fixed comparison report](../../docs/STRATEGY_BACKTEST_2026-10-16.md) for the observed comparison.
