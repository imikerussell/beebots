# Fixed historical comparison — 16 October 2026

**No tested combined portfolio demonstrated a positive after-cost return.** Every Dark variant lost money in the later evaluation period. The score-two/72-hour Good component gained a small amount over fourteen trades, but that result is insufficient independent evidence. These are exploratory deterministic proxies, not actual Jev account returns or an optimized portfolio.

## Data and exploratory protocol

All 12 coins have 8,640 completed fifteen-minute bars with no gaps for July 18–October 16, 2026 UTC. BTC/ETH also have 1,080 four-hour bars for April 19–October 16. Each coin has 270 realized funding settlements. Four-hour histories for later-listed HYPE/LINK/AVAX/BCH have prefix gaps; those instruments are not used by the Good four-hour comparison.

The first 150 hours of fifteen-minute data are warmup. Development is **2026-07-24 06:00 UTC to 2026-09-16 00:00 UTC**; later evaluation is **2026-09-16 00:00 UTC to 2026-10-16 00:00 UTC**, with exclusive end bounds. Each segment starts flat with $250 allocated to each bot. Results were inspected during simulator corrections for production ranking/ATR, cadence, liquidity, live owner settings and deterministic loss/exit handling. No parameter optimization or grid search was performed. This is a retrospective chronological comparison, not an untouched holdout or prospective preregistered trial.

