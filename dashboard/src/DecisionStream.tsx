import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CAT_IDS } from "./CatCard";
import { DECISION_LIMIT, decisionKey } from "./decisionFeed";
import { dataBlocked, entryExplanations } from "./entryDiagnostics";
import type { CatId, Decision } from "./types";

const reasons: Record<string, string> = {
  model_unavailable: "No usable model answer; no model trade allowed",
  weak_or_invalid_conviction: "Signal strength is below the entry requirement",
  stale_model_response:
    "Answer arrived too late or the position or settings changed",
  stale_market_data: "Market data is too old",
  stale_indicators: "Indicators are too old",
  missing_market_data: "Market data is unavailable",
  minTrendScore: "Trend is below the entry threshold",
  breakout_not_confirmed: "Waiting for a confirmed breakout",
  momentum_not_positive: "Momentum is not positive",
  price_extended: "Price has moved too far beyond the breakout",
  liquidity_gate: "Trading volume is too low",
  spread_gate: "Bid/ask spread is too wide",
  funding_gate: "Funding is too expensive or unavailable",
  trade_cap: "Daily entry limit reached",
  fee_budget: "Daily fee budget reached",
  loss_stop: "Daily loss limit reached",
  stop: "Protective stop triggered",
  time_stop: "Position time limit reached",
  one_position_limit: "Already holding a position",
};
const explain = (reason: string) =>
  reasons[reason] ?? reason.replaceAll("_", " ");
