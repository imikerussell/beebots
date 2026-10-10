import { CoachActivity, when } from "./CoachActivity";
import type { CatId, CoachState } from "./types";
import { useEffect, useRef, useState, type FormEvent } from "react";

export function TrainerAccess({ unlocked, restoring, onUnlock, onLock, state, names, connected }: {
  unlocked: boolean;
  restoring: boolean;
  state?: CoachState;
  names: Record<CatId, string>;
  connected: boolean;
  onUnlock: (key: string) => void;
  onLock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) { dialog.current?.showModal(); if (!unlocked) keyInput.current?.focus(); }
    else dialog.current?.close();
  }, [open, unlocked]);
  useEffect(() => () => request.current?.abort(), []);

  function close() {
    request.current?.abort();
    request.current = null;
    setOpen(false);
    setKey("");
    setError("");
    setBusy(false);
  }
  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/coach/unlock", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key.trim()}` },
        body: "{}",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(response.status === 401 ? "That admin key isn’t recognised. Try again."
          : response.status === 503 ? "Trainer access isn’t configured on the engine yet."
          : "Couldn’t unlock trainer mode. Try again.");
      }
      const result = await response.json();
      if (result.ok !== true) throw new Error("Couldn’t verify the admin key. Check the engine connection.");
      if (request.current !== controller) return;
      onUnlock(key.trim());
      setKey("");
      setBusy(false);
      request.current = null;
    } catch (err) {
      if (request.current === controller && !controller.signal.aborted)
        setError(err instanceof Error ? err.message : "Couldn’t reach the engine. Try again.");
    } finally {
      if (request.current === controller) { setBusy(false); request.current = null; }
    }
  }

  const pendingCount = state?.entries.filter((entry) => entry.status === "pending").length ?? 0;
  const heartbeatFresh = !!state?.checkedAt && Date.now() - state.checkedAt <= Math.max(180_000, state.checkIntervalMs * 3);
  const active = connected && !!state?.enabled && heartbeatFresh;
  const trainerStatus = !connected ? "Trainer offline" : !state ? "Checking trainer status…"
    : !state.enabled ? "Trainer paused" : active ? "Trainer active"
    : state.checkedAt ? "Trainer status delayed" : "Trainer starting…";
  const approvalStatus = !connected || !state ? "Awaiting current approval status"
    : pendingCount ? `${pendingCount} ${pendingCount === 1 ? "decision" : "decisions"} awaiting approval`
    : "No decision awaiting approval";
  return <>
    <button className={`trainer-toggle ${unlocked ? "is-unlocked" : ""} ${active ? "is-active" : ""}`} aria-haspopup="dialog"
      disabled={restoring} onClick={() => setOpen(true)}>
      {restoring ? "Restoring trainer…" : unlocked ? <><span className="trainer-toggle-status"><i aria-hidden="true" />{trainerStatus}</span><span className="trainer-toggle-detail">{approvalStatus}</span></> : "you a trainer?"}
    </button>
    <dialog ref={dialog} className={`trainer-dialog ${unlocked ? "trainer-activity-dialog" : ""}`} aria-labelledby="trainer-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) close();
      }}>
      <div className="section-title"><span className="eyebrow">{unlocked ? "STRATEGY TRAINER" : "TRAINER ACCESS"}</span><button className="trainer-close" aria-label="Close trainer window" onClick={close}>×</button></div>
      <h2 id="trainer-title">{unlocked ? "Trainer activity" : "A little guidance?"}</h2>
      {unlocked ? <>
        <div className={`trainer-summary ${active ? "is-active" : ""}`} role="status">
          <strong>{trainerStatus}</strong>
          <p>{approvalStatus}.</p>
          {active && !pendingCount && <p>Nothing to approve or discard right now. Automatic coaching continues in the background.</p>}
          {connected && state && !state.enabled && <p>{state.message}</p>}
          {connected && state?.enabled && !heartbeatFresh && <p>Waiting for a recent scheduler check to confirm activity.</p>}
        </div>
        <p>Observe → AI review → your decision. The engine checks every minute and reviews each cat at most once per 20 hours. Unlocking this window does not start a review.</p>
        {!connected && <p role="status" className="negative">Engine offline. Displayed activity may be out of date.</p>}
        <div className="trainer-model"><span>Review model</span><strong>{state?.model ?? "Waiting for engine"}</strong></div>
        <p className="muted">{state?.checkedAt ? `Scheduler last checked ${when(state.checkedAt)}.` : "Waiting for the engine’s first scheduled check."} Activity refreshes every five seconds.</p>
        {(["tiger", "mochi"] as const).map((cat) => <section className="trainer-cat-activity" key={cat} aria-label={`${names[cat]} review activity`}>
          <h3>{names[cat]}</h3>
          <CoachActivity state={state} cat={cat} />
          <a href={`#cat-coaching-${cat}`} onClick={() => {
            const review = document.getElementById(`cat-coaching-${cat}`);
            if (review instanceof HTMLDetailsElement) review.open = true;
            close();
          }}>Open {names[cat]}’s review & history ↗</a>
        </section>)}
        <details className="trainer-workflow"><summary>How coaching works</summary><ol>
          <li>Each cat needs 30 recorded decisions and at least an hour of observations.</li>
          <li>The coach reviews waits, blocked entries, model failures and portfolio results.</li>
          <li>The trainer proposes new rules and a subset of allowed coins, or reports a visible failure. Every attempt counts toward the 20-hour cooldown. Code still owns trading limits.</li>
          <li>You approve or discard in the cat’s card. Approval changes a future decision; it never forces a trade. Suggestions expire after 24 hours.</li>
        </ol></details>
        <button className="trainer-exit" onClick={() => { close(); onLock(); }}>Exit trainer mode & forget key</button>
        <p className="muted trainer-key-note">Access survives refreshes in this tab. Close the tab or exit trainer mode to forget it.</p>
      </> : <>
        <p>Unlock AI suggestions and review activity for each cat.</p>
        <form onSubmit={(event) => void unlock(event)}>
          <label htmlFor="trainer-key">Admin key</label>
          <input ref={keyInput} id="trainer-key" type="password" value={key} onChange={(event) => setKey(event.target.value)}
            placeholder="Enter your admin key" autoComplete="off" autoFocus required aria-invalid={!!error} aria-describedby={error ? "trainer-error" : "trainer-key-note"} />
          {error && <p id="trainer-error" className="negative" role="alert">{error}</p>}
          <button className="trainer-submit" disabled={!key.trim() || busy}>{busy ? "Checking…" : "Unlock coaching"}</button>
        </form>
        <p id="trainer-key-note" className="muted trainer-key-note">Your key is remembered for this tab, including refreshes. Exit trainer mode to clear it.</p>
      </>}
    </dialog>
  </>;
}
