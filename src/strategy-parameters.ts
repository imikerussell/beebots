import type { BeeId, Config } from "./config.js";

/** Trainer-adjustable strategy controls. Capital and risk budgets are deliberately absent. */
export const PARAMETER_BOUNDS = {
  minConviction: { min: 0.25, max: 3, maxStep: 0.25, evidence: "weakConviction" },
  minActionProbability: { min: 0.1, max: 0.95, maxStep: 0.05, evidence: "weakProbability" },
  minMomentumPct: { min: 0.05, max: 1, maxStep: 0.05, evidence: "momentum_not_confirmed" },
  momentumAtrMult: { min: 0.1, max: 2, maxStep: 0.1, evidence: "momentum_not_confirmed" },
  minTrendScore: { min: 1, max: 9, maxStep: 1, evidence: "minTrendScore" },
  volTargetPct: { min: 10, max: 60, maxStep: 5, evidence: "closed_trades" },
  trimScoreDrop: { min: 1, max: 6, maxStep: 1, evidence: "closed_trades" },
} as const;
export type StrategyParameter = keyof typeof PARAMETER_BOUNDS;
export type ParameterValues = Partial<Record<StrategyParameter, number>>;
export function strategyParameters(cfg: Config, cat: BeeId): ParameterValues {
  const { minConviction, minActionProbability } = cfg.cats[cat];
  if (cfg.strategyEngine === "upstream") return cat === "mochi" ? { minActionProbability } : {};
  return cat === "tiger" ? { minConviction, minActionProbability,
    ...(cfg.strategies.tiger.signalMode === "trend_breakout" ? {} : {
      minMomentumPct: cfg.strategies.tiger.minMomentumPct, momentumAtrMult: cfg.strategies.tiger.momentumAtrMult }) }
    : { minConviction, minActionProbability, minTrendScore: cfg.strategies.mochi.minTrendScore,
      volTargetPct: cfg.strategies.mochi.volTargetPct, trimScoreDrop: cfg.strategies.mochi.trimScoreDrop };
}
export function applyParameters(cfg: Config, cat: BeeId, values: ParameterValues) {
  for (const [field, value] of Object.entries(values)) {
    if (!Object.hasOwn(strategyParameters(cfg, cat), field) || !Number.isFinite(value)) throw Error("Unsupported strategy parameter");
    if (field === "minConviction" || field === "minActionProbability") cfg.cats[cat][field] = value!;
    else Object.assign(cfg.strategies[cat], { [field]: value });
  }
}
export function tunableParameters(cfg: Config, cat: BeeId) {
  return Object.entries(strategyParameters(cfg, cat)).map(([field, value]) => ({ field, value, ...PARAMETER_BOUNDS[field as StrategyParameter] }));
}
