# Breezy Bee: the calculated one

> **Live rules since 2026-09-24:** size = max(0.5, |score|/9) x max notional, under a 60% annualised vol cap (was |score|/9 under 25%). So she always holds at least 1x equity. SIZE_UP is offered when she is more than 25% of max below target. 3 trades a day, fee budget $1.00.

> Cool, serene, sunglasses, a chess knight under one arm. Patient, measured, always wins in the end.

**Style:** trend following on the majors. Few trades, rides winners, rarely wrong for long. She is the control group the other two get measured against. The drama is her *stillness*.

**Universe:** `BTC` and `ETH` X-Perps only (the two deepest books: BTC ~$300M/24h at ~0 bp spread, ETH ~$69M at ~1.2 bp, measured 2026-09-24).

## Strategy B1 (primary): ensemble Donchian trend following

**Source:** Zarattini, Pagani & Barbon (2025), *Catching Crypto Trends: A Tactical Approach for Bitcoin and Altcoins*.
- Paper: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907 (SSRN blocked our fetcher; the rules below come from the authors' summary and a third-party write-up)
- Authors' summary: https://concretumgroup.com/catching-crypto-trends-a-tactical-approach-for-bitcoin-and-altcoins/
- Rules write-up: https://github.com/zebadee2kk/DeFi-TraderStack-Agent/issues/137

**Published rules (daily bars):** for each lookback L in {5, 10, 20, 30, 60, 90, 150, 250, 360}, a close above the highest close of the last L bars turns that slice "on". Each slice exits on a trailing stop that ratchets to the higher of the prior stop and the channel midpoint. Slices are equal weight, and the position is sized to target 25% annualised volatility using 90-bar realised vol. Long only. Reported results 2015 to Mar 2025, net of fees: CAGR ~30%, Sharpe ~1.56 on BTC, max drawdown ~19%.

**Our adaptation (inference, not from the paper):**
- **4-hour bars instead of daily**, so a 30-day video has action. Lookbacks become bar counts.
- **A mirrored short side** (close below the lowest close of L bars), because X-Perps can be shorted and she must always be positioned.
- **Ensemble score** = (short slices on) subtracted from (long slices on), from -9 to +9.
- Position size = `|score| / 9 × maxNotional`, capped by the vol target.

## Strategy B2 (tie-breaker): buy the 10-day high

Quantpedia: buying BTC when it equals its 10-day maximum was the best of 10/20/30/40/50-day lookbacks, and was still "alive and effective" through Aug 2024, though weaker than in the 2022 study.
- https://quantpedia.com/trend-following-and-mean-reversion-in-bitcoin/
- https://quantpedia.com/revisiting-trend-following-and-mean-reversion-strategies-in-bitcoin/

Use: when BTC and ETH have equal |score|, prefer the one at its 10-day (60 × 4h bar) extreme.

## Jev menu

```
action: choice
  LONG_BTC, LONG_ETH, SHORT_BTC, SHORT_ETH,
  HOLD_WINNER     keep the current position (valid only if in profit or score unchanged)
  ADD_TO_WINNER   add one slice (only if unrealised P&L > +1R)
  TRIM_HALF       take half off (score fell by 3+)
  SWITCH          close and take the other coin's direction
conviction: score  ["weak","fair","strong","overwhelming"]
```

**State per coin (numbers only):** ensemble score (-9..+9), slices on long/short, distance to trailing stop in ATR, 90-bar realised vol, 24h return, funding rate + 30-day funding z-score. **State per bee:** current coin/direction/size, unrealised P&L in R, bars held, trades this week, fees today.

## Risk and forcing (code)

- Open or flip only if `P(action) ≥ 0.70` **and** conviction ≥ "strong". Otherwise the code converts the choice to `HOLD_WINNER`, or to the forced minimum below.
- **Never flat:** if flat, open the minimum size (~$10 notional) in the sign of the stronger |score|. She is always "in", even when tiny.
- Stop: 2 × ATR(14) on 4h bars, trailing with the channel midpoint.
- Max notional 2 × equity. Cooldown of 4h after any close.
- Expect **1-4 real entries a week**. Decision calls still run every tick; most return HOLD_WINNER, and that is the point.

## Honest expectation

This is the best-documented edge of the three. It suffers in chop (whipsaw), and the short side is not in the paper. Holding a long costs funding (X-Perps settle at 00/08/16 UTC; about 4-6%/yr of notional was estimated earlier, so ~8-12%/yr of equity at 2x).

## Drama hooks

- "Breezy has sat in the same BTC long for three days while boozy traded forty times."
- "Her stop just ratcheted up: she's playing with house money now."
- "Eight of nine channels say up. She adds."
- "The only bee in the green after the dump."
- The contrast shot: her decision stream is a wall of `HOLD_WINNER` at 0.9 confidence while the other two flicker.