const signed = (value: number) =>
  `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;

function actionNote(d: Decision) {
  if (d.forcedBy)
    return `Protection requested ${d.action?.kind ?? "an action"}: ${explain(d.forcedBy)}.`;
  if (d.vetoedBy) return `Blocked: ${explain(d.vetoedBy)}.`;
  if (d.error)
    return "No usable model answer. This attempt was recorded; no model trade allowed.";
  if (d.source === "rules")
    return d.entryDiagnostics?.some(dataBlocked)
      ? "Market data is missing or out of date. Affected coins cannot qualify for entry; JEV was not called because no trade option was available."
      : "No coin passed every entry rule below. JEV was not called because there was no eligible trade to evaluate.";
  if (d.action && d.action.kind !== "none") {
    const size =
      d.action.notionalUsd == null
        ? ""
        : ` · $${d.action.notionalUsd.toFixed(2)}`;
    return `Allowed by risk checks: ${d.action.kind}${d.action.instId ? ` ${d.action.instId}` : ""}${size}. Execution is checked separately.`;
  }
  if (d.choice === "WAIT")
    return "Chose to stay in cash and wait for a stronger opportunity.";
  if (d.choice?.includes("HOLD")) return "Chose to keep the current position.";
  return explain(d.status);
}

function DecisionRow({
  decision: d,
  name,
}: {
  decision: Decision;
  name: string;
}) {
  const options = Object.entries(d.probabilities ?? {})
    .filter(([, p]) => Number.isFinite(p) && p >= 0 && p <= 1)
    .sort((a, b) => b[1] - a[1]);
  const selectedOption = options.find(([label]) => label === d.choice);
  const selected = selectedOption?.[1];
  const topOptions = options.slice(0, 3);
  if (selectedOption && !topOptions.some(([label]) => label === d.choice))
    topOptions[2] = selectedOption;
  const showOptions = options.length > 0 && d.source !== "rules";
  const diagnostics = d.entryDiagnostics?.filter((c) => c.blockers.length);
  const summary = d.forcedBy
    ? `Protection · ${explain(d.forcedBy)}`
    : d.vetoedBy
      ? `Blocked · ${explain(d.vetoedBy)}`
      : d.error
        ? "Model unavailable · no model trade"
        : d.source === "rules"
          ? d.entryDiagnostics?.some(dataBlocked) ? "Market data issue · entry checks incomplete" : "No qualifying entry"
          : "Decision details";
  return (
    <li className={`stream-row ${d.bee}`} data-decision-key={decisionKey(d)}>
      <div className="stream-row-head">
        <strong className="stream-cat" title={name}>
          <i aria-hidden="true" />
          {name}
        </strong>
        <strong className="stream-choice" title={d.choice ?? undefined}>
          {d.choice ?? (d.error ? "MODEL ERROR" : "PROTECTION")}
        </strong>
        <div className="stream-numbers">
          {d.pnlUsd != null && (
            <span
              className={d.pnlUsd >= 0 ? "positive" : "negative"}
              title="Cat’s total P&L at this decision, before execution"
            >
              {d.pnlUsd >= 0 ? "▲" : "▼"} {signed(d.pnlUsd)}
            </span>
          )}
          {selected !== undefined && d.source !== "rules" && (
            <span title="Probability assigned to the selected action; not a chance of profit">
              {Math.round(selected * 100)}%
            </span>
          )}
          {d.latencyMs != null && (
            <span className="stream-latency">{d.latencyMs}ms</span>
          )}
        </div>
      </div>
      {showOptions && (
        <div
          className="stream-options"
          aria-label="Recorded action probabilities"
        >
          {topOptions.map(([label, probability]) => (
            <div
              className={`stream-option ${label === d.choice ? "selected" : ""}`}
              key={label}
              title={`${label}: ${(probability * 100).toFixed(1)}%${label === d.choice ? " · selected" : ""}`}
            >
              <span
                className="stream-option-fill"
                style={{ width: `${probability * 100}%` }}
                aria-hidden="true"
              />
              <span className="stream-option-label">{label}</span>
              <b>{Math.round(probability * 100)}%</b>
            </div>
          ))}
          {Array.from({ length: 3 - topOptions.length }, (_, i) => (
            <div
              className="stream-option unavailable"
              key={`empty-${i}`}
              title="No additional recorded action"
              aria-label="No additional recorded action"
            >
              —
            </div>
          ))}
        </div>
      )}
      <details className="stream-details">
        <summary className={d.vetoedBy || d.error ? "negative" : ""}>
          <span className="stream-detail-label">
            {!showOptions && (
              <b>{d.source === "rules" ? "RULES" : "RECORDED"}</b>
            )}
            {summary}
          </span>
          <time
            dateTime={new Date(d.ts).toISOString()}
            title={new Date(d.ts).toLocaleString()}
          >
            {new Date(d.ts).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        </summary>
        <div className="stream-detail-body">
          <p>{actionNote(d)}</p>
          <p>Recorded result: {d.status}</p>
          {d.latencyMs != null && <p>Decision latency: {d.latencyMs} ms</p>}
          {showOptions && (
            <dl className="stream-all-options">
              {options.map(([label, probability]) => (
                <div key={label}>
                  <dt>
                    {label}
                    {label === d.choice ? " · selected" : ""}
                  </dt>
                  <dd>{(probability * 100).toFixed(1)}%</dd>
                </div>
              ))}
            </dl>
          )}
          {!!diagnostics?.length && (
            <div className="stream-diagnostics">
              <strong>What blocked entry at this decision</strong>
              {diagnostics.map((c) => (
                <div className="stream-coin-diagnostics" key={c.coin}>
                  <b>{c.coin}</b>
                  <ul>{entryExplanations(c).map((reason, i) => <li key={i}>{reason}</li>)}</ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

export function DecisionStream({
  decisions,
  liveDecisionKeys,
  names,
  streamStatus,
  historyStatus,
  intervalMs,
  closed,
}: {
  decisions: Decision[];
  liveDecisionKeys: string[];
  names: Record<CatId, string>;
  streamStatus: "connecting" | "live" | "reconnecting";
  historyStatus: "loading" | "loaded" | "unavailable";
  intervalMs?: number;
  closed: boolean;
}) {
  const [filter, setFilter] = useState<CatId | "all">("all");
  const [paused, setPaused] = useState<Decision[] | null>(null);
  const [now, setNow] = useState(Date.now);
  const listRef = useRef<HTMLOListElement>(null);
  const previousLayout = useRef<{
    filter: CatId | "all";
    paused: Decision[] | null;
    positions: Map<string, number>;
  } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const rows = (paused ?? decisions).filter(
    (d) => filter === "all" || d.bee === filter,
  );
  useLayoutEffect(() => {
    const list = listRef.current;
    const previous = previousLayout.current;
    const elements = list ? Array.from(list.children) as HTMLElement[] : [];
    const positions = new Map(elements.map((el) => [el.dataset.decisionKey!, el.offsetTop]));
    previousLayout.current = { filter, paused, positions };
    if (!list || !previous || previous.filter !== filter || previous.paused !== paused || paused) return;
    const arrivals = elements.filter((el) => !previous.positions.has(el.dataset.decisionKey!));
    if (!arrivals.length) return;

    // Keep the same recorded row in view when the reader has scrolled back.
    // Browser anchoring is disabled here so it cannot also apply this adjustment.
    if (list.scrollTop > 12) {
      const anchor = elements.find((el) => {
        const top = previous.positions.get(el.dataset.decisionKey!);
        return top !== undefined && top >= list.scrollTop;
      });
      if (anchor) list.scrollTop += anchor.offsetTop - previous.positions.get(anchor.dataset.decisionKey!)!;
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const el of arrivals) {
      // Backfill and reconnect history are never presented as new live activity.
      if (!liveDecisionKeys.includes(el.dataset.decisionKey!)) continue;
      const style = getComputedStyle(el);
      el.animate([
        { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginBottom: "0px", opacity: 0, overflow: "hidden" },
        { height: `${el.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: style.marginBottom, opacity: 1, overflow: "hidden" },
      ], { duration: 420, easing: "cubic-bezier(.22, 1, .36, 1)" });
      el.animate([
        { backgroundColor: `color-mix(in srgb, ${style.getPropertyValue("--accent")} 24%, #1b1b25)` },
        { backgroundColor: style.backgroundColor },
      ], { duration: 1600, easing: "ease-out" });
    }
  }, [rows, filter, paused, liveDecisionKeys]);
  const rate = decisions.filter(
    (d) => d.ts > now - 60_000 && d.ts <= now,
  ).length;
  const last = decisions[0];
  const age = last ? Math.max(0, Math.floor((now - last.ts) / 1000)) : null;
  return (
    <section
      className="decision-stream"
      aria-labelledby="decision-stream-title"
    >
      <div className="stream-heading">
        <h2 id="decision-stream-title">Decision stream</h2>
        <span
          className={`stream-connection ${streamStatus === "live" ? "positive" : "muted"}`}
          role="status"
        >
          <i />
          {streamStatus === "live"
            ? "Live"
            : streamStatus === "connecting"
              ? "Connecting…"
              : "Reconnecting…"}
        </span>
        <span
          className="stream-rate"
          title="Recorded decisions in the past 60 seconds, across both cats"
        >
          {rate}/min
        </span>
      </div>
      <div className="stream-toolbar">
        <div className="journal-filters" aria-label="Filter decisions">
          {(["all", ...CAT_IDS] as const).map((id) => (
            <button
              key={id}
              className={filter === id ? "active" : ""}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {id === "all" ? "All" : names[id]}
            </button>
          ))}
        </div>
        <button
          className="stream-pause"
          onClick={() => setPaused(paused ? null : decisions)}
          aria-pressed={!!paused}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <p className="stream-timing">
        {paused
          ? "View paused; new decisions are still collected."
          : closed
            ? "Trading run closed. Showing recorded decisions."
            : age === null
              ? "Waiting for the first recorded decision."
              : `Last decision ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} ago${intervalMs ? ` · Every ${Math.round(intervalMs / 1000)}s per persona` : ""}`}
      </p>
      {historyStatus === "unavailable" && (
        <p className="stream-warning" role="status">
          Recent history could not be loaded. Live decisions will still appear
          when connected.
        </p>
      )}
      {rows.length ? (
        <ol
          ref={listRef}
          className="stream-list"
          aria-label="Recorded decisions, newest first"
          tabIndex={0}
        >
          {rows.map((d) => (
            <DecisionRow
              key={decisionKey(d)}
              decision={d}
              name={names[d.bee]}
            />
          ))}
        </ol>
      ) : (
        <p className="stream-empty">
          {historyStatus === "loading"
            ? "Loading recent decisions…"
            : `No recorded decisions${filter === "all" ? "" : ` from ${names[filter]}`} yet.`}{" "}
          WAITs, HOLDs, blocked actions and model failures all appear here.
        </p>
      )}
      <p className="stream-footer">
        Latest {DECISION_LIMIT} · Action probabilities, not profit odds.
      </p>
    </section>
  );
}
