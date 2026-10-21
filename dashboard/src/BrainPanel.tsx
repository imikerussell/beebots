import { useEffect, useId, useState } from "react";
import { catName } from "./CatCard";
import type { Decision, Snapshot } from "./types";

export const fallbackText = (reason?: string | null) => ({
  no_key: "no Gemini key", cap: "daily budget reached", reservation: "budget reserved",
  backoff: "waiting to retry", timeout: "Gemini timed out", error: "Gemini unavailable",
  off_menu: "answer rejected", single_option: "only legal move", paced: "between model calls",
}[reason ?? ""] ?? "fixed menu priorities");

/** Activity is derived from actual decisions; a connected dashboard alone never implies a model call. */
export function BrainPanel({ snap, connected, decisions }: {snap: Snapshot | null; connected: boolean; decisions: Decision[]}) {
  const [now, setNow] = useState(Date.now());
  const gradient = useId().replaceAll(":", "");
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const gemini = snap?.inference.provider === "gemini";
  const who = gemini ? "ARGON" : snap?.inference.provider === "jev" ? "JEV" : "LOCAL";
  const closed = !!snap?.closed;
  const rows = (["tiger", "mochi"] as const).map(id => {
    const cat = snap?.cats.find(c => c.bee === id);
    const event = decisions.filter(d => d.bee === id).reduce<Decision | null>((latest, d) => !latest || d.ts > latest.ts ? d : latest, null);
    const last = event && event.ts >= (cat?.last?.ts ?? 0) ? event : cat?.last;
    const by = last?.decidedBy ?? (event?.source === "rules" ? "rules" : null);
    const age = last ? Math.max(0, now - last.ts) : null;
    const model = by === "gemini" || by === "jev" || by === "lmstudio";
    const fresh = connected && !closed && model && age !== null && age < 2500;
    const source = by === "code" ? "CODE" : by === "rules" || !model ? "RULES" : who;
    const text = !connected ? "waiting for connection" : closed ? "run closed" : by === "code" ? fallbackText(last?.fallbackReason) : last?.choice || last?.status || "waiting for first decision";
    return {id, name: catName(id, cat?.name), fresh, source, text, age};
  });
  const busy = connected && !closed && (rows.some(r => r.fresh) || (snap?.inference.activeRequests ?? 0) > 0);
  return <div className={`brain-panel ${busy ? "brain-active" : ""} ${!connected || closed ? "brain-idle" : ""}`}>
    <div className="brain-panel-top"><span className="brain-provider"><span aria-hidden="true">✦</span>{gemini ? "Powered by Gemini 4 Argon" : `${who} decision engine`}</span><span className="brain-cycle">{snap ? `${snap.decisionIntervalMs/1000}s cycle` : "offline"}</span></div>
    <div className="brain-network">
      <svg className="brain-links" viewBox="0 0 300 112" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id={gradient}><stop stopColor="#8bb8ff"/><stop offset="1" stopColor="#cf9cff"/></linearGradient></defs>
        {rows.map((r,i) => <g key={r.id} className={r.fresh ? "signal-live" : ""}>
          <path d={`M38 56 C75 56 60 ${i ? 86 : 26} 94 ${i ? 86 : 26}`} stroke={`url(#${gradient})`} />
          <path className="brain-signal" d={`M38 56 C75 56 60 ${i ? 86 : 26} 94 ${i ? 86 : 26}`} stroke={`url(#${gradient})`} />
        </g>)}
      </svg>
      <div className="brain-hub" aria-hidden="true"><span>✦</span><small>{who}</small></div>
      <div className="brain-cats">{rows.map(r => <div className={`brain-cat ${r.id} ${r.fresh ? "brain-cat-active" : ""}`} key={r.id}>
        <img src={`/cats/wall-e-${r.id === "tiger" ? "dark" : "good"}.png`} alt=""/>
        <span><strong>{r.name}</strong><small><b>{r.source}</b> · {r.text}</small></span>
        <time>{r.age === null ? "—" : r.age < 60000 ? `${Math.floor(r.age/1000)}s` : `${Math.floor(r.age/60000)}m`}</time>
      </div>)}</div>
    </div>
    <div className="brain-panel-bottom"><span>{!connected ? "Offline" : closed ? "Run closed" : busy ? `${who} is making a call` : "Waiting for a real choice"}</span><span>{gemini ? "Stops run independently" : "View engine details"} ↗</span></div>
  </div>;
}
