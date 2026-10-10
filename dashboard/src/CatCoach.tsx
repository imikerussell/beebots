import { CoachActivity, reviewStatus, when } from "./CoachActivity";
import { useState } from "react";
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
export function CatCoach({ cat, name, state, ownerKey, onUpdate, onLock }: {
  cat: CatId;
  name: string;
  state?: CoachState;
  ownerKey: string;
  onUpdate: () => Promise<void>;
  onLock: () => void;
}) {
  const [busy, setBusy] = useState<CatId | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function act(cat: CatId, action: "accept" | "decline" | "reset", id?: number) {
    setBusy(cat); setError(""); setNotice("");
    try {
      const r = await fetch(`/coach/${action}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey.trim()}` }, body: JSON.stringify(action === "reset" ? { cat } : { id }) });
      const data = await r.json();
      if (r.status === 401) { onLock(); return; }
      if (!r.ok) throw new Error(data.error ?? "Unable to save your decision.");
      await onUpdate();
      setNotice(action === "accept" ? `${name} will use the approved rules and coin list on its next decision. No trade was forced.` : action === "decline" ? "Suggestion discarded. Settings unchanged." : `${name}'s original rules and coins are restored.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to reach the engine."); }
    finally { setBusy(null); }
  }
  const entries = state?.entries.filter((e) => e.cat === cat) ?? [], latest = entries[0];
  const settings = state?.cats.find((c) => c.cat === cat);
  const rewritten = latest?.review && "rules" in latest.review ? latest.review : null;
  const legacy = latest?.review && "change" in latest.review ? latest.review : null;
  const change = legacy?.change;
  const pending = latest?.status === "pending";
  const reviewCount = settings?.reviewCount ?? entries.length;
  return <details id={`cat-coaching-${cat}`} className="coach-review" aria-label={`${name} coaching`}>
    <summary className="coach-review-toggle"><span className="eyebrow">Trainer review</span><span className={`coach-status ${pending ? "positive" : "muted"}`}>{pending ? "Decision awaiting approval" : "View activity"}</span></summary>
    {error && <p role="alert" className="negative">{error}</p>}
    {notice && <p role="status" className="positive">{notice}</p>}
    <CoachActivity state={state} cat={cat} />
    {latest ? <>
      <p className="muted">{latest.completedAt ? "Completed" : "Started"} {when(latest.completedAt ?? latest.createdAt)} · {latest.evidence.summary.decisions} decisions · {latest.evidence.summary.waits ?? 0} waits · {latest.evidence.summary.modelFailures ?? 0} model failures</p>
      {latest.review ? <>
        {rewritten ? <><h4>{rewritten.idea}</h4><p>{rewritten.reason}</p>
          <div className="coach-change"><span>Proposed rules</span></div><p>{rewritten.rules}</p>
          <p><b>Proposed coins:</b> {rewritten.coins || "All allowed coins"}</p>
          <p className="muted">{rewritten.note}</p><p><i>{rewritten.quip}</i></p></> : <p>{legacy?.diagnosis}</p>}
        {change && <div className="coach-change"><span>{labels[change.field]}</span><strong>{value(change.field, change.from)} <span aria-hidden="true">→</span> {value(change.field, change.to)}</strong></div>}
        {legacy && <><p>{legacy.rationale}</p><p className="muted"><b>Tradeoff:</b> {legacy.tradeoff}</p></>}
      </> : <p>{latest.status === "failed" ? "No settings changed. The coach will try again at its next 20-hour opportunity." : "The coach is checking the recorded decisions and blocked entries."}</p>}
      {latest.evidence.blockers.length > 0 && <details><summary>Why entries were blocked</summary><ul>{latest.evidence.blockers.map((b) => <li key={b.reason}>{blockerLabels[b.reason] ?? b.reason.replaceAll("_", " ")} · {b.decisions} decisions</li>)}</ul><p className="muted">A decision can have multiple blockers.</p></details>}
      {pending && <><p className="muted">Expires {new Date(latest.expiresAt).toLocaleString()}. Accepting changes the next decision; it does not place an order.</p><div className="coach-actions"><button disabled={!state?.canReview || !ownerKey.trim() || !!busy} onClick={() => void act(cat, "accept", latest.id)}>{busy === cat ? "Saving…" : "Approve suggestion"}</button><button className="coach-secondary" disabled={!state?.canReview || !ownerKey.trim() || !!busy} onClick={() => void act(cat, "decline", latest.id)}>Discard</button></div></>}
    </> : <p className="muted">{state && !state.enabled ? state.message : "The first review needs at least one hour and 30 recorded decisions. The trainer proposes rules and coins; code still controls entry eligibility and risk limits."}</p>}
    {settings && <details className="coach-current"><summary>Current rules and coins{settings.activeReviewId ? " · trainer changes active" : " · original settings"}</summary>
      {"rules" in settings.current ? <><p>{settings.current.rules}</p><p><b>Coins:</b> {settings.current.coins.join(", ")}</p>
        {"rules" in settings.baseline && <p className="muted">Allowed coins: {settings.baseline.coins.join(", ")}</p>}</>
        : <p className="muted">This engine still uses threshold coaching. Deploy the trainer update to enable rules and coin proposals.</p>}
    </details>}
    {settings?.activeReviewId && <button className="coach-reset" disabled={!state?.canReview || !ownerKey.trim() || !!busy} onClick={() => void act(cat, "reset")}>Restore original rules and coins</button>}
    {settings?.nextReviewAt && <p className="muted">Next review no earlier than {new Date(settings.nextReviewAt).toLocaleString()}.</p>}
    <details className="coach-history"><summary>Review history · {reviewCount} {reviewCount === 1 ? "attempt" : "attempts"}</summary>{entries.length === 0 && <p className="muted">No reviews yet. Progress toward the first review is shown above.</p>}{entries.slice(0, 10).map((e) => <div key={e.id}><b>{when(e.createdAt)} · {reviewStatus[e.status]}</b><p>{(e.review && "rules" in e.review ? e.review.reason : e.review?.diagnosis) ?? e.error ?? (e.status === "reviewing" ? "Waiting for the model’s response." : "No assessment was returned.")}</p><p className="muted">{e.model}{e.resolvedAt ? ` · ${["accepted", "declined", "rolled_back"].includes(e.status) ? "Decision recorded" : "Closed"} ${when(e.resolvedAt)}` : ""}</p>{e.review && "change" in e.review && e.review.change && <p>{labels[e.review.change.field]}: {value(e.review.change.field, e.review.change.from)} → {value(e.review.change.field, e.review.change.to)}</p>}</div>)}</details>
  </details>;
}
