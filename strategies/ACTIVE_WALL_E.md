# Dark Wall-E: active intraday long/short momentum

This replaces the one-shot daily Bizzy breakout as of strategy version `catfolio-6-active-momentum`. Good Wall-E's four-hour Donchian strategy is unchanged.

## Entry opportunities

Scan BTC, ETH, SOL, HYPE, XRP, DOGE, ADA, LINK, AVAX, SUI, LTC and BCH. A trainer overlay may narrow this list. Require current indicators, an eligible exchange market, at least the configured volume ($1M/day by default), spread within 5 bps, and a valid positive ATR stop distance.

Use one-hour return and MACD calculated from completed 15-minute candles. The minimum move is max(0.1%, 0.25 × ATR%). Offer LONG when the return meets the positive threshold and MACD is nonnegative; offer SHORT when it meets the negative threshold and MACD is nonpositive. Rank candidates by absolute return / ATR, and present every qualifying allowed coin. Daily breakout levels are not required.

The model sees momentum, MACD, threshold, ATR, RSI, 24-hour return, funding z-score, one-hour open-interest change, volume z-score and spread. It selects an offered trade or WAIT. At least conviction level 1 (decent) is required. There is no additional action-probability cutoff and no forced entry. The ordinary model budget and failure controls remain active.

## Position management and limits

- One position at a time, with the existing notional/leverage cap and margin headroom.
- Default 12 new positions per UTC day and five minutes between discretionary openings, including reversals.
- Default $3 daily fee budget and unchanged 8% daily loss stop.
- Initial long stop below entry and short stop above entry, at `TIGER_STOP_ATR_MULT` × 15-minute ATR (default 1.5).
- After +1R, trail by the same ATR distance; the engine only ratchets a stop in the position's favor.
- The model may HOLD or CLOSE at a profit or loss. FLIP_LONG/FLIP_SHORT is offered when the held coin develops a qualified opposite signal. The engine must complete the close before opening the reversal, and the reversal counts as a new entry.
- Code closes at `TIGER_MAX_HOLD_MINUTES` (default 120), including when the model is unavailable or the cat has hit its entry/fee cap. Stops and daily loss exits remain deterministic. A capped cat uses the source engine's protective management path until UTC rollover.

The engine still runs serialized ten-second ticks. A pending inference request can delay the next protective check. Existing environment values override defaults, and market conditions, fees, model choice or protective limits can keep actual trading below the maximum.

## Upgrade

Preserve the ledger and existing positions. Retire Dark's old coach overlay, migrate the shipped daily-breakout rules, and let the trainer review the new strategy's actual observables and moves. Good's compatible coach overlay is preserved. Historical daily-breakout records remain readable. Existing position stops are not reset; active trailing and time-exit rules apply after restart.
