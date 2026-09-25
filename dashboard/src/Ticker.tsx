import { memo } from "react";
import { BEE_META, type DecisionEvent } from "./types";

const signed = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;

const Row = memo(function Row({ d }: { d: DecisionEvent }) {
  const meta = BEE_META[d.bee];
  const top = d.probabilities.slice(0, 3);
  const acted = d.action !== "hold";
  const live = d.live;
  const move = live ? (live.deltaUsd > 0 ? "up" : live.deltaUsd < 0 ? "down" : "still") : "still";
  // Jev's probability for the label it chose (not its separate "confidence" score), so it matches the bars.
  const pChoice = d.probabilities.find((p) => p.label === d.choice)?.p ?? null;
  return (
    <li className={`tick ${acted ? "acted" : ""} ${d.pulse ? "pulse" : ""} move-${move}`} style={{ ["--bee" as string]: meta.color }}>
      <div className="tick-line">
        <span className="tick-dot" />
        <span className="tick-bee">{meta.short}</span>
        <span className="tick-choice">{d.choice ?? (d.jev === "unreachable" ? "Jev unreachable" : d.jev === "daily_cap" ? "Jev cap hit" : "no call")}</span>
        <span className="tick-meta num">
          {live && (
            <span className={`tick-money ${live.valueUsd >= 0 ? "good" : "bad"}`} title={live.kind === "open" ? "open P&L" : "total P&L"}>
              {live.valueUsd >= 0 ? "▲" : "▼"} {signed(live.valueUsd)}
            </span>
          )}
          {pChoice !== null && <span>{Math.round(pChoice * 100)}%</span>}
          {d.latencyMs !== null && <span className="dim">{d.latencyMs}ms</span>}
        </span>
      </div>
      {d.watch ? (
        <div className="tick-pulse num">
          <span className="side flat">WATCHING</span>
          <span>{d.watch}</span>
        </div>
      ) : d.pulse && live ? (
        <div className="tick-pulse num">
          {live.side ? <span className={`side ${live.side}`}>{live.side === "long" ? "▲ LONG" : "▼ SHORT"}</span> : <span className="side flat">FLAT</span>}
          <span className="dim">{live.kind === "open" ? "open P&L" : "total P&L"}</span>
          <span className={`tick-delta ${move}`}>{move === "still" ? "±$0.00" : signed(live.deltaUsd)}</span>
          <span className="dim">benched · Jev sits out</span>
        </div>
      ) : (
        top.length > 0 && (
          <div className="tick-bars">
            {top.map((p) => (
              <span key={p.label} className="tick-bar" title={`${p.label} ${Math.round(p.p * 100)}%`}>
                <span className="tick-bar-fill" style={{ width: `${Math.max(3, p.p * 100)}%`, background: p.label === d.choice ? meta.color : "var(--muted-bar)" }} />
                <span className="tick-bar-label">{p.label}</span>
              </span>
            ))}
          </div>
        )
      )}
      {!d.pulse && (d.vetoedBy || d.forcedBy || acted) && (
        <div className={`tick-note ${d.forcedBy ? "forced" : d.vetoedBy ? "veto" : "act"}`}>
          {d.forcedBy ? `⚡ code forced: ${d.action}` : d.vetoedBy ? `✋ code said no: ${d.vetoedBy}` : `→ ${d.action}`}
        </div>
      )}
    </li>
  );
});

export function Ticker({ decisions, perMin }: { decisions: DecisionEvent[]; perMin: number }) {
  return (
    <section className="rail-card ticker">
      <div className="rail-head">
        <span className="eyebrow">Decision stream</span>
        <span className="num dim">{perMin}/min</span>
      </div>
      <ol className="ticks">
        {decisions.map((d) => (
          <Row key={`${d.ts}-${d.bee}`} d={d} />
        ))}
      </ol>
    </section>
  );
}
