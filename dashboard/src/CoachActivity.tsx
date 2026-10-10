import type { CatId, CoachEntry, CoachState } from "./types";

export const reviewStatus: Record<CoachEntry["status"], string> = {
  reviewing: "Review in progress", pending: "Awaiting your decision", accepted: "Approved", declined: "Discarded",
  no_change: "No change recommended", failed: "Review failed", expired: "Suggestion expired", rolled_back: "Original settings restored",
};
const phaseLabels = {
  paused: "Coaching paused", reviewing: "Model is reviewing", awaiting_approval: "Suggestion ready",
  scheduled: "Next review scheduled", queued: "Ready for review", gathering: "Gathering observations",
};
export const when = (time: number) => new Date(time).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

export function CoachActivity({ state, cat }: { state?: CoachState; cat: CatId }) {
  const activity = state?.cats.find((c) => c.cat === cat);
  if (!state || !activity?.phase) return <p className="muted">Waiting for coach status from the engine. If this persists, update and restart the engine.</p>;
  const latest = state.entries.find((e) => e.cat === cat);
  const phase = activity.phase;
  return <div className="coach-activity">
    <div className="coach-phase"><i className={phase === "reviewing" ? "working" : ""} /><strong>{phaseLabels[phase]}</strong></div>
    {phase === "paused" ? <p>{state.message}</p> : phase === "reviewing" ? <p role="status">The evidence has been sent to {latest?.model ?? state.model}. Waiting for its assessment; nothing changes automatically. Reviews time out after 60 seconds.</p>
      : phase === "awaiting_approval" ? <p>Review the explanation, then approve or discard. The current settings stay in place until you approve.</p>
      : phase === "queued" ? <p>Enough observations are available. The engine will start this review on its next check, after any other cat’s review finishes.</p>
      : phase === "scheduled" ? <p>Trainer cooldown active. Next eligible review: {activity.nextReviewAt ? when(activity.nextReviewAt) : "waiting for observations"}.</p>
      : <div className="coach-observations">
        <label>Decisions <span>{activity.observations} / {activity.requiredObservations} minimum</span><progress max={activity.requiredObservations} value={Math.min(activity.observations, activity.requiredObservations)} /></label>
        <label>Observation time <span>{activity.observedMinutes} / {activity.requiredMinutes} min minimum</span><progress max={activity.requiredMinutes} value={Math.min(activity.observedMinutes, activity.requiredMinutes)} /></label>
        <p>Both minimums are required. {activity.nextReviewAt ? `Earliest review: ${when(activity.nextReviewAt)}.` : "Waiting for the first recorded trading decision."}</p>
      </div>}
    <p className="coach-last-run">{activity.reviewCount} review{activity.reviewCount === 1 ? "" : "s"} attempted{latest ? ` · Last: ${reviewStatus[latest.status]} · ${when(latest.completedAt ?? latest.createdAt)}` : " · No model review yet"}</p>
    {latest?.status !== "pending" && <p className="coach-no-action">{latest?.status === "no_change" ? "Review complete: the trainer recommends keeping the current settings. " : ""}No decision awaiting approval or discard.</p>}
    {latest?.error && <p className="negative">{latest.error} No settings changed.</p>}
  </div>;
}
