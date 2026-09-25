import { useEffect, useState } from "react";
import { money, signed } from "./BeeColumn";
import { HiveButton } from "./Hive";
import { PROFILE, type Snapshot } from "./types";

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{new Date(now).toISOString().slice(11, 19)} UTC</span>;
}

function Recon({ recon, mode }: { recon: Snapshot["recon"] | undefined; mode: Snapshot["mode"] | undefined }) {
  const state = !recon || recon.ok === null ? "idle" : recon.ok ? "ok" : "bad";
  const text =
    state === "ok" ? "books match OKX to the cent" : state === "bad" ? recon!.detail : mode === "dry" ? "paper trading: simulated books" : "first check pending";
  return (
    <div className={`recon recon-${state}`} title={recon?.detail}>
      <span className="recon-light" aria-hidden />
      <div>
        <div className="eyebrow">Reconciliation</div>
        <div className="recon-text">{state === "ok" ? "✓ " : state === "bad" ? "✗ " : ""}{text}</div>
      </div>
    </div>
  );
}

/**
 * Official Hostinger mark: path from Simple Icons 16.32.0 (slug "hostinger", CC0 path data),
 * traced from Hostinger's media kit at https://www.hostinger.com/newsroom. Brand colour #673DE6.
 * Rendered white (single-colour treatment) because purple on this near-black header is too dim on camera.
 */
function HostingerMark() {
  return (
    <svg className="host-mark" viewBox="0 0 24 24" role="img" aria-label="Hostinger">
      <path
        fill="currentColor"
        d="M16.415 0v7.16l5.785 3.384V2.949L16.415 0ZM1.8 0v11.237h18.815L14.89 8.09l-7.457-.003V3.024L1.8 0Zm14.615 20.894v-5.019l-7.514-.005c.007.033-5.82-3.197-5.82-3.197l19.119.091V24l-5.785-3.106ZM1.8 13.551v7.343l5.633 2.949v-6.988L1.8 13.551Z"
      />
    </svg>
  );
}

function Counter({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="counter">
      <div className="eyebrow">{label}</div>
      <div className={`counter-value num ${tone ?? ""}`}>{value}</div>
      {sub && <div className="counter-sub num">{sub}</div>}
    </div>
  );
}

export function Header({ snap, connected, stalled, soundOn, onSound }: { snap: Snapshot | null; connected: boolean; stalled: boolean; soundOn: boolean; onSound: () => void }) {
  const day = snap?.startedAt ? Math.floor((Date.now() - snap.startedAt) / 86_400_000) + 1 : 1;
  const t = snap?.totals;
  const jev = snap?.jev;
  const orders = snap?.bees.reduce((a, b) => a + b.totals.orders, 0) ?? 0;
  const decisions = snap?.bees.reduce((a, b) => a + b.totals.decisions, 0) ?? 0;
  const live = connected && !stalled;
  return (
    <header className="top">
      <div className="brand">
        <div className="brand-row">
          <div className="logo">beebots</div>
          <HiveButton />
        </div>
        <div className="brand-sub">
          <span className={`mode mode-${snap?.mode ?? "dry"}`}>{snap?.mode === "live" ? "● LIVE MONEY" : snap?.mode === "demo" ? "OKX DEMO" : "PAPER TRADING"}{snap?.closed ? (snap.closed.flat ? " · ENDED" : " · CLOSING") : ""}</span>
          {snap?.update ? (
            <a className="update-pill" href={`${PROFILE.links?.code ?? "https://github.com/imikerussell/beebots"}/releases/latest`} target="_blank" rel="noopener" title={`You run ${snap.update.current}. See what's new and how to update.`}>
              Update available: {snap.update.latest} ↗
            </a>
          ) : null}
          <span className="dim">
            day {day} · 3 bees · OKX X-Perps · not financial advice
          </span>
        </div>
      </div>

      <div className="counters">
        <Counter label="Total P&L" value={t ? signed(t.pnlUsd) : "–"} tone={t ? (t.pnlUsd >= 0 ? "good" : "bad") : undefined} sub={`${orders} orders`} />
        <Counter label="Fees paid" value={t ? money(t.feesUsd) : "–"} sub="taker 0.05%" />
        <Counter label="Funding" value={t ? signed(t.fundingUsd) : "–"} sub="00 · 08 · 16 UTC" />
        <Counter
          label="Jev spend"
          value={t ? money(t.jevUsd, 4) : "–"}
          sub={jev ? `today ${money(jev.spentTodayUsd, 3)} of ${money(jev.dailyCapUsd, 0)} cap` : undefined}
        />
        <Counter label="Decisions" value={decisions.toLocaleString()} sub={jev?.down ? "Jev unreachable: holding" : jev?.capTripped ? "Jev cap hit: holding" : "every one recorded"} tone={jev?.down || jev?.capTripped ? "bad" : undefined} />
        <Counter label="Visitors" value={snap?.visitors ? snap.visitors.total.toLocaleString() : "–"} sub={snap?.visitors ? `${snap.visitors.watching} watching now` : undefined} />
        <a className="counter host" href={PROFILE.links?.sponsor ?? "https://mrc.fm/beebots"} target="_blank" rel="noopener">
          <div className="eyebrow">Hosted on</div>
          <div className="host-row">
            <HostingerMark />
            <span>Hostinger</span>
          </div>
          <div className="counter-sub">Host your own ↗</div>
        </a>
      </div>

      <div className="top-right">
        <Recon recon={snap?.recon} mode={snap?.mode} />
        <div className="conn">
          <span className={`conn-dot ${live ? "on" : "off"}`} />
          <span>{live ? "live" : connected ? "stalled" : "reconnecting"}</span>
          <Clock />
          <button className={`sound ${soundOn ? "on" : ""}`} onClick={onSound} aria-pressed={soundOn}>
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </div>
    </header>
  );
}
