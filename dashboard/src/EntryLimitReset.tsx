import { useRef, useState } from "react";
import type { Cat } from "./types";

export function EntryLimitReset({ cat, name, enabled, connected, closed, onReset }: {
  cat: Cat; name: string; enabled: boolean; connected: boolean; closed: boolean; onReset: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const exhausted = cat.maxTradesPerDay > 0 && (cat.entriesUsed ?? cat.tradesToday) >= cat.maxTradesPerDay;
  const available = exhausted && (cat.cap === null || cat.cap === "trade_cap") && !closed;
  const reset = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/controls/reset-entry-limit", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.trim()}` },
        body: JSON.stringify({ cat: cat.bee }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Entry reset failed.");
      setKey(""); dialog.current?.close();
      setNotice(`Entry allowance reset to 0 / ${result.maxTradesPerDay}. Other entry checks still apply.`);
      await onReset();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed. Refresh the dashboard before retrying.");
    } finally { setBusy(false); }
  };
  return <>
    {available && <button className="entry-reset-button" disabled={!enabled || !connected || busy}
      title={!enabled ? "Set COACH_ADMIN_TOKEN on the engine to enable owner controls." : undefined}
      onClick={() => { setError(""); setNotice(""); dialog.current?.showModal(); }}>Reset entry limit</button>}
    {notice && <p className="entry-reset-notice" role="status">{notice}</p>}
    <dialog ref={dialog} className="dashboard-dialog entry-reset-dialog" aria-labelledby={`entry-reset-title-${cat.bee}`}
      onClose={() => setKey("")} onCancel={event => { if (busy) event.preventDefault(); }}>
      <header><h2 id={`entry-reset-title-${cat.bee}`}>Reset {name}’s entry limit</h2>
        <button disabled={busy} aria-label="Close entry reset" onClick={() => dialog.current?.close()}>×</button></header>
      <p>Allow up to {cat.maxTradesPerDay} additional entries before the next limit, or until midnight UTC.</p>
      <p>The {cat.tradesToday} entries already made today stay in the history. Fee budgets, loss stops, cooldowns and signal checks still apply.</p>
      <form onSubmit={event => { event.preventDefault(); if (!busy) void reset(); }}>
        <label htmlFor={`owner-key-${cat.bee}`}>Owner key</label>
        <input id={`owner-key-${cat.bee}`} type="password" autoComplete="off" autoFocus required value={key}
          disabled={busy} onChange={event => setKey(event.target.value)} placeholder="Enter your owner key" />
        {error && <p className="negative" role="alert">{error}</p>}
        <div className="entry-reset-actions">
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" disabled={busy || !key.trim() || !connected || !available}>{busy ? "Resetting…" : "Reset entry limit"}</button>
        </div>
      </form>
    </dialog>
  </>;
}
