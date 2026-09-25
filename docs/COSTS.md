# Cost model (measured and read 2026-09-24)

Stake: **$1,000**, split **$333** per bee. Max notional per bee at 2x: **~$666**.

## 1. Jev

Price: **$0.042 per 1M input tokens, output free** (docs.typesafe.ai/models, and Vercel AI Gateway lists the same). Limits: 1,200 req/min, 250k tok/s.

Cost per day = `3 bees × (86,400,000 / TICK_MS) × tokens_per_call × $0.042 / 1e6`

| tick | tokens/call | decisions/min (all 3) | $/day | $/30 days |
|---|---|---|---|---|
| 1 s | 600 | 180 | $6.53 | $196 |
| 1 s | 800 | 180 | $8.71 | $261 |
| 2 s | 800 | 90 | $4.35 | $131 |
| 3 s | 800 | 60 | $2.90 | $87 |
| 5 s | 800 | 36 | $1.74 | $52 |

**Recommendation:** start at `TICK_MS=2000` with `JEV_DAILY_USD_CAP=5`. Drop to 1 s for filming sessions if the shot needs more motion. Measure real `usage.input_tokens` in phase 4; the table is only as good as the tokens-per-call guess.

## 2. OKX trading fees (X-Perps, EEA)

- **Maker 0.020% / taker 0.050%**, read off the EEA fee endpoint and corroborated by the PRIIPs KID (2026-09-23). Bees use market orders only, so **every fill is taker**.
- Round trip at notional N: `0.001 × N` in fees **plus the spread** (≈ spread_bp × N / 10,000).
- At full 2x (~$666): **~$0.67 fees per round trip** + spread.

Default budgets in `.env`:

| bee | typical size | max trades/day | fee budget/day | worst case/30 days |
|---|---|---|---|---|
| breezy | $10-$666, trend-scaled | ~1 | $0.50 | $15 |
| bizzy | ~$265 | 6 | $1.50 | $45 |
| boozy | $400-$666 | 8 | $3.00 (incl. spread) | $90 |
| **total** | | | **$5.00** | **$150 (15% of stake)** |

Budgets are hard caps in code. Once a bee spends its daily budget it can only hold or close until 00:00 UTC.

## 3. Funding

X-Perps charge continuous funding, settled at 00:00, 08:00 and 16:00 UTC, capped at ±0.75% per interval. On 2026-09-24 DOGE read 0.0100% per interval. It is roughly 4-6%/yr of notional for a long in a normal market, so **~$3-5/month per bee held at full 2x**. It can flip to a credit when funding goes negative, which is nice on screen.

## 4. Infra

| item | cost |
|---|---|
| Hostinger KVM 2 | $8.99/mo intro (24-month term), renews $14.99 |
| OKX account, sub-accounts, API, demo | free |
| Coinbase → OKX (USDC on Base) | cents |
| OKX → Coinbase (USDC on Arbitrum) | 0.0065 USDC (Base 0.042, **never Ethereum mainnet: 1.46**) |

## 5. All-in for the 30-day run (budget ceiling)

Jev ~$90-200, trading fees ≤ $150, funding ~$10-15, VPS ~$9, domain ~$27. **About $290-400 of friction on a $1,000 stake.** That is exactly why the cost counters belong on screen: the bees have to beat the house, and viewers can watch the house take its cut in real time.
