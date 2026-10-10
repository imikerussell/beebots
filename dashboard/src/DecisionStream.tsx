import { useEffect, useState } from "react";
import { CAT_IDS, CAT_META } from "./CatCard";
import { DECISION_LIMIT, decisionKey } from "./decisionFeed";
import type { CatId, Decision } from "./types";

const reasons: Record<string, string> = {
  model_unavailable: "No usable model answer; no model trade allowed",
  weak_or_invalid_conviction: "Signal strength is below the entry requirement",
  stale_model_response: "Answer arrived too late or the position or settings changed",
  stale_market_data: "Market data is too old", stale_indicators: "Indicators are too old",
  missing_market_data: "Market data is unavailable", minTrendScore: "Trend is below the entry threshold",
  breakout_not_confirmed: "Waiting for a confirmed breakout", momentum_not_positive: "Momentum is not positive",
  price_extended: "Price has moved too far beyond the breakout", liquidity_gate: "Trading volume is too low",
  spread_gate: "Bid/ask spread is too wide", funding_gate: "Funding is too expensive or unavailable",
  trade_cap: "Daily entry limit reached", fee_budget: "Daily fee budget reached", loss_stop: "Daily loss limit reached",
  stop: "Protective stop triggered", time_stop: "Position time limit reached", one_position_limit: "Already holding a position",
};
const explain = (reason: string) => reasons[reason] ?? reason.replaceAll("_", " ");
const signed = (value: number) => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;

function actionNote(d: Decision) {
  if (d.forcedBy) return `Protection requested ${d.action?.kind ?? "an action"}: ${explain(d.forcedBy)}.`;
  if (d.vetoedBy) return `Blocked: ${explain(d.vetoedBy)}.`;
  if (d.error) return "No usable model answer. This attempt was recorded; no model trade allowed.";
  if (d.source === "rules") return "Only the wait/hold option was available. Rules handled this decision without a model call.";
  if (d.action && d.action.kind !== "none") {
    const size = d.action.notionalUsd == null ? "" : ` · $${d.action.notionalUsd.toFixed(2)}`;
    return `Allowed by risk checks: ${d.action.kind}${d.action.instId ? ` ${d.action.instId}` : ""}${size}. Execution is checked separately.`;
  }
  if (d.choice === "WAIT") return "Chose to stay in cash and wait for a stronger opportunity.";
  if (d.choice?.includes("HOLD")) return "Chose to keep the current position.";
  return explain(d.status);
}

function DecisionRow({ decision: d, name }: { decision: Decision; name: string }) {
  const options = Object.entries(d.probabilities ?? {}).filter(([, p]) => Number.isFinite(p) && p >= 0 && p <= 1)
    .sort((a, b) => b[1] - a[1]);
  const selected = options.find(([label]) => label === d.choice)?.[1];
  const diagnostics = d.entryDiagnostics?.filter((c) => c.blockers.length);
  return <li className={`stream-row ${d.bee}`}>
    <div className="stream-row-head">
      <img src={CAT_META[d.bee].img} alt="" />
      <strong className="stream-cat">{name}</strong>
      <strong className="stream-choice">{d.choice ?? (d.error ? "Model unavailable" : "Protective check")}</strong>
      <div className="stream-numbers">
        {d.pnlUsd != null && <span className={d.pnlUsd >= 0 ? "positive" : "negative"} title="Cat’s total P&L at the time of this decision, before execution">P&amp;L {signed(d.pnlUsd)}</span>}
        {selected !== undefined && d.source !== "rules" && <span title="Probability assigned to the selected action; not a chance of profit">{Math.round(selected * 100)}% choice</span>}
        {d.latencyMs != null && <span>{d.latencyMs} ms</span>}
        <time dateTime={new Date(d.ts).toISOString()} title={new Date(d.ts).toLocaleString()}>{new Date(d.ts).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"})}</time>
      </div>
    </div>
    {options.length > 0 && d.source !== "rules" && <div className="stream-options" aria-label="Action probabilities">
      {options.map(([label, probability]) => <div className={`stream-option ${label === d.choice ? "selected" : ""}`} key={label}>
        <span className="stream-option-fill" style={{width: `${probability * 100}%`}} aria-hidden="true" />
        <span>{label}</span><b>{Math.round(probability * 100)}%</b>
      </div>)}
    </div>}
    <p className={`stream-note ${d.vetoedBy || d.error ? "negative" : ""}`}>{actionNote(d)}</p>
    {!!diagnostics?.length && <details className="stream-diagnostics"><summary>Entry conditions</summary>
      {diagnostics.map((c) => <p key={c.coin}><b>{c.coin}:</b> {c.blockers.map(explain).join(" · ")}</p>)}
    </details>}
  </li>;
}

export function DecisionStream({ decisions, names, streamStatus, historyStatus, intervalMs, closed }: {
  decisions: Decision[];
  names: Record<CatId, string>;
  streamStatus: "connecting" | "live" | "reconnecting";
  historyStatus: "loading" | "loaded" | "unavailable";
  intervalMs?: number;
  closed: boolean;
}) {
  const [filter, setFilter] = useState<CatId | "all">("all");
  const [paused, setPaused] = useState<Decision[] | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const rows = (paused ?? decisions).filter((d) => filter === "all" || d.bee === filter);
  const rate = decisions.filter((d) => d.ts > now - 60_000 && d.ts <= now).length;
  const last = decisions[0];
  const age = last ? Math.max(0, Math.floor((now - last.ts) / 1000)) : null;
  return <section className="decision-stream" aria-labelledby="decision-stream-title">
    <div className="stream-heading">
      <h2 id="decision-stream-title">Decision stream</h2>
      <span className={`stream-connection ${streamStatus === "live" ? "positive" : "muted"}`} role="status"><i />{streamStatus === "live" ? "Live" : streamStatus === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
      <span className="stream-rate" title="Recorded decisions in the past 60 seconds, across both cats">{rate}/min</span>
      <button onClick={() => setPaused(paused ? null : decisions)} aria-pressed={!!paused}>{paused ? "Resume view" : "Pause view"}</button>
    </div>
    <div className="stream-toolbar">
      <div className="journal-filters" aria-label="Filter decisions">{(["all", ...CAT_IDS] as const).map((id) => <button key={id} className={filter === id ? "active" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>{id === "all" ? "Both cats" : names[id]}</button>)}</div>
      <span>{paused ? "View paused; new decisions are still collected." : closed ? "Trading run closed. Showing recorded decisions." : age === null ? "Waiting for the first recorded decision." : `Last decision ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} ago${intervalMs ? ` · Scheduled every ${Math.round(intervalMs / 1000)}s per cat` : ""}`}</span>
    </div>
    {historyStatus === "unavailable" && <p className="stream-warning" role="status">Recent history could not be loaded. Live decisions will still appear when connected.</p>}
    {rows.length ? <ol className="stream-list" aria-label="Recorded decisions, newest first" tabIndex={0}>{rows.map((d) => <DecisionRow key={decisionKey(d)} decision={d} name={names[d.bee]} />)}</ol>
      : <p className="stream-empty">{historyStatus === "loading" ? "Loading recent decisions…" : `No recorded decisions${filter === "all" ? "" : ` from ${names[filter]}`} yet.`} WAITs, HOLDs, blocked actions and model failures all appear here.</p>}
    <p className="stream-footer">Newest first · Latest {DECISION_LIMIT} recorded decisions · Probabilities describe the model’s choices, not the chance of profit.</p>
  </section>;
}
