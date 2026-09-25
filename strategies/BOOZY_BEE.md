# boozy-bee: the degen

> **Live rules since 2026-09-24:**
> - Ranks on 7-day momentum (plus small 24h and attention terms), and commits to each pick for 24h: BAIL, SWITCH_COIN and FLIP_SHORT unlock after that.
> - Enters at 1x. DOUBLE_DOWN adds 0.5x each time price runs another 1 ATR(1h, approximated as 2 x the 15m ATR) past the entry, up to 2x.
> - Stop and trail at 3 x ATR(1h). 3 entries a day; adds are not counted.

> Crooked party hat, manic grin, bent antenna, cocktail with a tiny umbrella, confetti. All-in, big swings, chaos.

**Style:** short-horizon momentum on whatever is moving. He chases the top gainer and news or attention spikes, and he takes the strange coins. The drama is *"what has he bought now?"*

**Universe:** every live **crypto** X-Perp that passes the gates each tick: 24h volume ≥ $1M **and** spread ≤ 15 bp. That was **29 names on 2026-09-24**, from BTC down to PENGU, PUMP, PEPE, TRUMP, ZAMA and LIT (USELESS, RAY and NEAR were shut out by the spread gate that day). Loosening the gate to 25 bp brings in more strange coins at a real cost per trade; that is a knob, `BOOZY_SPREAD_GATE_BPS`. Stocks and commodities (NVDA, OPENAI, ANTHROPIC, XAU, CL...) stay excluded until their trading hours are confirmed (`ALLOW_NON_CRYPTO=false`). When that flips it becomes a huge story beat: "boozy just bought OpenAI."

## Strategy Y1 (primary): top-gainer rotation (short-horizon cross-sectional momentum)

- Liu, Tsyvinski & Wu, *Common Risk Factors in Cryptocurrency*, Journal of Finance 2022 (NBER PDF, read in full): long-short weekly momentum earns 2.7-4.1% excess *weekly* returns at 1-3 week horizons, and **small coins outperform**, which supports the strange-coin angle. https://www.nber.org/system/files/working_papers/w25882/w25882.pdf
- Dobrynskaya: momentum lasts 2-4 weeks, then reverses after about a month (SSRN abstract). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3913263
- Counter-evidence, Han, Kang & Ryu: cross-sectional momentum is "weak" net of costs and concentrated in large winners (SSRN abstract). https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4675565

**Rule (our adaptation):** every hour, rank the gated universe by a blend of 24h and 7d return. Go long the #1 name at max allowed size. When a different coin takes #1 and holds it for two consecutive ranks, rotate. Stop at 2 × ATR(14) on 15m bars.

## Strategy Y2 (overlay): attention spike + OI breakout

- arXiv 2401.00603: significant returns "within the initial three minutes following tweet publication", but "sentiments were found to have no discernible impact". **Attention matters; the direction of sentiment doesn't.** https://arxiv.org/abs/2401.00603
- arXiv 2504.15790, pump-and-dumps (1,021 tokens): 70% of pre-event volume trades within one hour of the announcement, and insiders take median returns above 100%. **Late chasers are the counterparty.** Boozy is designed to be early or out. https://arxiv.org/abs/2504.15790

**Rule:** enter when a coin's **news-count z-score** spikes (kit `news` module, by coin) **and** its 1h return is in the universe's top decile **and** 1h OI change > 0. Exit on a 15-60 min time stop, a 1.5 × ATR trail, or when **OI starts falling while price still rises** (the crowd leaving). If the `news` module is unavailable on EEA, use a **volume z-score** (1h volume vs 7-day hourly mean) as the attention signal instead.

## Jev menu

```
action: choice
  APE_<coin>     x top 5 candidates (ranked by momentum + attention)
  RIDE           keep current position
  DOUBLE_DOWN    add to a winner (only if P&L > +1R, still within 2x)
  FLIP_SHORT     reverse current coin (only if 1h return turned negative with OI falling)
  BAIL           close now
  SWITCH_COIN    close and ape the best new candidate in the same tick
conviction: score ["tipsy","buzzed","wasted","legendary"]
```

**State per candidate:** 1h/24h/7d return, momentum rank, news-count z (or volume z), sentiment delta (displayed only; research says it has no edge), 1h OI change, funding, spread bp, 24h volume, minutes since the spike began. **State per bee:** position, P&L in R, minutes held, switches today, fees today.

## Risk and forcing (code)

- **Always holding something.** `BAIL` must be followed by an `APE_*` on the next tick. He is never flat for more than one tick.
- Size: max notional (2 × equity) on `APE_*` when conviction ≥ "wasted", otherwise 0.6×.
- **Spread gate 15 bp (hard).** On 2026-09-24 the top gainer RAY sat at 58.6 bp with $0 resting within 20 bp; one round trip would have cost ~0.7% before the price moved. The gate is what keeps him alive.
- One open coin at a time. Switch cap: 8 a day (`BOOZY_MAX_TRADES_PER_DAY`) and a fee budget of $3.00/day (`BOOZY_FEE_BUDGET_USD_DAY`, spread cost counts). When either trips he can only RIDE or BAIL until 00:00 UTC, and the always-holding rule is suspended.
- Daily loss stop per `.env`. When it trips he is "sent home" until 00:00 UTC.

## Honest expectation

He is the entertainment bee with **negative expected value on thin coins**. He is the late buyer when a pump fades, and the most likely to hit stops. If he wins, it's a huge story; if he loses, it's the story everyone expected. Either works.

## Drama hooks

- "Boozy wanted RAY, up 17% today, and the spread gate said no. He's furious." (Real case from 2026-09-24: RAY's spread was 58.6 bp.)
- "Boozy just dumped ETH for PENGU."
- "News spike on ZEC. He was in within one tick."
- "OI is rolling over. Will he bail before the dump?"
- "Breezy went with BTC. Boozy has taken a coin nobody has heard of. I hope he knows what he's doing."
- "Sent home early: daily loss stop."
