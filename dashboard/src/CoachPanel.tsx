import { useState } from "react";
import { CAT_IDS } from "./CatCard";
import type { CatId, CoachField, CoachState } from "./types";
const labels: Record<CoachField, string> = {
  minTrendScore: "Minimum trend score",
  minActionProbability: "Minimum action probability",
  minConviction: "Minimum conviction",
};
const value = (field: CoachField, n: number) => field === "minActionProbability" ? `${Math.round(n * 100)}%` : String(n);
const blockerLabels: Record<string, string> = {
  minTrendScore: "Trend below the entry threshold", stale_indicators: "Market indicators are stale",
  missing_market_data: "Market data is unavailable", coin_not_allowed: "Coin is outside this strategy",
  liquidity_gate: "Trading volume is too low", spread_gate: "Bid/ask spread is too wide",
  market_universe_gate: "Coin did not pass market eligibility checks", incomplete_trend_history: "Not enough confirmed trend history",
  opposing_short_slices: "Some trend channels point down", invalid_volatility_size: "Cannot calculate a valid position size",
  missing_atr_stop: "Cannot calculate the protective stop", trade_cap: "Daily entry limit reached",
  too_close_to_day_exit: "Too close to the daily exit", missing_daily_range: "Daily breakout range is unavailable",
  missing_confirmed_15m_close: "Waiting for a confirmed 15-minute close", breakout_not_confirmed: "Price has not confirmed a breakout",
  price_extended: "Price is too far beyond the breakout", momentum_not_positive: "One-hour momentum is not positive",
  funding_gate: "Funding is too expensive or unavailable",
};
const statusLabel = {
  reviewing: "Reviewing the evidence…", pending: "Your decision", accepted: "Accepted", declined: "Declined",
  no_change: "Keep the current rules", failed: "Review unavailable", expired: "Suggestion expired", rolled_back: "Original settings restored",
};
export function CoachPanel({ state, names, onUpdate }: { state?: CoachState; names: Record<CatId, string>; onUpdate: () => Promise<void> }) {
  const [ownerKey, setOwnerKey] = useState("");
  const [busy, setBusy] = useState<CatId | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function act(cat: CatId, action: "accept" | "decline" | "reset", id?: number) {
    setBusy(cat); setError(""); setNotice("");
    try {
      const r = await fetch(`/coach/${action}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey.trim()}` }, body: JSON.stringify(action === "reset" ? { cat } : { id }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Unable to save your decision.");
      await onUpdate();
      setNotice(action === "accept" ? `${names[cat]} will use the approved threshold on its next decision. No trade was forced.` : action === "decline" ? "Suggestion declined. Settings unchanged." : `${names[cat]}'s original thresholds are restored.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to reach the engine."); }
    finally { setBusy(null); }
  }
  return <section className="coach-panel" aria-label="Daily strategy coach">
    <div className="section-title"><div><span className="eyebrow">A SECOND OPINION</span><h2>Daily strategy coach</h2></div><span className="count-badge">{state?.enabled ? "Daily · per cat" : "Not connected"}</span></div>
    <p className="muted">{state?.message ?? "Connect the engine to see daily strategy reviews."}</p>
    <p className="coach-explainer">The coach explains the waiting, then suggests a small adjustment only when the evidence supports one. You decide what changes. Risk limits and protective exits stay in place.</p>
    {state?.approvalMessage ? <p className="muted">{state.approvalMessage}</p> : state?.canReview && <label className="coach-access">Owner key <input type="password" value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)} placeholder="Enter your coach owner key" autoComplete="off" /><span>Kept only in memory for this page. Never enter your Vercel API key here.</span></label>}
    {error && <p role="alert" className="negative">{error}</p>}
    {notice && <p role="status" className="positive">{notice}</p>}
    <div className="coach-grid">{CAT_IDS.map((cat) => {
      const entries = state?.entries.filter((e) => e.cat === cat) ?? [], latest = entries[0];
      const settings = state?.cats.find((c) => c.cat === cat);
      const change = latest?.review?.change;
      const pending = latest?.status === "pending";
      return <article key={cat} className={`coach-review ${cat}`}>
        <div className="section-title"><h3>{names[cat]}</h3><span className={`coach-status ${pending ? "positive" : "muted"}`}>{latest ? statusLabel[latest.status] : "Gathering evidence"}</span></div>
        {latest ? <>
          <p className="muted">Reviewed {new Date(latest.createdAt).toLocaleString()} · {latest.evidence.summary.decisions} decisions · {latest.evidence.summary.waits ?? 0} waits · {latest.evidence.summary.modelFailures ?? 0} model failures</p>
          {latest.review ? <>
            <p>{latest.review.diagnosis}</p>
            {change && <div className="coach-change"><span>{labels[change.field]}</span><strong>{value(change.field, change.from)} <span aria-hidden="true">→</span> {value(change.field, change.to)}</strong></div>}
            <p>{latest.review.rationale}</p><p className="muted"><b>Tradeoff:</b> {latest.review.tradeoff}</p>
          </> : <p>{latest.status === "failed" ? "The provider could not return a valid, supported review. No settings changed. The coach will try again at the next daily review." : "The coach is checking the recorded decisions and blocked entries."}</p>}
          {latest.evidence.blockers.length > 0 && <details><summary>Why entries were blocked</summary><ul>{latest.evidence.blockers.map((b) => <li key={b.reason}>{blockerLabels[b.reason] ?? b.reason.replaceAll("_", " ")} · {b.decisions} decisions</li>)}</ul><p className="muted">A decision can have multiple blockers.</p></details>}
          {pending && <><p className="muted">Expires {new Date(latest.expiresAt).toLocaleString()}. Accepting changes the next decision; it does not place an order.</p><div className="coach-actions"><button disabled={!state?.canReview || !ownerKey.trim() || !!busy} onClick={() => void act(cat, "accept", latest.id)}>{busy === cat ? "Saving…" : "Accept suggestion"}</button><button className="coach-secondary" disabled={!state?.canReview || !ownerKey.trim() || !!busy} onClick={() => void act(cat, "decline", latest.id)}>Decline</button></div></>}
        </> : <p className="muted">The first review needs at least one hour and 30 recorded decisions. The coach can recommend keeping the rules when waiting is justified.</p>}
        {settings && <details className="coach-current"><summary>Current thresholds{settings.activeReviewId ? " · coach changes active" : " · original settings"}</summary><dl>{(Object.keys(labels) as CoachField[]).map((field) => <div key={field}><dt>{labels[field]}</dt><dd>{value(field, settings.current[field])}</dd></div>)}</dl></details>}
        {settings?.activeReviewId && <button className="coach-reset" disabled={!state?.canReview || !ownerKey.trim() || !!busy} onClick={() => void act(cat, "reset")}>Restore original thresholds</button>}
        {settings?.nextReviewAt && <p className="muted">Next review no earlier than {new Date(settings.nextReviewAt).toLocaleString()}.</p>}
        {entries.length > 1 && <details className="coach-history"><summary>Previous reviews</summary>{entries.slice(1, 6).map((e) => <div key={e.id}><b>{e.day} · {statusLabel[e.status]}</b><p>{e.review?.diagnosis ?? "Review unavailable."}</p>{e.review?.change && <p>{labels[e.review.change.field]}: {value(e.review.change.field, e.review.change.from)} → {value(e.review.change.field, e.review.change.to)}</p>}</div>)}</details>}
      </article>;
    })}</div>
    {state?.enabled && <p className="muted coach-model">Review model: {state.model} · API usage is billed separately through Vercel.</p>}
  </section>;
}
