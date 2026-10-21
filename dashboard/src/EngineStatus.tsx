import { useRef } from "react";
import { usd } from "./CatCard";
import { ModelIssue } from "./ModelIssue";
import type { Decision, Snapshot } from "./types";
import { BrainPanel } from "./BrainPanel";

export function EngineStatus({ snap, connected, decisions = [] }: { snap: Snapshot | null; connected: boolean; decisions?: Decision[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inference = snap?.inference;
  const status = !connected ? "Offline" : inference?.error ? "Decision issue" : inference?.connected ? "Connected" : inference?.requests === 0 ? "Not called yet" : "Awaiting response";
  return <>
    <button className="engine-status" onClick={() => dialog.current?.showModal()} aria-label={`Engine details: ${status}`}>
      <BrainPanel snap={snap} connected={connected} decisions={decisions} />
      <span className="engine-status-stats">{inference?.requests.toLocaleString() ?? "—"} requests · {inference?.latencyMs == null ? "—" : `${inference.latencyMs} ms`} · <span className={inference?.failures ? "negative" : ""}>{inference?.failures ?? "—"} errors</span><span>{snap ? `${snap.decisionIntervalMs / 1000}s cycle` : ""}</span></span>
    </button>
    <dialog ref={dialog} className="dashboard-dialog" aria-label="Engine details" onClick={event => { if (event.target === dialog.current) dialog.current.close(); }}>
      <header><h2>Engine details</h2><button aria-label="Close engine details" onClick={() => dialog.current?.close()}>×</button></header>
      <h3>{inference?.provider ?? "Decision engine"}</h3><p>{inference?.model || "No model connected"} · {status}</p>
      <dl className="model-stats"><div><dt>Requests</dt><dd>{inference?.requests ?? "—"}</dd></div><div><dt>Latency</dt><dd>{inference?.latencyMs == null ? "—" : `${inference.latencyMs} ms`}</dd></div><div><dt>Failures</dt><dd>{inference?.failures ?? "—"}</dd></div></dl>
      {inference?.error && <ModelIssue error={inference.error} connected={connected} closed={!!snap?.closed} />}
      <dl className="model-stats"><div><dt>Last request</dt><dd>{inference?.lastRequestAt ? new Date(inference.lastRequestAt).toLocaleString() : "—"}</dd></div><div><dt>Last success</dt><dd>{inference?.lastSuccessAt ? new Date(inference.lastSuccessAt).toLocaleString() : "—"}</dd></div><div><dt>Active / queued</dt><dd>{inference?.activeRequests ?? "—"} / {inference?.queuedRequests ?? "—"}</dd></div></dl>
      {connected && inference?.retryAt && <p>Provider cooling down until {new Date(inference.retryAt).toLocaleTimeString()}. The next eligible decision will retry automatically.</p>}
      {connected && inference?.requests === 0 && !inference.error && <p>No model request has been made since startup. Rules handle decisions with only a WAIT or HOLD option; model connectivity has not been tested yet.</p>}
      {inference?.estimatedSpentTodayUsd !== undefined && <p>API usage today: {usd(inference.estimatedSpentTodayUsd)} / {usd(inference.dailyUsdCap ?? 0)} · billed separately</p>}
      {inference?.provider === "gemini" && <p>Gemini selects a menu action at most once per cat every {(inference.minIntervalMs ?? 60000)/1000} seconds. When its key, budget or response is unavailable, the code chooser can trade by fixed menu priorities. Code does not read free-text rules. Every decision records its actual source. Gemini confidence is self-reported, not a calibrated probability or a chance of profit.</p>}
      <dl className="model-stats"><div><dt>Decision interval</dt><dd>{snap ? `${snap.decisionIntervalMs / 1000}s` : "—"}</dd></div><div><dt>Protective checks</dt><dd>{snap ? `${snap.protectiveIntervalMs / 1000}s` : "—"}</dd></div><div><dt>Market updated</dt><dd>{snap?.market.refreshedAt ? new Date(snap.market.refreshedAt).toLocaleTimeString() : "—"}</dd></div></dl>
      <p className="muted">Paper fills simulate spread, fees and adverse slippage. Stop-distance risk is an estimate, not a guaranteed loss limit. One profitable night does not establish a durable advantage.</p>
    </dialog>
  </>;
}
