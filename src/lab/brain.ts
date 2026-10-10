// What a Beekeeper rewrite (an overlay, lab/store.ts) means for a bee. While one is live, its rules REPLACE the
// owner's rules for Jev, and its coin list narrows the bee further. It is applied through the same wrapper as the
// owner's own rules and coins (bees/custom.ts), so it can only ever reach the strategy text and the coin list:
// never leverage, stops, sizing, caps, the loss stop, retirement, the live ramp or the mode.
import { BIZZY_BREAKOUT_COINS } from "../bees/bizzy.js";
import { BREEZY_COINS } from "../bees/breezy.js";
import type { StyleId } from "../settings.js";

/** What each style may trade at all. null = any crypto X-Perp that passes the gates (Momentum). */
export const STYLE_COINS: Record<StyleId, readonly string[] | null> = {
  bizzy: BIZZY_BREAKOUT_COINS,
  breezy: BREEZY_COINS,
  boozy: null,
};

/** The part of a bee the Beekeeper works with: its style and what the owner gave it on Setup. */
export interface OwnerRules {
  style: StyleId;
  rules: string;
  coins: string[];
}

const tidy = (coins: string[]) => [...new Set(coins.map((c) => c.trim().toUpperCase()).filter(Boolean))];

/**
 * The overlay's coins this bee can really trade: inside what its style can trade, and inside the owner's own coin
 * list when the owner set one. An empty result means "keep the owner's coins".
 */
export function effectiveCoins(style: StyleId, ownerCoins: string[], coins: string[]): string[] {
  const styleList = STYLE_COINS[style];
  const owner = tidy(ownerCoins);
  return tidy(coins).filter((c) => (!styleList || styleList.includes(c)) && (!owner.length || owner.includes(c)));
}

/** The rules and coins a bee trades on right now: the owner's, or the Beekeeper's while an overlay is live. */
export function liveRules(slot: OwnerRules, o: { rules: string; coins: string[] } | null): { rules: string; coins: string[] } {
  if (!o) return { rules: slot.rules, coins: slot.coins };
  const coins = effectiveCoins(slot.style, slot.coins, o.coins);
  return { rules: o.rules, coins: coins.length ? coins : slot.coins };
}
