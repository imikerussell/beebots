import type { StyleId } from "../settings.js";
import { bizzy } from "./bizzy.js";
import { boozy } from "./boozy.js";
import { breezy } from "./breezy.js";
import type { BeeBrain } from "./types.js";

/** One brain per trading style. */
export const BRAINS: Record<StyleId, BeeBrain> = { bizzy, breezy, boozy };