Data uses the official public [OKX APIs](https://www.okx.com/docs-v5/en/) at `https://eea.okx.com`: `GET /api/v5/market/history-candles` and `GET /api/v5/public/funding-rate-history`. Live X-Perp FUTURES instrument IDs are discovered through `GET /api/v5/public/instruments`. No authenticated API calls or model calls are made.

Every fill includes **5 bp fee + 2 bp adverse slippage + 1 bp assumed half spread**. Realized historical funding is charged/credited at settlement using the bar-open price as a proxy for mark price. The stress test doubles execution costs, including their effects on risk sizing and cost gates, so trade counts can change. A negative funding cost is a credit. The assumed spread is not a historical order-book reconstruction.

Signals use completed contiguous candles and execute at the next fifteen-minute open. Stops execute at the worse of stop or open on gaps; close-derived trails become effective only for the following bar. Missing next bars cannot create entries. Missing held-position bars schedule closure at the next observed open. Drawdowns are based on marked closes; the simulator cannot reproduce ten-second stop execution or unknown intrabar ordering.

The October 16 deployed profile allows 200% notional per allocation, limited by 2× leverage with 3% margin headroom to 194%, and a $700 absolute ceiling. Risk budgets are 0.5% Dark/0.25% Good, with 16/4 daily entries, 15/30 minute cooldowns, $2/$1 fee budgets and 5%/2% daily loss limits. Marked daily-loss breaches flatten at the observed open or next open after a closing mark and block entries until UTC midnight. Equity at or below 40% of starting allocation retires the bot for the rest of that segment. Rolling 96-bar quote volumes apply $1m/$10m liquidity gates as a proxy for ticker volume. Full definitions are in [the research README](../src/research/README.md).

## Candidate definitions

- `dark_momentum_proxy_2h`: original one-hour move plus matching MACD, strongest move/ATR candidate, two-hour maximum hold. A deterministic opposing-momentum exit stands in for unavailable historical Jev decisions.
- `dark_default_guarded_momentum_2h`: production default momentum with cost/chase guards, completed-bar cadence and deterministic sign-reversal exit.
- `dark_trend_momentum_2h`: adds completed hourly EMA20/EMA50 regime agreement; exits when return and MACD both reverse sign.
- `dark_trend_breakout_2h` and `_24h`: prior twenty-bar high/low break with hourly regime agreement; prior ten-bar channel or opposite regime exit. Shared production signal helper; production move/ATR ranking and 200-bar ATR sizing. The two-hour and 24-hour horizons were specified separately.
- `good_donchian_proxy_6h` and `_72h`: existing four-hour nine-channel ensemble, deployed minimum score two, 25% volatility target, score sizing and channel trail. Qualified opposite score exits. The 72-hour variant changes the holding limit only.
- `good_4h_cadence_6h` and `_72h`: use candidate minimum score four, reject entry prices beyond the active channel stop, evaluate new entries once per completed four-hour bar and exit when trend score reaches zero or reverses, matching the new production decision cadence and deterministic exit; six-hour and 72-hour holding limits.
- New candidates require initial stop distance at least three times estimated round-trip costs and reject an entry more than half an ATR beyond its signal close. Breakout entries must still be outside the channel at the next open. No fit or threshold grid search is performed. The later period has been inspected during parity corrections, so further confirmation requires independent data.

## Development · 1× execution costs

| Strategy proxy | Net return | Close-marked max drawdown | Trades | Profit factor | Fees | Funding cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark_momentum_proxy_2h | -52.28% | 53.34% | 705 | 0.51 | $74.99 | $-0.01 |
| dark_trend_momentum_2h | -34.42% | 35.51% | 539 | 0.60 | $55.37 | $-0.47 |
| dark_trend_breakout_2h | -26.23% | 27.53% | 330 | 0.61 | $36.58 | $-0.33 |
| dark_trend_breakout_24h | -15.72% | 17.80% | 221 | 0.72 | $26.23 | $-0.36 |
| good_donchian_proxy_6h | -3.46% | 3.95% | 195 | 0.60 | $5.45 | $-0.41 |
| good_donchian_72h | 0.49% | 2.14% | 38 | 1.14 | $1.22 | $-0.64 |
| good_4h_cadence_6h | -1.59% | 2.21% | 110 | 0.64 | $2.98 | $-0.13 |
| good_4h_cadence_72h | 0.70% | 1.78% | 22 | 1.24 | $0.64 | $-0.46 |
| dark_default_guarded_momentum_2h | -43.49% | 44.39% | 667 | 0.57 | $63.31 | $-0.13 |

| Equal-allocation portfolio | Net return | Close-marked max drawdown |
| --- | ---: | ---: |
| current_proxies | -27.87% | 28.55% |
| trend_momentum_plus_good6h | -18.94% | 19.47% |
| breakout2h_plus_good6h | -14.84% | 15.44% |
| breakout24h_plus_good72h | -7.62% | 8.55% |
| breakout2h_plus_good4h6h | -13.91% | 14.68% |
| breakout24h_plus_good4h72h | -7.51% | 8.58% |
| default_guarded_plus_good4h6h | -22.54% | 23.16% |

Benchmarks: cash 0.00%; BTC price buy-and-hold 15.70%; BTC with 50% allocation 7.85%; BTC futures with 50% allocation and funding 8.27%; BTC futures at owner maximum 194% exposure 32.10%. BTC benchmarks pay entry/exit costs and have no stop loss.

## Development · 2× execution costs

| Strategy proxy | Net return | Close-marked max drawdown | Trades | Profit factor | Fees | Funding cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark_momentum_proxy_2h | -60.03% | 60.44% | 565 | 0.30 | $87.38 | $-0.07 |
| dark_trend_momentum_2h | -18.88% | 19.38% | 263 | 0.60 | $37.31 | $0.01 |
| dark_trend_breakout_2h | -13.44% | 13.87% | 155 | 0.57 | $22.04 | $-0.02 |
| dark_trend_breakout_24h | -8.64% | 9.88% | 112 | 0.70 | $16.67 | $0.01 |
| good_donchian_proxy_6h | -6.32% | 6.45% | 195 | 0.39 | $9.95 | $-0.37 |
| good_donchian_72h | -0.37% | 2.49% | 38 | 0.90 | $2.24 | $-0.58 |
| good_4h_cadence_6h | -2.85% | 3.15% | 108 | 0.43 | $5.30 | $-0.11 |
| good_4h_cadence_72h | 0.37% | 1.65% | 21 | 1.13 | $1.08 | $-0.41 |
| dark_default_guarded_momentum_2h | -32.12% | 32.30% | 382 | 0.50 | $50.72 | $-0.08 |

| Equal-allocation portfolio | Net return | Close-marked max drawdown |
| --- | ---: | ---: |
| current_proxies | -33.17% | 33.47% |
| trend_momentum_plus_good6h | -12.60% | 12.70% |
| breakout2h_plus_good6h | -9.88% | 10.13% |
| breakout24h_plus_good72h | -4.51% | 5.34% |
| breakout2h_plus_good4h6h | -8.15% | 8.42% |
| breakout24h_plus_good4h72h | -4.13% | 5.44% |
| default_guarded_plus_good4h6h | -17.49% | 17.60% |

Benchmarks: cash 0.00%; BTC price buy-and-hold 15.52%; BTC with 50% allocation 7.76%; BTC futures with 50% allocation and funding 8.18%; BTC futures at owner maximum 194% exposure 31.75%. BTC benchmarks pay entry/exit costs and have no stop loss.

## Later chronological evaluation · 1× execution costs

| Strategy proxy | Net return | Close-marked max drawdown | Trades | Profit factor | Fees | Funding cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark_momentum_proxy_2h | -12.71% | 15.92% | 376 | 0.80 | $43.39 | $0.18 |
| dark_trend_momentum_2h | -18.29% | 21.56% | 317 | 0.70 | $30.75 | $0.06 |
| dark_trend_breakout_2h | -10.23% | 15.26% | 201 | 0.75 | $19.84 | $0.03 |
| dark_trend_breakout_24h | -7.04% | 12.88% | 122 | 0.78 | $12.25 | $-0.09 |
| good_donchian_proxy_6h | -0.46% | 1.56% | 111 | 0.89 | $2.92 | $-0.08 |
| good_donchian_72h | 0.49% | 0.82% | 14 | 1.46 | $0.40 | $-0.06 |
| good_4h_cadence_6h | -0.67% | 1.52% | 66 | 0.77 | $1.68 | $-0.04 |
| good_4h_cadence_72h | -0.01% | 0.78% | 12 | 0.99 | $0.31 | $-0.08 |
| dark_default_guarded_momentum_2h | -9.63% | 13.95% | 378 | 0.85 | $39.73 | $0.20 |

| Equal-allocation portfolio | Net return | Close-marked max drawdown |
| --- | ---: | ---: |
| current_proxies | -6.58% | 8.16% |
| trend_momentum_plus_good6h | -9.38% | 11.54% |
| breakout2h_plus_good6h | -5.34% | 8.45% |
| breakout24h_plus_good72h | -3.28% | 6.58% |
| breakout2h_plus_good4h6h | -5.45% | 8.44% |
| breakout24h_plus_good4h72h | -3.53% | 6.65% |
| default_guarded_plus_good4h6h | -5.15% | 7.44% |

Benchmarks: cash 0.00%; BTC price buy-and-hold 8.47%; BTC with 50% allocation 4.23%; BTC futures with 50% allocation and funding 4.15%; BTC futures at owner maximum 194% exposure 16.09%. BTC benchmarks pay entry/exit costs and have no stop loss.

## Later chronological evaluation · 2× execution costs

| Strategy proxy | Net return | Close-marked max drawdown | Trades | Profit factor | Fees | Funding cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark_momentum_proxy_2h | -27.07% | 27.45% | 341 | 0.56 | $59.56 | $0.08 |
| dark_trend_momentum_2h | -26.30% | 26.50% | 240 | 0.44 | $30.79 | $0.03 |
| dark_trend_breakout_2h | -14.94% | 17.10% | 150 | 0.55 | $20.98 | $0.04 |
| dark_trend_breakout_24h | -10.77% | 15.83% | 98 | 0.61 | $14.28 | $0.01 |
| good_donchian_proxy_6h | -2.05% | 2.75% | 111 | 0.59 | $5.41 | $-0.07 |
| good_donchian_72h | 0.26% | 0.84% | 14 | 1.24 | $0.74 | $-0.06 |
| good_4h_cadence_6h | -1.60% | 2.15% | 66 | 0.53 | $3.14 | $-0.03 |
| good_4h_cadence_72h | -0.17% | 0.78% | 12 | 0.86 | $0.58 | $-0.07 |
| dark_default_guarded_momentum_2h | -23.49% | 23.83% | 290 | 0.55 | $38.21 | $0.02 |

| Equal-allocation portfolio | Net return | Close-marked max drawdown |
| --- | ---: | ---: |
| current_proxies | -14.56% | 14.74% |
| trend_momentum_plus_good6h | -14.18% | 14.32% |
| breakout2h_plus_good6h | -8.50% | 9.75% |
| breakout24h_plus_good72h | -5.26% | 8.11% |
| breakout2h_plus_good4h6h | -8.27% | 9.35% |
| breakout24h_plus_good4h72h | -5.47% | 8.26% |
| default_guarded_plus_good4h6h | -12.54% | 12.82% |

Benchmarks: cash 0.00%; BTC price buy-and-hold 8.30%; BTC with 50% allocation 4.15%; BTC futures with 50% allocation and funding 4.06%; BTC futures at owner maximum 194% exposure 15.76%. BTC benchmarks pay entry/exit costs and have no stop loss.

## Interpretation and limits

Losing less than the baseline is insufficient evidence for promoting a strategy as profitable. The new-cadence Good long-horizon comparison has only 12 later-period trades. The older score-two/72-hour variant has 14 trades and a small positive return, but its development performance turns negative under doubled costs. All Dark variants and combined portfolios remain net negative and underperform cash. Increasing leverage or allocation would amplify the losses in these paths. This result supports controlling churn and testing candidates in paper mode; it does not establish a winning configuration.

The simulator does not replay Jev choice probabilities, conviction vetoes, news, trainer changes, switching, adding or trimming. It cannot reconstruct exact historical bid/ask, market depth, exchange quantity rounding, partial fills, mark-price funding or AI expenses. Synthetic fractional quantities and a current surviving coin universe introduce additional approximation/selection bias. This is a limited 90-day sample containing only one later chronological evaluation, not a forecast. These later-period results have been inspected; any new thresholds inspired by them require a new independent period.

## Reproduce

From the repository root:

```sh
pnpm exec tsx src/research/fetch-history.ts 2026-10-16T00:00:00Z 90
pnpm exec tsx src/research/fetch-funding.ts
pnpm exec tsx src/research/compare.ts
pnpm exec vitest run test/research.test.ts
```

Output is cached under ignored `data/research/`. The manifest reports all missing intervals. `comparison.json` includes turnover, exposure, gross/net P&L, fees, funding, win rate, profit factor, source/data hashes, and these results. `trades-development-1x.json`, `trades-development-2x.json`, `trades-holdout-1x.json` and `trades-holdout-2x.json` contain every synthetic trade and marked equity point.

The dedicated tests verify next-bar execution, last-bar rejection, missing-bar behavior, gap stop pricing, trailing-stop timing, fees/slippage/spread, funding settlement ownership, risk budgets, cost/chase and breakout-retracement gates, daily entry reset, marked-loss flattening/latching, absolute/volatility notional caps, active trend-stop entry rejection, hourly aggregation and explicit missing intervals.

## Source hashes at calculation time

| Source | SHA256 |
| --- | --- |
| `src/market/indicators.ts` | `ce98cc964e0cc752c664668789f16e701f21cc8d50e73312d99626896ff75582` |
| `src/market/strategy-signals.ts` | `39d1cc5aa17a992b21d0fdcff40280049913fa7335d20eceaf7a6a51da1e623b` |
| `src/research/backtest.ts` | `e459f41271b3d9dc5495d2283caf39cb55d0505eabac59e852e2c8d9c77b7b25` |
| `src/research/compare.ts` | `2b1c0c2b158b973c9bdadf8443d1976c6d14e1f09b1e04406fa36f3471cf9d5f` |
| `src/research/fetch-funding.ts` | `5d80ac90adea00e055990c979d6f74e79a30dbafd8068d1343504380f5a0ab62` |
| `src/research/fetch-history.ts` | `01cb7845ca485c7b6f430c5b6fe2c5cc061474dfdc717b36197a858839e86ae7` |

## Public-data file hashes

Hashes identify the exact cached inputs used for this calculation. Regenerating later may produce a different file hash because retrieval metadata changes even when candles do not.

| Cached public-data file | SHA256 |
| --- | --- |
| `ADA-15m.json` | `9e3fb648272e778112bf65cfe86f61006de7031371c1480385f23ace30de361b` |
| `ADA-4H.json` | `7731a95238cdead26a86a0cf85d9f7226b87262c47b9e879c679ee76b8617be9` |
| `ADA-funding.json` | `6c2a0270fa334dbe425b6d2871ecc91e9b1e5a105b95a37262b9f76195445bb6` |
| `AVAX-15m.json` | `7253f0c1387561812ec32fe603d32e11cc0f093fd9c160b3a1bd35975e72ef3a` |
| `AVAX-4H.json` | `1062c4fa1ea3a2d23be5316f28ce5f9d472aafad8f65afc303df2f7a616df373` |
| `AVAX-funding.json` | `4a7c91202806cad6849451580ef98435dc3e04cd2965338f265785eed9f786b0` |
| `BCH-15m.json` | `d1d144220accdf2370df33305299ded2c808c5703a73f338d0efd717f14bd837` |
| `BCH-4H.json` | `866c6be9eccdb2a998ced80c199c57751b5e42c4058381006106fdb5e4914f96` |
| `BCH-funding.json` | `39cd6a050456611585b09d5a1b1903656fa7f294427d51db92fc68fb84dc22a7` |
| `BTC-15m.json` | `7aa195e8ee94153062a760c61c63432f74ab9af363890b53d8df6845f437b665` |
| `BTC-4H.json` | `019d399b31ceb9767cc9cf8267e1e8ceb0eb93f4d8688822895121249adbec8f` |
| `BTC-funding.json` | `affbe2d3417a9ded9f847f9b7a603db57d6b2cfae88b23dd5b112e90d6b8bee4` |
| `DOGE-15m.json` | `c99a4e1c999a0ca52ea081e3f2886a2abaff84c57fc4f060295df4c96e5e73cd` |
| `DOGE-4H.json` | `e494f2efffb774395664d4d07e87b78641485119c2997c2e1a79e5c0637b7410` |
| `DOGE-funding.json` | `6c1800690e34219eb79f983d5f96cac53927e33acbfb71e0c51a72a99780f347` |
| `ETH-15m.json` | `53ddc7310fbe5cfe9c92e67c70ae62cb392b703012c042a24ac37cb05753f4a2` |
| `ETH-4H.json` | `d8cded1f12a2c171b8d6c93823d9d9a11630819fec313df20a186b801675931e` |
| `ETH-funding.json` | `8252459fb327220059c0e7e950ff81357df5ccee07bcd73f4882a5b5149e52bf` |
| `HYPE-15m.json` | `00f84ac9bdac522ceba7d581ca99185a3078594f0fb8f38c460651989ea9b9e6` |
| `HYPE-4H.json` | `a170d454a1c12bde4830bd480d807c6d28946275e953ba27036a37fa3cfc2223` |
| `HYPE-funding.json` | `57280fb752ca325b3405ecd225e47e048733a77593ca3ee1045830c6aa1bc652` |
| `LINK-15m.json` | `48bf412725b2d874de919b88920257cfebbd00b30265710f79211542dd371529` |
| `LINK-4H.json` | `fffb2dc434adf4a1b2a753cd528b3e46c5cec7fa0b2d09c0b59e389e5be5e437` |
| `LINK-funding.json` | `c4c2a544ee3ac603a435364682d04c4560aa7566ad463228ed6cc917b9eca32b` |
| `LTC-15m.json` | `69cb583e0cf8383fad1efccc630ab6e4f9b6384e684876e94a599f7c13da8e30` |
| `LTC-4H.json` | `c2f0a5797bd26debe0f02d37b5a84e52886383d7d66d810ec65b04de45ce8d67` |
| `LTC-funding.json` | `a0dde68df1a8960611fbad7c1107cfbd8056bc548a72493d217906e578390875` |
| `SOL-15m.json` | `6d40ccf71db461769e31bf84f9deec639bfb318f854f9b53dde05def43a1ca5e` |
| `SOL-4H.json` | `5073ac0b435ea3673184617bf2b12446e3a1022411b5b12ce5793a8a16ec0605` |
| `SOL-funding.json` | `3030ac4404387874eb747e78f5eca04cfd4d608458df6cc2c83bcb23efe35624` |
| `SUI-15m.json` | `bc8db9943cc2c90216b6689da25f010659a67e7f1e602cd4e488ddf3a8eff14e` |
| `SUI-4H.json` | `2f4b48c81d265d8ffe6b23a3c190e8cf655de124a7fe5180760b1416157735ba` |
| `SUI-funding.json` | `cccbd5c9e2a06e02a41ad7cacc167fa5db575c4dde2be664b6ed5b79145b8169` |
| `XRP-15m.json` | `35e6c0759c5715328ff74c4a691bf0527500a712ef837234e24e64a283863753` |
| `XRP-4H.json` | `1538042639b77706dd00df6e993708fb89b18e28b82b16331fff2bad8af9dd2c` |
| `XRP-funding.json` | `0394830cda7d69e0b96ff8032ba0c3939fc23dfa897bcb1fdf611692786a15ff` |
