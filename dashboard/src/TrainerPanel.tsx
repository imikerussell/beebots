import { useEffect, useRef, useState } from "react";
import { entryExplanations } from "./entryDiagnostics";
import type {
  CatId,
  CoachEntry,
  CoachState,
  EntryDiagnostic,
  TrainerReview,
} from "./types";

const portrait = (cat: CatId) =>
  `/cats/wall-e-${cat === "tiger" ? "dark" : "good"}.png`;
const reviewOf = (entry?: CoachEntry): TrainerReview | null =>
  entry?.review && "rules" in entry.review ? entry.review : null;
const price = (value?: number | null) =>
  value == null
    ? "—"
    : `$${value.toLocaleString("en-US", { maximumFractionDigits: 5 })}`;
const statusLabel = (entry: CoachEntry) =>
  ({
    accepted: "Strategy updated",
    advisory: "Suggestion only",
    no_change: "Kept the strategy",
    reviewing: "Review in progress",
    failed: "Review failed",
    expired: "Review expired",
    rolled_back: "Baseline strategy restored",
    declined: "Historical suggestion discarded",
    pending: "Historical suggestion",
  })[entry.status];
const age = (time: number, now: number) => {
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes} min ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} h ago`
        : `${Math.floor(minutes / 1440)} d ago`;
};
function Diagnostics({ diagnostics }: { diagnostics: EntryDiagnostic[] }) {
  return (
    <div className="trainer-markets">
      {diagnostics.map((d) => (
        <div key={d.coin}>
          <strong>{d.coin}</strong>
          <span>
            Price {price(d.mid)} ·{" "}
            {d.minMomentumPct != null
              ? `1h ${d.momentumPct?.toFixed(2) ?? "—"}% · ${d.signalSide ?? "no signal"}`
              : `trend score ${d.trendScore ?? "—"}`}
          </span>
          {d.minMomentumPct != null && (
            <p>
              Minimum move ±{d.minMomentumPct.toFixed(3)}% · MACD{" "}
              {d.macdHistPct?.toFixed(4) ?? "—"}% · ATR{" "}
              {d.atrPct?.toFixed(3) ?? "—"}%
            </p>
          )}
          <p>
            {entryExplanations(d).join(" ") ||
              "Entry checks passed; the model and account limits still decide the action."}
          </p>
        </div>
      ))}
    </div>
  );
}

export function TrainerPanel({
  state,
  names,
  connected,
}: {
  state?: CoachState;
  names: Record<CatId, string>;
  connected: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<number | null>(null);
  const [focusedCat, setFocusedCat] = useState<CatId | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const entries = state?.entries ?? [];
  const latest = entries[0];
  const review = reviewOf(latest);
  const detail = entries.find((e) => e.id === selected);
  const detailedReview = reviewOf(detail);
  const rewrites =
    state?.cats.reduce((sum, cat) => sum + cat.acceptedCount, 0) ?? 0;
  const nextAt = Math.min(
    ...(state?.cats
      .map((cat) => cat.nextReviewAt)
      .filter((at): at is number => at != null) ?? []),
  );
  const checking = state?.cats.some((cat) => cat.phase === "reviewing");
  const gathering = state?.cats.some((cat) => cat.phase === "gathering");
  const queued = state?.cats.some((cat) => cat.phase === "queued");
  const fresh =
    connected &&
    !!state?.checkedAt &&
    now - state.checkedAt < 3 * state.checkIntervalMs;
  const next = !connected
    ? "offline"
    : !state
      ? "connecting"
      : !state.enabled
        ? "paused"
        : !fresh
          ? "status delayed"
          : checking
            ? "reviewing now"
            : queued
              ? "due now"
              : gathering && (!Number.isFinite(nextAt) || nextAt <= now)
                ? "gathering data"
                : !Number.isFinite(nextAt)
                  ? "gathering data"
                  : nextAt <= now
                    ? "due now"
                    : `in ${Math.floor((nextAt - now) / 3600000)} h ${Math.ceil(((nextAt - now) % 3600000) / 60000)} min`;
  const open = (id?: number, cat?: CatId) => {
    setSelected(id ?? null);
    setFocusedCat(cat ?? null);
    dialog.current?.showModal();
  };
  const benched = state?.benched === true || state?.enabled === false;
  return (
    <section className={`trainer-panel${benched ? " trainer-benched" : ""}`} aria-label="Strategy trainer">
      {benched ? (
        <div className="trainer-bench-indicator">
          <span className="trainer-emblem" aria-hidden="true">T</span>
          <div role="status">
            <strong>TRAINER <span>BENCHED{!connected ? " · last reported" : ""}</span></strong>
            <p>{!connected ? "Waiting for a current status." : "No reviews or strategy changes at the moment."}</p>
          </div>
          <button className="trainer-bench-history" onClick={() => open()} aria-label="View trainer history and details">{entries.length ? "History" : "Details"} ↗</button>
        </div>
      ) : <>
      <header className="trainer-panel-heading">
        <span className="trainer-emblem" aria-hidden="true">
          T
        </span>
        <div>
          <h2><button className="trainer-title-button" onClick={() => open(latest?.id)}>THE TRAINER ↗</button></h2>
          <p>
            {state?.automatic
              ? `Every ${(state.reviewIntervalMs ?? 14400000) / 3600000} h`
              : "Automatic"}{" "}
            · {state?.autoApply === true ? "Automatic experiments" : state?.autoApply === false ? "Suggestions only" : "Policy unavailable"} · {rewrites} {rewrites === 1 ? "update" : "updates"}
          </p>
        </div>
        <div className="trainer-next">
          <span>next round</span>
          <strong>{next}</strong>
        </div>
      </header>
      {!connected && (
        <p className="trainer-caution">
          Offline — showing the last received trainer data.
        </p>
      )}
      {state && !state.automatic && (
        <p className="trainer-caution">
          Update the engine to enable automatic reviews.
        </p>
      )}
      {state && !state.enabled && (
        <p className="trainer-caution">{state.message}</p>
      )}
      {state?.enabled && state.autoApply === false && (
        <p className="trainer-caution">Suggestions are recorded for review. Your strategy settings stay unchanged.</p>
      )}
      {latest ? (
        <button
          className={`trainer-feature trainer-feature-${latest.cat}`}
          onClick={() => open(latest.id)}
        >
          <img src={portrait(latest.cat)} alt="" />
          <div>
            {review ? (
              <blockquote>“{review.quip}”</blockquote>
            ) : (
              <>
                <strong>
                  {statusLabel(latest)} · {names[latest.cat]}
                </strong>
                <p>
                  {latest.error ??
                    "The trainer is checking the recorded evidence."}
                </p>
              </>
            )}
            <div className="trainer-feature-meta"><span>{review ? statusLabel(latest) : "View details"}</span><time dateTime={new Date(latest.createdAt).toISOString()}>{age(latest.completedAt ?? latest.createdAt, now)}</time></div>
          </div>
        </button>
      ) : (
        <div className="trainer-empty">
          <strong>Getting to know the cats.</strong>
          <p>
            Gathering 30 signal-bar observations. Good needs about five days at its four-hour cadence.
          </p>
        </div>
      )}
      <div className="trainer-live-label">Strategy watch <span>{connected ? "Live" : "Offline"} · click for details</span></div>
      {state?.cats.map((cat) => {
        const diagnostics = cat.context?.diagnostics ?? [];
        const signals = diagnostics.filter(d => d.signalSide && d.blockers.length === 0);
        const account = cat.context?.account;
        const status = account?.position
          ? `${account.position.coin} ${account.position.side}`
          : !diagnostics.length ? "Awaiting data" : cat.cat === "tiger"
            ? signals.length ? `${signals.filter(d => d.signalSide === "long").length} long · ${signals.filter(d => d.signalSide === "short").length} short` : "No entry signal"
            : "Scanning trends";
        return <button className="trainer-watch" key={cat.cat} onClick={() => open(undefined, cat.cat)}>
          <img src={portrait(cat.cat)} alt="" />
          <strong>{names[cat.cat]}</strong>
          <span className="trainer-watch-status">{status}</span>
          <span aria-hidden="true">↗</span>
        </button>;
      })}
      </>}

      <dialog
        ref={dialog}
        className="trainer-detail-dialog"
        aria-labelledby="trainer-detail-title"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current.close();
        }}
      >
        <header>
          <div>
            <span className="eyebrow">AUTOMATIC STRATEGY TRAINER</span>
            <h2 id="trainer-detail-title">
              {detail
                ? `${names[detail.cat]} · ${statusLabel(detail)}`
                : focusedCat ? `${names[focusedCat]} · strategy data` : "Strategy evidence & current rules"}
            </h2>
          </div>
          <button
            autoFocus
            aria-label="Close trainer details"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </header>
        {benched && <p className="trainer-caution">{connected ? state?.message : "Last reported trainer status: benched. Waiting for the engine to reconnect."}</p>}
        {detail && (
          <section className="trainer-review-detail">
            <p className="muted">
              {new Date(detail.createdAt).toLocaleString()} · {detail.model} ·
              Up to 7 days of evidence at review time
            </p>
            {detailedReview ? (
              <>
                <h3>{detailedReview.idea}</h3>
                <blockquote>“{detailedReview.quip}”</blockquote>
                <p>{detailedReview.reason}</p>
                <p>{detailedReview.note}</p>
                {detail.status === "advisory" && <p className="trainer-caution">Suggestion only. These rules, coins and parameter changes have not been applied.</p>}
                {!!detailedReview.parameterChanges?.length && <ul>{detailedReview.parameterChanges.map(change =>
                  <li key={change.field}>{change.field}: {change.from} → {change.to}</li>)}</ul>}
                <h4>Reviewed rules</h4>
                <p>{detailedReview.rules}</p>
                <p>
                  Coins:{" "}
                  {detailedReview.coins
                    ? detailedReview.coins.split(",").join(" · ")
                    : "All baseline allowed coins"}
                </p>
              </>
            ) : (
              <p>
                {detail.error ??
                  (detail.review && "diagnosis" in detail.review
                    ? detail.review.diagnosis
                    : "Review in progress.")}
              </p>
            )}
            {detail.evidence?.summary && (
              <p>
                {detail.evidence.summary.decisions} observations ·{" "}
                {detail.evidence.summary.waits ?? 0} waits ·{" "}
                {detail.evidence.summary.holds ?? 0} holds ·{" "}
                {detail.evidence.entries?.count ?? "—"} filled entries ·{" "}
                {detail.evidence.summary.modelFailures ?? 0} model errors
              </p>
            )}
            {detail.evidence?.strategyVersions && (
              <p className="muted">
                Evidence uses compatible strategy history only.{" "}
                {detail.evidence.excludedObservations ?? 0} observations from
                retired or unidentified strategies excluded.
              </p>
            )}
            {!detail.evidence?.strategyVersions && (
              <p className="muted">
                Historical review: this evidence may include earlier strategy
                versions.
              </p>
            )}
            {!!detail.evidence?.blockers?.length && (
              <ul>
                {detail.evidence.blockers.map((b) => (
                  <li key={b.reason}>
                    {b.reason.replaceAll("_", " ")}: {b.decisions} observations
                  </li>
                ))}
              </ul>
            )}
            {!!detail.evidence?.current?.diagnostics?.length && (
              <details>
                <summary>Market evidence used for this review</summary>
                <Diagnostics
                  diagnostics={detail.evidence.current.diagnostics}
                />
              </details>
            )}
          </section>
        )}
        <h3>Current strategy data{!connected ? " · offline snapshot" : ""}</h3>
        {state?.cats.filter(cat => !focusedCat || cat.cat === focusedCat).map((cat) => (
          <section className="trainer-current-detail" key={cat.cat}>
            <h3>{names[cat.cat]}</h3>
            {"rules" in cat.current && (
              <>
                <p>{cat.current.rules}</p>
                {cat.current.parameters && <dl className="metrics">{Object.entries(cat.current.parameters).map(([field,value]) =>
                  <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}</dl>}
                <p>
                  <strong>Trading:</strong> {cat.current.coins.join(" · ")}
                </p>
              </>
            )}
            {"coins" in cat.baseline && (
              <p className="muted">
                Allowed universe: {cat.baseline.coins.join(" · ")}
              </p>
            )}
            <p>
              {cat.phase} · {cat.observations} signal-bar observations in the last 7 days ·{" "}
              {cat.observedMinutes} observed minutes
            </p>
            <Diagnostics diagnostics={cat.context?.diagnostics ?? []} />
          </section>
        ))}
        {!!entries.length && (
          <details>
            <summary>Recent review history ({entries.length})</summary>
            <div className="trainer-history">
              {entries.map((entry) => (
                <button key={entry.id} onClick={() => setSelected(entry.id)}>
                  {new Date(entry.createdAt).toLocaleString()} ·{" "}
                  {names[entry.cat]} · {statusLabel(entry)}
                </button>
              ))}
            </div>
          </details>
        )}
      </dialog>
    </section>
  );
}
