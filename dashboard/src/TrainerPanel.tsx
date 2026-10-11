import { useEffect, useRef, useState } from "react";
import { entryExplanations } from "./entryDiagnostics";
import type { CatId, CoachEntry, CoachState, EntryDiagnostic, TrainerReview } from "./types";

const portrait = (cat: CatId) => `/cats/wall-e-${cat === "tiger" ? "dark" : "good"}.png`;
const reviewOf = (entry?: CoachEntry): TrainerReview | null => entry?.review && "rules" in entry.review ? entry.review : null;
const price = (value?: number | null) => value == null ? "—" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 5 })}`;
const statusLabel = (entry: CoachEntry) => ({ accepted: "Rules updated", no_change: "Kept the strategy", reviewing: "Review in progress", failed: "Review failed", expired: "Review expired", rolled_back: "Original rules restored", declined: "Historical suggestion discarded", pending: "Historical suggestion" })[entry.status];
const age = (time: number, now: number) => {
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
};
function Diagnostics({ diagnostics }: { diagnostics: EntryDiagnostic[] }) {
  return <div className="trainer-markets">{diagnostics.map(d => <div key={d.coin}>
    <strong>{d.coin}</strong><span>Price {price(d.mid)} · {d.minMomentumPct != null ? `1h ${d.momentumPct?.toFixed(2) ?? "—"}% · ${d.signalSide ?? "no signal"}` : `trend score ${d.trendScore ?? "—"}`}</span>
    {d.minMomentumPct != null && <p>Minimum move ±{d.minMomentumPct.toFixed(3)}% · MACD {d.macdHistPct?.toFixed(4) ?? "—"}% · ATR {d.atrPct?.toFixed(3) ?? "—"}%</p>}
    <p>{entryExplanations(d).join(" ") || "Entry checks passed; the model and account limits still decide the action."}</p>
  </div>)}</div>;
}

export function TrainerPanel({ state, names, connected }: { state?: CoachState; names: Record<CatId, string>; connected: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  const entries = state?.entries ?? [];
  const latest = entries[0];
  const review = reviewOf(latest);
  const detail = entries.find(e => e.id === selected);
  const detailedReview = reviewOf(detail);
  const rewrites = state?.cats.reduce((sum, cat) => sum + cat.acceptedCount, 0) ?? 0;
  const nextAt = Math.min(...(state?.cats.map(cat => cat.nextReviewAt).filter((at): at is number => at != null) ?? []));
  const checking = state?.cats.some(cat => cat.phase === "reviewing");
  const gathering = state?.cats.some(cat => cat.phase === "gathering");
  const queued = state?.cats.some(cat => cat.phase === "queued");
  const fresh = connected && !!state?.checkedAt && now - state.checkedAt < 3 * state.checkIntervalMs;
  const next = !connected ? "offline" : !state ? "connecting" : !state.enabled ? "paused" : !fresh ? "status delayed" : checking ? "reviewing now" : queued ? "due now" : gathering && (!Number.isFinite(nextAt) || nextAt <= now) ? "gathering data" : !Number.isFinite(nextAt) ? "gathering data" : nextAt <= now ? "due now" : `in ${Math.floor((nextAt - now) / 3600000)} h ${Math.ceil((nextAt - now) % 3600000 / 60000)} min`;
  const open = (id?: number) => { setSelected(id ?? null); dialog.current?.showModal(); };
  return <section className="trainer-panel" aria-label="Automatic strategy trainer">
    <header className="trainer-panel-heading">
      <span className="trainer-emblem" aria-hidden="true">T</span>
      <div><h2>THE TRAINER</h2><p>{state?.automatic ? `Every ${(state.reviewIntervalMs ?? 14400000) / 3600000} h` : "Automatic reviews"} · {rewrites} {rewrites === 1 ? "rewrite" : "rewrites"}</p></div>
      <div className="trainer-next"><span>next round</span><strong>{next}</strong></div>
    </header>
    {!connected && <p className="trainer-caution">Offline — showing the last received trainer data.</p>}
    {state && !state.automatic && <p className="trainer-caution">Update the engine to enable automatic reviews.</p>}
    {state && !state.enabled && <p className="trainer-caution">{state.message}</p>}
    {latest ? <button className={`trainer-feature trainer-feature-${latest.cat}`} onClick={() => open(latest.id)}>
      <img src={portrait(latest.cat)} alt="" />
      <div>{review ? <><blockquote>“{review.quip}”</blockquote><strong>{statusLabel(latest)} · {names[latest.cat]}</strong><p>{review.reason}</p></> : <><strong>{statusLabel(latest)} · {names[latest.cat]}</strong><p>{latest.error ?? "The trainer is checking the recorded evidence."}</p></>}
        <time dateTime={new Date(latest.createdAt).toISOString()}>{age(latest.completedAt ?? latest.createdAt, now)}</time>
      </div>
    </button> : <div className="trainer-empty"><strong>Getting to know the cats.</strong><p>The first review needs an hour and 30 observations. Waiting for a signal counts, too.</p></div>}
    {latest?.evidence?.summary && <dl className="trainer-evidence-strip" aria-label="Evidence at latest review">
      <div><dt>24 h observations</dt><dd>{latest.evidence.summary.decisions}</dd></div>
      <div><dt>Waits</dt><dd>{latest.evidence.summary.waits ?? 0}</dd></div>
      <div><dt>Entries</dt><dd>{latest.evidence.entries?.count ?? "—"}</dd></div>
      <div><dt>Model errors</dt><dd>{latest.evidence.summary.modelFailures ?? 0}</dd></div>
    </dl>}
    {latest?.evidence?.summary?.waitOnly != null && <p className="trainer-auto-note">{latest.evidence.summary.waitOnly} waits had no entry option at the latest review.</p>}
    <div className="trainer-live-label">Strategy watch <span>Current engine data</span></div>
    {state?.cats.map(cat => {
      const diagnostics = cat.context?.diagnostics ?? [];
      const signals = diagnostics.filter(d => d.signalSide && d.blockers.length === 0);
      const longs = signals.filter(d => d.signalSide === "long").length;
      const shorts = signals.filter(d => d.signalSide === "short").length;
      const strongest = [...signals].sort((a,b) => Math.abs(b.momentumPct ?? 0) / (b.atrPct || 1) - Math.abs(a.momentumPct ?? 0) / (a.atrPct || 1))[0];
      const account = cat.context?.account;
      return <button className="trainer-watch" key={cat.cat} onClick={() => open()}>
        <img src={portrait(cat.cat)} alt=""/><div><strong>{names[cat.cat]}</strong>
          <p>{account?.position ? `Managing ${account.position.coin} ${account.position.side}` : cat.cat === "tiger" ? signals.length ? `${longs} long / ${shorts} short opportunities` : "Waiting for confirmed long or short momentum" : "Watching BTC / ETH long and short trends"}</p>
          <span>{"coins" in cat.current ? `${cat.current.coins.length} coins` : "—"}{account ? ` · ${account.tradesToday}/${account.maxTradesPerDay} entries today · P&L ${price(account.pnlUsd)}` : ""}</span>
          {cat.phase === "gathering" && <span>{cat.observations}/{cat.requiredObservations} observations · {cat.observedMinutes}/{cat.requiredMinutes} min</span>}
          {strongest && cat.cat === "tiger" && <span>Strongest: {strongest.coin} {strongest.signalSide} · 1h {strongest.momentumPct?.toFixed(2)}% · threshold ±{strongest.minMomentumPct?.toFixed(2)}%</span>}
          {!signals.length && cat.cat === "tiger" && <span>{[...new Set(diagnostics.flatMap(d => d.blockers))].map(b => b.replaceAll("_", " ")).join(" · ")}</span>}
        </div><span aria-hidden="true">↗</span>
      </button>;
    })}
    {entries.length > 1 && <div className="trainer-recent">{entries.slice(1, 4).map(entry => <button key={entry.id} onClick={() => open(entry.id)}>
      <img src={portrait(entry.cat)} alt=""/><span>{reviewOf(entry)?.quip ?? `${names[entry.cat]} · ${statusLabel(entry)}`}<small>{statusLabel(entry)}</small></span><time>{age(entry.createdAt, now)}</time>
    </button>)}</div>}
    <button className="trainer-read-more" onClick={() => open(latest?.id)}>Read what the trainer did →</button>
    <p className="trainer-auto-note">{state?.automatic ? "Changes apply automatically." : "Automatic review status unavailable."} Code controls entries and risk limits.</p>
    <dialog ref={dialog} className="trainer-detail-dialog" aria-labelledby="trainer-detail-title" onClick={event => { if (event.target === dialog.current) dialog.current.close(); }}>
      <header><div><span className="eyebrow">AUTOMATIC STRATEGY TRAINER</span><h2 id="trainer-detail-title">{detail ? `${names[detail.cat]} · ${statusLabel(detail)}` : "Strategy evidence & current rules"}</h2></div><button autoFocus aria-label="Close trainer details" onClick={() => dialog.current?.close()}>×</button></header>
      {detail && <section className="trainer-review-detail">
        <p className="muted">{new Date(detail.createdAt).toLocaleString()} · {detail.model} · Last 24 hours at review time</p>
        {detailedReview ? <><h3>{detailedReview.idea}</h3><blockquote>“{detailedReview.quip}”</blockquote><p>{detailedReview.reason}</p><p>{detailedReview.note}</p>
          <h4>Reviewed rules</h4><p>{detailedReview.rules}</p><p>Coins: {detailedReview.coins ? detailedReview.coins.split(",").join(" · ") : "All baseline allowed coins"}</p></> : <p>{detail.error ?? (detail.review && "diagnosis" in detail.review ? detail.review.diagnosis : "Review in progress.")}</p>}
        {detail.evidence?.summary && <p>{detail.evidence.summary.decisions} observations · {detail.evidence.summary.waits ?? 0} waits · {detail.evidence.summary.holds ?? 0} holds · {detail.evidence.entries?.count ?? "—"} filled entries · {detail.evidence.summary.modelFailures ?? 0} model errors</p>}
        {detail.evidence?.strategyVersions && <p className="muted">Evidence uses compatible strategy history only. {detail.evidence.excludedObservations ?? 0} observations from retired or unidentified strategies excluded.</p>}
        {!detail.evidence?.strategyVersions && <p className="muted">Historical review: this evidence may include earlier strategy versions.</p>}
        {!!detail.evidence?.blockers?.length && <ul>{detail.evidence.blockers.map(b => <li key={b.reason}>{b.reason.replaceAll("_", " ")}: {b.decisions} observations</li>)}</ul>}
        {!!detail.evidence?.current?.diagnostics?.length && <details><summary>Market evidence used for this review</summary><Diagnostics diagnostics={detail.evidence.current.diagnostics}/></details>}
      </section>}
      <h3>Current strategy data{!connected ? " · offline snapshot" : ""}</h3>
      {state?.cats.map(cat => <section className="trainer-current-detail" key={cat.cat}><h3>{names[cat.cat]}</h3>
        {"rules" in cat.current && <><p>{cat.current.rules}</p><p><strong>Trading:</strong> {cat.current.coins.join(" · ")}</p></>}
        {"coins" in cat.baseline && <p className="muted">Allowed universe: {cat.baseline.coins.join(" · ")}</p>}
        <p>{cat.phase} · {cat.observations} observations in the last 24 h · {cat.observedMinutes} observed minutes</p>
        {cat.cat === "tiger" && <p>Long and short entries use one-hour momentum with matching 15-minute MACD. The minimum move is max(0.1%, 0.25 × ATR%). The model may enter, wait, close or reverse. Defaults: 12 entries per day, a five-minute opening cooldown, ATR stops and a two-hour maximum hold.</p>}
        <Diagnostics diagnostics={cat.context?.diagnostics ?? []}/>
      </section>)}
      {!!entries.length && <details><summary>Recent review history ({entries.length})</summary><div className="trainer-history">{entries.map(entry => <button key={entry.id} onClick={() => setSelected(entry.id)}>{new Date(entry.createdAt).toLocaleString()} · {names[entry.cat]} · {statusLabel(entry)}</button>)}</div></details>}
    </dialog>
  </section>;
}
