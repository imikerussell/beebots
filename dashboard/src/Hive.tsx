// "Join the Hive" in the header: the public leaderboard at beebots.tech. Status comes from this install's own engine
// (GET /hive/status, never the leaderboard itself), so the dashboard is the same whether or not the Hive is reachable.
// Joining and leaving carry the owner password picked on Setup.
import { useCallback, useEffect, useState } from "react";
import { BEE_META, BEE_NAMES, HIVE_DISCLAIMER, type HiveStatus } from "./types";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function boardHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "beebots.tech";
  }
}

function HiveDialog({ status, onClose, onStatus }: { status: HiveStatus; onClose: () => void; onStatus: (s: HiveStatus) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (what: "join" | "leave") => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await fetch(`/hive/${what}`, { method: "POST", headers: { "content-type": "application/json", "x-owner-password": encodeURIComponent(password) }, body: "{}" });
      const j = (await r.json().catch(() => ({}))) as HiveStatus & { error?: string; left?: { remote: boolean; detail: string } };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      onStatus(j);
      setNote(what === "join" ? "You're in. The first report goes out in a few seconds." : (j.left?.detail ?? "You left the Hive."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const board = status.board || "https://beebots.tech";
  const passwordOk = password.length >= 8;
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="hive-title">
        <button className="modal-x" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 id="hive-title">{status.joined ? "In the Hive ✓" : "Join the Hive"}</h2>
        <p className="modal-disclaimer">{HIVE_DISCLAIMER}</p>

        {status.joined && (
          <div className="hive-report">
            <div className="eyebrow">Last report</div>
            <div>{status.lastReportAt ? ago(status.lastReportAt) : "first report pending"}</div>
            {status.verified && (
              <ul className="hive-verified">
                {BEE_NAMES.map((b) => (
                  <li key={b} className={status.verified?.[b] ? "good" : "dim"}>
                    {status.verified?.[b] ? "✓" : "–"} {BEE_META[b].short} <span className="dim">{status.verified?.[b] ? "verified" : "not verified yet"}</span>
                  </li>
                ))}
              </ul>
            )}
            {status.problem && <p className="bad">{status.problem}</p>}
          </div>
        )}

        {!status.paper && !status.joined ? (
          <p className="bad">The Hive is for paper trading only. This engine runs with real money, so it can't join.</p>
        ) : !status.passwordSet ? (
          <p className="bad">
            This server has no owner password yet. Run Setup again to pick one (see the README), or set <code>OWNER_PASSWORD</code> and restart the
            engine.
          </p>
        ) : (
          <>
            <label className="modal-label" htmlFor="owner-password">
              Owner password
            </label>
            <input
              id="owner-password"
              className="modal-input"
              type="password"
              autoComplete="current-password"
              placeholder="The password you picked on Setup"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && passwordOk && !busy && void act(status.joined ? "leave" : "join")}
              autoFocus
            />
            <p className="modal-hint dim">Forgot it? Run Setup again to pick a new one (see the README).</p>
          </>
        )}
        {status.locked && <p className="bad">Too many wrong passwords. Locked for 15 minutes.</p>}
        {error && <p className="bad">{error}</p>}
        {note && <p className="good">{note}</p>}

        <div className="modal-actions">
          <a href={board} target="_blank" rel="noopener">
            See the hive on {boardHost(board)} ↗
          </a>
          {status.joined ? (
            <button className="danger" disabled={busy || !passwordOk || !status.passwordSet} onClick={() => void act("leave")}>
              {busy ? "Leaving…" : "Leave"}
            </button>
          ) : (
            <button disabled={busy || !passwordOk || !status.paper || !status.passwordSet} onClick={() => void act("join")}>
              {busy ? "Joining…" : "Join"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function HiveButton() {
  const [status, setStatus] = useState<HiveStatus | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    void fetch("/hive/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<HiveStatus>) : null))
      .then((s) => s && setStatus(s))
      .catch(() => undefined);
  }, []);

  // Faster while the dialog is open, so the first report after joining shows up.
  useEffect(() => {
    load();
    const t = setInterval(load, open ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [load, open]);

  // No engine answer (older engine, or still starting): no button, nothing else changes.
  if (!status) return null;
  return (
    <>
      <button className={`hive-btn ${status.joined ? "in" : ""}`} onClick={() => setOpen(true)}>
        {status.joined ? "In the Hive ✓" : "🐝 Join the Hive"}
      </button>
      {open && <HiveDialog status={status} onClose={() => setOpen(false)} onStatus={setStatus} />}
    </>
  );
}
