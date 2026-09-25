# Drama rules: shared by all three bees

The video fails if a bee sits in cash. Correct trading is dead television. These rules are enforced in **code**, in the risk layer. They are not left to Jev.

## 1. Jev always has to choose

- Every decision tick, every bee gets a `choice` question with **no plain "do nothing" option while flat**. `HOLD`/`RIDE`/`HOLD_WINNER` exist only while a position is open.
- Only offer options that are valid right now (a real setup, a real candidate). Jev picks among real moves, never impossible ones.
- The full probability distribution is shown on the dashboard, so "62% ape PENGU, 31% ride BTC" becomes a visible argument.

## 2. Never flat for long

| bee | max time flat | what the code forces |
|---|---|---|
| breezy | 0 (always positioned) | minimum size (~$10) in the direction of the stronger trend score |
| bizzy | 20 min | a fade entry on the most stretched coin (%B extreme) |
| boozy | 1 tick | `APE_*` on the top momentum candidate |

The forcing rules are **suspended** when that bee's trade cap, fee budget or daily loss stop has tripped. When suspended (trade cap or fee budget), the bee **rides** its position: Jev is not asked, and only code (stop, time stop, daily loss stop) can close it before the 00:00 UTC reset. The dashboard says so ("benched", "sent home").

## 3. Motion without churn

- **Decisions are cheap, orders are expensive.** Jev runs every tick (`TICK_MS`) for every bee, so the decision stream never stops moving. Orders are rare events with a card and a sound.
- **Held positions move every tick** (unrealised P&L on mark price). Three bees holding three different things separate visibly within hours.
- **Funding lands three times a day** (00:00 / 08:00 / 16:00 UTC) as small visible steps in each bee's equity.

## 4. Designed-in story beats

- **Divergence:** breezy trades 2 majors on a slow clock, bizzy trades 8 liquid coins on a fast clock, boozy picks from ~29 gated coins including the weird ones. They will almost never hold the same thing.
- **Caps as plot:** "trade 6 of 6", "fee budget gone", "sent home on the loss stop". Every cap trip becomes a dashboard banner and an alert.
- **The spread gate as a character:** boozy wanting a coin he can't have.
- **Cost counters:** fees, funding and Jev spend to the cent. "Here is exactly what the thinking cost."
- **Reconciliation light:** our numbers vs OKX's, audited live.
- **Daily recap** (auto-generated at 00:00 UTC into the DB): each bee's best trade, worst trade, weirdest coin, longest hold and P&L. This is narration material for the check-in shots.

## 5. Things that are NOT allowed, even for drama

- Raising leverage above 2x.
- Resting limit orders (self-trade prevention would cancel them silently across bees).
- Any key with withdraw or transfer permission.
- Letting a bee trade stocks or commodities before their trading hours are verified (`ALLOW_NON_CRYPTO=false`).
