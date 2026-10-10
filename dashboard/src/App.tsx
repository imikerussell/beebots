import { CatCoach } from "./CatCoach";
import { useTrainerSession } from "./useTrainerSession";
import { TrainerAccess } from "./TrainerAccess";
import { ModelIssue } from "./ModelIssue";
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
  const { trainerKey, restoring, unlockTrainer, lockTrainer } =
    useTrainerSession();
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
          <TrainerAccess
            unlocked={!!trainerKey}
            restoring={restoring}
            onUnlock={unlockTrainer}
            onLock={lockTrainer}
            state={snap?.coach}
            connected={connected}
            names={{ tiger: nameFor("tiger"), mochi: nameFor("mochi") }}
          />
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
              coaching={
                trainerKey ? (
                  <CatCoach
                    cat={id}
                    name={nameFor(id)}
                    state={snap?.coach}
                    ownerKey={trainerKey}
                    onUpdate={refresh}
                    onLock={lockTrainer}
                  />
                ) : undefined
              }
            />
          ))}
        </section>
        <aside className="sidebar">
          <DecisionStream
            liveDecisionKeys={liveDecisionKeys}
            decisions={decisions}
            names={{ tiger: nameFor("tiger"), mochi: nameFor("mochi") }}
            streamStatus={streamStatus}
            historyStatus={historyStatus}
            intervalMs={snap?.decisionIntervalMs}
            closed={!!snap?.closed}
          />
          <section className="model-panel">
            <div className="section-title">
              <span className="eyebrow">THE BRAIN</span>
              <span
                className={`model-status ${connected && snap?.inference.connected ? "positive" : "muted"}`}
              >
                <i
                  className={`light ${connected && snap?.inference.connected ? "on" : ""}`}
                />
                {!connected
                  ? "Status unknown"
                  : snap?.inference.error
                    ? "Decision issue"
                    : snap?.inference.connected
                      ? "Connected"
                      : snap?.inference.requests === 0
                        ? "Not called yet"
                        : "Awaiting response"}
              </span>
            </div>
            <h3>{snap?.inference.provider ?? "Decision engine"}</h3>
            <p className="model-name">
              {snap?.inference.model || "No model connected"}
            </p>
            <dl className="model-stats">
              <div>
                <dt>Requests</dt>
                <dd>{snap?.inference.requests ?? "—"}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>
                  {snap?.inference.latencyMs == null
                    ? "—"
                    : `${snap.inference.latencyMs} ms`}
                </dd>
              </div>
              <div>
                <dt>Failures</dt>
                <dd className={snap?.inference.failures ? "negative" : ""}>
                  {snap?.inference.failures ?? "—"}
                </dd>
              </div>
            </dl>
            {connected &&
              snap &&
              !snap.inference.error &&
              !snap.inference.connected &&
              snap.inference.requests === 0 && (
                <p className="model-idle">
                  No model request has been made since this engine started. When
                  WAIT or HOLD is the only available action, the rules handle it
                  without calling the model. Connectivity has not been tested
                  yet.
                </p>
              )}
            {snap?.inference.error && (
              <ModelIssue
                error={snap.inference.error}
                connected={connected}
                closed={!!snap.closed}
              />
            )}
            {snap?.inference.estimatedSpentTodayUsd !== undefined && (
              <p className="muted">
                API usage today: {usd(snap.inference.estimatedSpentTodayUsd)} /{" "}
                {usd(snap.inference.dailyUsdCap ?? 0)} · billed separately
              </p>
            )}
            <div className="model-footnote">
              Two strategies. One selected model.
            </div>
          </section>
          <section className="rhythm-panel">
            <span className="eyebrow">THE RHYTHM</span>
            <div>
              <span>Decision interval</span>
              <b>{snap ? `${snap.decisionIntervalMs / 1000}s` : "—"}</b>
            </div>
            <div>
              <span>Protective checks</span>
              <b>{snap ? `${snap.protectiveIntervalMs / 1000}s` : "—"}</b>
            </div>
            <div>
              <span>Market updated</span>
              <b>
                {snap?.market.refreshedAt
                  ? new Date(snap.market.refreshedAt).toLocaleTimeString()
                  : "—"}
              </b>
            </div>
          </section>
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
        <p>
          Paper fills simulate spread, fees and adverse slippage. Stop-distance
          risk is an estimate, not a guaranteed loss limit. One profitable night
          does not establish a durable advantage.
          <br />A fork of{" "}
          <a href="https://github.com/imikerussell/beebots">
            beebots by Mike Russell
          </a>{" "}
          · MIT license · No investment advice.
        </p>
        <span className="footer-note">BUILT FOR CURIOSITY.</span>
      </footer>
    </main>
  );
}
