# Catfolio: restored upstream trading behavior

Source baseline: [imikerussell/beebots commit 6d3fe0d4f72dd25676c2f5caac0b83dff05031fb](https://github.com/imikerussell/beebots/tree/6d3fe0d4f72dd25676c2f5caac0b83dff05031fb), the upstream commit immediately before the Catfolio conversion. Strategy version: `catfolio-4-upstream-restored`.

## Active strategies

- DARK Wall-E (`tiger`) runs `src/bees/bizzy.ts`: daily Larry Williams breakout, BTC/ETH/SOL/HYPE, long-only, full strategy size, stop at day open, hold/cut loss, 23:59 UTC exit. One new position per UTC day by default, no forced entry.
- Good Wall-E (`mochi`) runs `src/bees/breezy.ts`: original nine Donchian horizons on 4h bars, BTC/ETH, both directions, volatility sizing with source floor, +1R adds, directional three-point trims, flips, coin switches, channel trailing, flat forcing and target rebalancing. Three new positions/day by default.
- `src/bees/custom.ts` is the original rules/coin wrapper. `src/cats.ts` only binds identities and renders descriptions/diagnostics. It must never replace the source menus or strategy math.

The three brain/wrapper files above match this source baseline. Source risk ordering is restored: stops/loss/retirement first, model failure holds, discretionary opening gates, flat forcing, then position rebalancing. Upstream forced entry and rebalance deliberately do not use the discretionary opening cooldown. Adds do not increment the new-position counter; switches do. These are source behaviors, not extra Catfolio restrictions.

## Explicit retained differences

This is functional restoration of the two source strategies, not a byte-for-byte rollback of the whole application. Cat names, two independent capital allocations, dashboard, provider selection/Vercel Jev integration, 20-hour owner-approved trainer and persistent audit records remain.

Operational guards retained: fresh quotes for execution, per-coin indicator freshness, valid initial stops, completed candle inputs, complete previous-day range validation, lot-size flooring, current-menu revalidation after inference, independent protective loop, transactional fills/stops, stale-response rejection, unknown-order blocking and exchange-rejection backoff. The protective loop cannot open/add independently of a decision. Switches require a fully filled close and a fresh recheck before the new leg; rejected/unknown/partial closes leave the remaining position intact.

Source notional sizing uses leverage x equity x 0.97, capped at MAX_NOTIONAL_USD_PER_BEE. Explicit per-cat notional caps remain optional ceilings; their defaults are now 200%. Accounts retain their configured capital and daily loss limits (source default 8%). No replacement-engine stop-risk sizing, bullish-only gate, minimum trend score, short-term confirmation, fee-distance filter or 2h/6h exit is active. The original conviction labels/gates are passed to the decision provider.

## Upgrade and validation

Review deployment overrides against `.env.example`; previous 50% notional caps, 1x leverage or altered cooldowns remain explicit overrides until edited. Database history and live positions are preserved. Old trainer overlays are retired with their review history retained. Old pending proposals expire; new proposals see source move names and observables.

Regression coverage compares both cat adapters directly to their source brains across directions and scores, checks shared source file hashes, and exercises source risk, short fills, adds, trims/restart, flips/switches, partial/rejected closes, caps, model outages, data freshness and unchanged paper balances. Tests verify implementation behavior; they do not establish profitability.
