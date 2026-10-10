import { catBrain } from "../src/cats.js";
import { loadConfig, type BeeId } from "../src/config.js";
import { freshBee } from "../src/ledger.js";
import { applyRisk, type Proposal } from "../src/risk.js";
import { coin, NOW, trend, view } from "./fixtures.js";
export function riskFixture(id: BeeId = "tiger") {
  const cfg = loadConfig({}),
    s = coin("BTC", {
      breakout: { dayOpen: 99, prevRange: 2, trigger: 100, dayStart: Math.floor(NOW / 86400000) * 86400000 },
      confirmed15m: { close: 100, ts: NOW - 900000 },
      ret1hPct: 1,
      macdHistPct: 0.2,
      trend: trend({ score: 9, longOn: 9, shortOn: 0 }),
    });
  const v = view([s]),
    b = freshBee(id, cfg.cats[id].startEquityUsd, NOW),
    brain = catBrain(id, cfg);
  const ctx = {
    bee: b,
    view: v,
    cfg,
    knobs: cfg.cats[id],
    now: NOW,
    uplR: null as number | null,
  };
  const proposal = {
    label: id === "tiger" ? "BREAKOUT_BTC" : "LONG_BTC",
    intent: brain.menu(ctx)[id === "tiger" ? "BREAKOUT_BTC" : "LONG_BTC"]!.intent,
    prob: 0.9,
    conviction: 3,
  };
  const run = (p: Proposal | null = proposal, available = true) =>
    applyRisk({
      ctx,
      brain,
      proposal: p,
      modelStatus: available ? (p ? "ok" : "no_options") : "unreachable",
      sizeMult: 1,
      dataAgeMs: 0,
      maxDataAgeMs: 180000,
    });
  return { cfg, s, v, b, brain, ctx, proposal, run };
}
