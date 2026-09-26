# Bizzy Bee: the grinder

> **Live rules since 2026-09-24:** one Larry Williams volatility breakout a day. When BTC, ETH, SOL or HYPE trades above today's UTC open + 0.5 x yesterday's range, Jev may take it long at full size (2x). She rides it to the UTC day close. Her stop is back below today's open, and she can cut it while it's losing. 1 trade a day, fee budget $1.00. She is never forced in. The fade strategy below is her previous design, kept for reference.

> Tiny round glasses, gaming headset, sweatband, coffee cup, speed lines. Never stops, does everything fast.

**Style:** indicator mean reversion with a funding filter. Many small trades, takes profit early, and cuts losers fast. The drama is her *hustle*, and the fee meter she has to outrun.

**Universe:** the top ~8 liquid crypto X-Perps by 24h volume with spread ≤ 5 bp. On 2026-09-24 that was BTC, ETH, XRP, SOL, SUI, HYPE, DOGE and LINK (re-rank every hour). Mean reversion with market orders only works where the spread is tiny.

## Strategy Z1 (primary): Bollinger + RSI fade

**Source:** Freqtrade community strategy `BbandRsi`:
https://raw.githubusercontent.com/freqtrade/freqtrade-strategies/main/user_data/strategies/berlinguyinca/BbandRsi.py
(repo: https://github.com/freqtrade/freqtrade-strategies, published "for educational purposes only"; no out-of-sample record).

**Published rules (1h, long only):** RSI(14) < 30 **and** close < lower Bollinger band (20, 2σ on typical price) → buy. Exit on RSI > 70 or +10% take-profit, with a -25% stop.

**Our adaptation (inference):**
- **15-minute bars** for activity.
- **Mirrored short:** RSI > 70 **and** close > upper band.
- **Exit at the middle band.** That is her "takes profit early" personality.
- **Stop at 1.5 × ATR(14).** The published -25% stop is meaningless at 2x.
- Time stop: close any trade older than 4 hours.

## Strategy Z2 (filter): funding rate as a veto, not a trigger

- tradingstrategies.work BTC funding backtest (Sep 2019 to Jun 2026, 2,462 days). Buying on negative funding (z < -1.5) was "essentially unviable" after fees. But **blocking longs when funding z > 1.5** lifted average return from +4.23% to +6.95% and win rate to 62.3%. https://tradingstrategies.work/blog/funding-rate-signal-btc-backtest
- BIS Working Paper 1087: "a high crypto carry predicts future price crashes." https://www.bis.org/publ/work1087.htm
- Inan: funding is partly predictable out of sample, but unstably (SSRN abstract only). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5576424

**Rule:** block longs when the coin's 30-day funding z > 1.5. Prefer the short side of an upper-band signal when z > 2. Never buy on negative funding alone.

## Jev menu

```
action: choice
  FADE_LONG_<coin>    x top 8   (lower band + RSI<30 setups)
  FADE_SHORT_<coin>   x top 8   (upper band + RSI>70 setups)
  TAKE_PROFIT        close at/near the middle band
  CUT_LOSS           close now
  ROTATE             close and take the best other setup
  HOLD               (valid ONLY while a position is open; see forcing)
conviction: score ["meh","decent","juicy","screaming"]
```

Only show Jev menu options that currently have a valid setup, plus the position-management options. Jev picks among real choices, never impossible ones.

**State per coin:** RSI(14), %B, band width, ATR%, 1h return, funding + funding z, 1h OI change, spread bp. **State per bee:** position, P&L in R, minutes held, trades today, fees today, fee budget left.

## Risk and forcing (code)

- **Trade cap: 6 round trips a day** (`BIZZY_MAX_TRADES_PER_DAY`) **and a fee budget of $1.50/day** (`BIZZY_FEE_BUDGET_USD_DAY`); whichever trips first benches her until 00:00 UTC. At full 2x size each taker round trip costs ~$0.67 plus spread (see `docs/COSTS.md`); uncapped she bleeds out on fees alone. The dashboard shows the cap meter; hitting it is itself a story beat.
- **Size per trade:** 0.4 × max notional by default (≈$265 on a $333 bee). Small and frequent is her style, and it keeps the fee maths survivable.
- **Never flat for more than 20 minutes:** force a fade entry on the coin with the most extreme %B among the universe, even if the signal is only "meh".
- Funding veto as above. Spread gate 5 bp.
- Expect **4-6 round trips a day**, all capped.

## Honest expectation

Mean reversion in BTC has **weakened since 2022**. Quantpedia: "buying at the minimum has not performed well" Feb 2022 to Aug 2024. Wen et al. find intraday momentum *and* reversal in BTC/ETH/LTC/XRP (ScienceDirect abstract: https://www.sciencedirect.com/science/article/abs/pii/S1062940822000833). Her main enemies are the "band walk" (fading a real breakout) and fees. She may well have the highest win rate and still finish third. That is a great twist.

## Drama hooks

- "Bizzy just banked +0.4% for the seventh time today."
- "Funding's flashing red: she refuses to go long."
- "She faded the breakout and is two ATR underwater. Cut or pray?"
- "Trade 6 of 6. She's benched until midnight."
- Her fee meter vs her P&L: "is she working for herself or for OKX?"
