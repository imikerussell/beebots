import type { StyleId } from "../settings.js";
import { activeBizzy as bizzy } from "./active-bizzy.js";
import { boozy } from "./boozy.js";
import { activeBreezy as breezy } from "./active-breezy.js";
import type { BeeBrain } from "./types.js";
import { bizzy as argonBizzy } from "./argon-bizzy.js";
import { breezy as argonBreezy } from "./argon-breezy.js";
import { boozy as argonBoozy } from "./argon-boozy.js";
import type { Config } from "../config.js";

/** One brain per trading style. */
export const BRAINS: Record<StyleId, BeeBrain> = { bizzy, breezy, boozy };
export const ARGON_BRAINS: Record<StyleId, BeeBrain> = { bizzy: argonBizzy, breezy: argonBreezy, boozy: argonBoozy };
export const brainsFor = (cfg: Config) => cfg.strategyEngine === "upstream" ? ARGON_BRAINS : BRAINS;
