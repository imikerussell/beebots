import { TrainerPanel } from "./TrainerPanel";
import { EngineStatus } from "./EngineStatus";
import { DecisionStream } from "./DecisionStream";
import { useState } from "react";
import { MorningReport, type Report } from "./MorningReport";
import { CAT_IDS, CatCard, catName, usd } from "./CatCard";
import { useFeed } from "./useFeed";
import type { CatId } from "./types";

export function App() {
  const {
    snap,
    profile,
    curves,
    decisions,
    liveDecisionKeys,
    connected,
    streamStatus,
    historyStatus,
    refresh,
  } = useFeed();
  const [report, setReport] = useState<Report | string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const loadReport = async () => {
    setReportLoading(true);
    try {
      const r = await fetch("/report");
      if (!r.ok) throw new Error();
      setReport((await r.json()) as Report);
    } catch {
      setReport("Report unavailable. Is the engine running?");
    } finally {
      setReportLoading(false);
    }
  };
  const equity = snap?.cats.reduce((sum, cat) => sum + cat.equityUsd, 0) ?? 0;
  const pnl = snap?.cats.reduce((sum, cat) => sum + cat.pnlUsd, 0) ?? 0;
  const fees =
    snap?.cats.reduce((sum, cat) => sum + cat.totals.feesUsd, 0) ?? 0;
  const totalDecisions =
    snap?.cats.reduce((sum, cat) => sum + cat.totals.decisions, 0) ?? 0;
  const nameFor = (id: CatId) =>
    catName(
      id,
      snap?.cats.find((c) => c.bee === id)?.name ??
        profile?.cats.find((c) => c.id === id)?.name,
    );

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <div>
            <h1>
              catfolio<span>.</span>
            </h1>
            <div className="brand-sub">SMALL PAWS. BIG CONVICTION.</div>
          </div>
        </div>
        <section className="overview" aria-label="Portfolio overview">
          <div>
            <span className="eyebrow">Combined equity</span>
            <strong>{snap ? usd(equity) : "—"}</strong>
          </div>
          <div>
            <span className="eyebrow">Total P&L</span>
            <strong className={pnl >= 0 ? "positive" : "negative"}>
              {snap ? `${pnl >= 0 ? "+" : ""}${usd(pnl)}` : "—"}
            </strong>
          </div>
          <div>
            <span className="eyebrow">Fees paid</span>
            <strong>{snap ? usd(fees) : "—"}</strong>
          </div>
          <div>
            <span className="eyebrow">Decisions</span>
            <strong>{snap ? totalDecisions.toLocaleString() : "—"}</strong>
          </div>
          <div>
            <span className="eyebrow">Open positions</span>
            <strong>
              {snap ? snap.cats.filter((c) => c.position).length : "—"}
              <small> / 2</small>
            </strong>
          </div>
        </section>
        <div className="header-actions">
          <span className={`mode ${snap?.mode === "LIVE" ? "danger" : ""}`}>
            {snap?.mode ? `${snap.mode} TRADING` : "NOT CONNECTED"}
          </span>
          <button
            className="report-button"
            disabled={reportLoading}
            onClick={() => void loadReport()}
          >
            {reportLoading ? "Loading…" : "Morning report ↗"}
          </button>

        </div>
      </header>
      {!connected && (
        <div className="notice danger" role="status">
          <span className="notice-icon">!</span>
          <div>
            <strong>The den is offline.</strong>{" "}
            {snap
              ? "Displayed values may be stale. "
              : "Portfolio values will appear when the engine connects. "}
            Start it with <code>pnpm dev</code>.
          </div>
        </div>
      )}
      {snap?.closed && (
        <div className="notice">
          {snap.closed.flat
            ? "Run closed. Both personas are flat."
            : "Closing run. Waiting for fresh quotes to exit remaining positions."}
        </div>
      )}
      <div className="trading-desk">
        <section className="cats" aria-label="Wall-E persona portfolios">
          {CAT_IDS.map((id) => (
            <CatCard
              key={id}
              id={id}
              cat={snap?.cats.find((c) => c.bee === id)}
              meta={profile?.cats.find((c) => c.id === id)}
              curve={curves[id]}
              snap={snap}
              connected={connected}
              onReset={refresh}

            />
          ))}
        </section>
        <aside className="sidebar">
          <EngineStatus snap={snap} connected={connected && streamStatus === "live"} decisions={decisions} />
          <TrainerPanel state={snap?.coach} connected={connected} names={{ tiger: nameFor("tiger"), mochi: nameFor("mochi") }} />
          <DecisionStream
            liveDecisionKeys={liveDecisionKeys}
            decisions={decisions}
            names={{ tiger: nameFor("tiger"), mochi: nameFor("mochi") }}
            streamStatus={streamStatus}
            historyStatus={historyStatus}
            intervalMs={snap?.decisionIntervalMs}
            closed={!!snap?.closed}
          />
        </aside>
      </div>
      {report !== null && (
        <MorningReport
          report={report}
          names={Object.fromEntries(CAT_IDS.map((id) => [id, nameFor(id)]))}
          close={() => setReport(null)}
        />
      )}
      <footer>
        <span className="footer-brand">
          catfolio<span>.</span>
        </span>
        <p>Paper fills include simulated costs · Experimental strategies</p>
        <span className="footer-note">Based on <a href="https://github.com/imikerussell/beebots">beebots</a> · MIT · No investment advice</span>
      </footer>
    </main>
  );
}
