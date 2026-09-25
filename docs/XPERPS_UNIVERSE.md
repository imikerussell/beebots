# What the bees can trade: OKX EEA X-Perps (measured 2026-09-24 ~08:10 UTC)

Source: `GET https://eea.okx.com/api/v5/public/instruments?instType=FUTURES` + `/market/tickers?instType=FUTURES`, no key. Full list with numbers: `xperps_eea_2026-09-24.json`. **This moves daily. The engine must rebuild it at startup and re-rank hourly.**

- 215 X-Perp instruments: **208 live**, 7 preopen (AR, ASTS, CORE, IONQ, MET, SKDD, SMCI).
- By kind: **141 crypto, 62 stocks/ETFs, 4 commodities (XAU gold, XAG silver, CL WTI oil, BZ Brent), 1 test instrument (`TEST002`, always exclude)**. The stock/commodity tagging is our own list, not an OKX field.
- Margin/settle: USD-denominated, USDC collateral. `ctVal` varies wildly per coin (0.0001 BTC, 1,000,000 PEPE), so always size in contracts via `ctVal × price`.
- Every id has its own expiry suffix (310404, 310530, 310926...). Never hard-code one.
- Instrument `lever` says 10-50x; EEA retail is capped at 10x by OKX and at **2x by us**.

## Liquidity gates
| gate | count |
|---|---|
| crypto, 24h vol ≥ $10M | 9 |
| crypto, 24h vol ≥ $1M | 40 |
| crypto, 24h vol ≥ $1M **and** spread ≤ 15 bp (boozy's default universe) | 29 |
| crypto, 24h vol ≥ $1M and spread ≤ 5 bp (bizzy's pool) | 16 |
| crypto, 24h vol < $10k (dead, never trade) | 20 |

Spread is a single top-of-book snapshot, so treat it as indicative. The engine must read it live before every order.

## Top 40 by 24h volume (all kinds)

| instId | kind | 24h vol | min order | spread |
|---|---|---|---|---|
| `BTC-USD_UM_XPERP-310404` | crypto | $300.25M | $8.45 | 0.01 bp |
| `ETH-USD_UM_XPERP-310404` | crypto | $68.88M | $2.69 | 1.19 bp |
| `XRP-USD_UM_XPERP-310404` | crypto | $62.60M | $1.50 | 1.33 bp |
| `ZEC-USD_UM_XPERP-310530` | crypto | $35.70M | $15.26 | 0.2 bp |
| `NEAR-USD_UM_XPERP-310613` | crypto | $32.47M | $4.36 | 16.06 bp |
| `SOL-USD_UM_XPERP-310404` | crypto | $24.56M | $1.15 | 2.6 bp |
| `SUI-USD_UM_XPERP-310404` | crypto | $20.77M | $0.97 | 5.16 bp |
| `BCH-USD_UM_XPERP-310530` | crypto | $12.23M | $3.41 | 8.79 bp |
| `HYPE-USD_UM_XPERP-310523` | crypto | $12.18M | $9.38 | 0.11 bp |
| `TAO-USD_UM_XPERP-310523` | crypto | $9.23M | $2.93 | 10.24 bp |
| `AVAX-USD_UM_XPERP-310530` | crypto | $9.19M | $10.26 | 5.84 bp |
| `DOGE-USD_UM_XPERP-310404` | crypto | $7.93M | $0.95 | 4.23 bp |
| `LINK-USD_UM_XPERP-310523` | crypto | $7.87M | $12.47 | 3.21 bp |
| `XAU-USD_UM_XPERP-310502` | commodity | $5.94M | $4.28 | 0.23 bp |
| `PUMP-USD_UM_XPERP-310404` | crypto | $5.50M | $4.03 | 4.97 bp |
| `PENGU-USD_UM_XPERP-310711` | crypto | $5.26M | $1.00 | 5.99 bp |
| `ONDO-USD_UM_XPERP-310620` | crypto | $5.02M | $4.39 | 2.28 bp |
| `ENA-USD_UM_XPERP-310613` | crypto | $4.68M | $20.79 | 8.66 bp |
| `INJ-USD_UM_XPERP-310711` | crypto | $4.46M | $0.79 | 19.07 bp |
| `LTC-USD_UM_XPERP-310404` | crypto | $4.37M | $6.89 | 7.26 bp |
| `CL-USD_UM_XPERP-310509` | commodity | $4.32M | $9.28 | 1.08 bp |
| `PEPE-USD_UM_XPERP-310404` | crypto | $4.20M | $4.41 | 4.53 bp |
| `UNI-USD_UM_XPERP-310718` | crypto | $2.97M | $9.25 | 23.77 bp |
| `SOXL-USD_UM_XPERP-310627` | stock | $2.76M | $1.42 | 1.41 bp |
| `WLD-USD_UM_XPERP-310613` | crypto | $2.73M | $4.15 | 2.41 bp |
| `ARB-USD_UM_XPERP-310815` | crypto | $2.72M | $0.22 | 12.43 bp |
| `HBAR-USD_UM_XPERP-310815` | crypto | $2.64M | $0.91 | 3.28 bp |
| `XAG-USD_UM_XPERP-310509` | commodity | $2.21M | $0.64 | 1.56 bp |
| `ADA-USD_UM_XPERP-310404` | crypto | $2.10M | $2.42 | 4.13 bp |
| `SNDK-USD_UM_XPERP-310627` | stock | $1.75M | $1.78 | 6.73 bp |
| `LIT-USD_UM_XPERP-310704` | crypto | $1.75M | $5.48 | 9.13 bp |
| `MSTR-USD_UM_XPERP-310704` | stock | $1.61M | $1.62 | 12.98 bp |
| `ALLO-USD_UM_XPERP-310718` | crypto | $1.60M | $2.89 | 27.78 bp |
| `TRUMP-USD_UM_XPERP-310704` | crypto | $1.39M | $0.20 | 9.94 bp |
| `ZAMA-USD_UM_XPERP-310725` | crypto | $1.36M | $0.94 | 4.27 bp |
| `BZ-USD_UM_XPERP-310509` | commodity | $1.36M | $0.99 | 1.01 bp |
| `AAVE-USD_UM_XPERP-310704` | crypto | $1.26M | $1.40 | 3.57 bp |
| `FIL-USD_UM_XPERP-310718` | crypto | $1.26M | $0.10 | 6.06 bp |
| `SPCX-USD_UM_XPERP-310613` | stock | $1.18M | $1.48 | 2.02 bp |
| `USELESS-USD_UM_XPERP-310912` | crypto | $1.18M | $2.99 | 31.77 bp |

## Non-crypto (excluded by default: `ALLOW_NON_CRYPTO=false`)

Stocks, ETFs and pre-IPO names (NVDA, TSLA, MSTR, **OPENAI, ANTHROPIC**, SPY, QQQ, SOXL...) and commodities (XAU, XAG, CL, BZ). **Their trading hours on OKX are UNVERIFIED.** A bee holding a stock contract into a closed session could face a gap. Verify before enabling. Enabling them later is a strong story beat ("boozy just bought OpenAI").
