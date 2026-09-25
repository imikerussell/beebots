// Owner-designed bees. Setup turns the owner's sentence into rules (plain English, fed to Jev) and an optional coin
// list, and picks which built-in brain the bee runs on. This wrapper keeps the brain's moves, stops and sizing, but
// only ever shows it the allowed coins, and tells Jev the owner's rules. The rules steer Jev's pick among the moves
// the brain offers; they cannot invent new kinds of move.
import type { StyleId } from "../settings.js";
import type { MarketView } from "../market/types.js";
import { BIZZY_BREAKOUT_COINS } from "./bizzy.js";
import { BREEZY_COINS } from "./breezy.js";
import { coinOf, type BeeBrain, type BeeContext, type Intent, type Menu } from "./types.js";

export interface CustomRules {
  /** Tickers the bee may trade ([] = any coin the brain would pick). */
  coins: string[];
  /** The owner's rules, in plain English. */
  rules: string;
}

/**
 * The brain a designed bee runs on. Trend needs BTC/ETH only; Breakout needs its own four coins only; anything else
 * (including "any coin") runs on Momentum, which ranks every coin that passes the gates.
 */
export function deriveStyle(wanted: StyleId, coins: string[]): StyleId {
  const within = (list: readonly string[]) => coins.length > 0 && coins.every((c) => list.includes(c));
  if (wanted === "breezy" && within(BREEZY_COINS)) return "breezy";
  if (wanted === "bizzy" && within(BIZZY_BREAKOUT_COINS)) return "bizzy";
  return "boozy";
}

const namesInst = (i: Intent): string | null => (i.kind === "open" || i.kind === "switch" ? i.instId : null);

export function customBrain(base: BeeBrain, o: CustomRules): BeeBrain {
  const rules = o.rules.trim();
  const coins = [...new Set(o.coins.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!rules && !coins.length) return base;
  const allowed = (instId: string) => !coins.length || coins.includes(coinOf(instId));

  // The brain sees a market with only the allowed coins in it (plus whatever the bee holds, so it can manage it).
  const narrow = (ctx: BeeContext): BeeContext => {
    if (!coins.length) return ctx;
    const held = ctx.bee.position?.instId;
    const keep = (id: string) => allowed(id) || id === held;
    const view: MarketView = {
      ...ctx.view,
      gated: ctx.view.gated.filter(keep),
      spreadBlocked: ctx.view.spreadBlocked.filter(keep),
      stats: new Map([...ctx.view.stats].filter(([id]) => keep(id))),
    };
    return { ...ctx, view };
  };

  const coinLine = coins.length ? ` This bee only ever trades ${coins.join(", ")}.` : "";
  return {
    ...base,
    strategy: `${base.strategy}${rules ? ` Owner's rules for this bee (they come first, within the moves offered): ${rules}` : ""}${coinLine}`,
    universe: (ctx) => base.universe(narrow(ctx)).filter(allowed),
    snapshotCoins: (ctx) => base.snapshotCoins(narrow(ctx)).filter((id) => allowed(id) || id === ctx.bee.position?.instId),
    coinSnapshot: (s, ctx) => base.coinSnapshot(s, narrow(ctx)),
    menu: (ctx) => {
      const m: Menu = {};
      for (const [label, opt] of Object.entries(base.menu(narrow(ctx)))) {
        const id = namesInst(opt.intent);
        if (id === null || allowed(id)) m[label] = opt;
      }
      return m;
    },
    forcedEntry: (ctx) => {
      const f = base.forcedEntry(narrow(ctx));
      return f && allowed(f.instId) ? f : null;
    },
    sizeFrac: (intent, conviction, ctx) => base.sizeFrac(intent, conviction, narrow(ctx)),
    ...(base.idleStatus ? { idleStatus: (ctx: BeeContext) => base.idleStatus!(narrow(ctx)) } : {}),
    ...(base.rebalance ? { rebalance: (ctx: BeeContext) => base.rebalance!(narrow(ctx)) } : {}),
    // stopFor, trail, timeStopMinutes and openGate see the full market: they are about the coin the bee holds.
  };
}
