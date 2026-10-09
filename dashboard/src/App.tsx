import { useState } from "react";
import { MorningReport, type Report } from "./MorningReport";
import { CAT_IDS, CAT_META, CatCard, catName, pct, usd } from "./CatCard";
import { useFeed } from "./useFeed";
import type { CatId } from "./types";

export function App() {
  const { snap, profile, curves, decisions, connected } = useFeed();
  const [showSetup, setShowSetup] = useState(false);
  const [filter, setFilter] = useState<CatId | "all">("all");
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
  const visibleDecisions = decisions.filter(
    (d) => filter === "all" || d.bee === filter,
  );
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
          <span className="brand-symbol" aria-hidden="true">
            ↗
          </span>
          <div>
            <h1>
              catfolio<span>.</span>
            </h1>
            <div className="brand-sub">SMALL PAWS. BIG CONVICTION.</div>
          </div>
        </div>
        <div className="session-label">
          <span className="eyebrow">
            {snap?.closed ? "SESSION CLOSED" : "CURRENT SESSION"}
          </span>
          <span>
            {snap
              ? `Started ${new Date(snap.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${new Date(snap.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Waiting for the engine"}
          </span>
        </div>
        <div className="header-actions">
          <span className={`connection ${connected ? "is-connected" : ""}`}>
            <i />
            {connected ? "Engine connected" : "Engine offline"}
          </span>
          <span className={`mode ${snap?.mode === "LIVE" ? "danger" : ""}`}>
            {snap?.mode ? `${snap.mode} TRADING` : "NOT CONNECTED"}
          </span>
          <button
            aria-expanded={showSetup}
            aria-controls="local-setup"
            onClick={() => setShowSetup(!showSetup)}
          >
            Local setup
          </button>
          <button
            className="report-button"
            disabled={reportLoading}
            onClick={() => void loadReport()}
          >
            {reportLoading ? "Loading…" : "Morning report ↗"}
          </button>
        </div>
      </header>
      {showSetup && (
        <section className="notice" id="local-setup">
          <h3>Local setup</h3>
          <p>
            Copy <code>.env.example</code> to <code>.env</code>, run{" "}
            <code>pnpm run setup</code>, and edit the two local profiles. Load a
            compatible Nimble decision GGUF into LM Studio and set its
            identifier in <code>LM_STUDIO_MODEL</code>. Run{" "}
            <code>pnpm local:check</code> before the experiment. LM Studio needs
            no cloud key. To use Jev, set <code>DECISION_PROVIDER=jev</code> and{" "}
            <code>TYPESAFE_API_KEY</code> in .env, then restart the engine. Jev
            is a billed cloud API.
          </p>
          <p>
            Keep LM Studio loaded and your computer awake.{" "}
            <code>pnpm paper:stop</code> closes the paper run; Ctrl+C pauses the
            engine with positions saved. See README for restart instructions.
          </p>
        </section>
      )}
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
      {snap?.inference.error && (
        <div className="notice danger">{snap.inference.error}</div>
      )}
      {snap?.closed && (
        <div className="notice">
          {snap.closed.flat
            ? "Run closed. Both personas are flat."
            : "Closing run. Waiting for fresh quotes to exit remaining positions."}
        </div>
      )}
      <section className="overview" aria-label="Portfolio overview">
        <div className="overview-equity">
          <span className="eyebrow">Combined equity</span>
          <strong>{snap ? usd(equity) : "—"}</strong>
          <span className="muted">
            {snap
              ? `${usd(snap.totalStartEquityUsd)} starting capital`
              : "Two independent portfolios"}
          </span>
        </div>
        <div>
          <span className="eyebrow">Total P&L</span>
          <strong className={pnl >= 0 ? "positive" : "negative"}>
            {snap ? `${pnl >= 0 ? "+" : ""}${usd(pnl)}` : "—"}
          </strong>
          <span className="muted">
            {snap && snap.totalStartEquityUsd > 0
              ? `${pct((pnl / snap.totalStartEquityUsd) * 100)} all time`
              : "Since allocation"}
          </span>
        </div>
        <div>
          <span className="eyebrow">Fees paid</span>
          <strong>{snap ? usd(fees) : "—"}</strong>
          <span className="muted">Across both personas</span>
        </div>
        <div>
          <span className="eyebrow">Decisions</span>
          <strong>{snap ? totalDecisions.toLocaleString() : "—"}</strong>
          <span className="muted">Every call recorded</span>
        </div>
        <div>
          <span className="eyebrow">Open positions</span>
          <strong>
            {snap ? snap.cats.filter((c) => c.position).length : "—"}
            <small> / 2</small>
          </strong>
          <span className="muted">One position per persona</span>
        </div>
      </section>
      <div className="desk-heading">
        <span className="eyebrow">
          ONE WALL-E. TWO PERSONAS. <span>/</span> 02
        </span>
        <span>Different instincts. Same discipline.</span>
      </div>
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
            />
          ))}
        </section>
        <aside className="sidebar">
          <section className="model-panel">
            <div className="section-title">
              <span className="eyebrow">THE BRAIN</span>
              <span
                className={`model-status ${snap?.inference.connected ? "positive" : "muted"}`}
              >
                <i
                  className={`light ${snap?.inference.connected ? "on" : ""}`}
                />
                {snap?.inference.connected ? "Connected" : "Unavailable"}
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
          <section className="activity">
            <div className="section-title">
              <h2>Decision journal</h2>
              <span className="count-badge">{decisions.length}</span>
            </div>
            <div className="journal-filters" aria-label="Filter decisions">
              {(["all", ...CAT_IDS] as const).map((id) => (
                <button
                  key={id}
                  className={filter === id ? "active" : ""}
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                >
                  {id === "all" ? "All" : nameFor(id)}
                </button>
              ))}
            </div>
            <div className="journal-list">
              {visibleDecisions.length ? (
                visibleDecisions.map((d, i) => (
                  <div
                    className={`journal-row ${d.bee}`}
                    key={`${d.ts}-${d.bee}-${i}`}
                  >
                    <div className="journal-who">
                      <img src={CAT_META[d.bee].img} alt="" />
                      <strong>{nameFor(d.bee)}</strong>
                      <time>
                        {new Date(d.ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </time>
                    </div>
                    <div className="journal-action">
                      {d.choice ?? (d.error ? "Model error" : "Risk check")}
                    </div>
                    <p>{d.status}</p>
                  </div>
                ))
              ) : (
                <div className="journal-empty">
                  <span aria-hidden="true">◎</span>
                  <h3>
                    {filter === "all"
                      ? "Quiet paws for now."
                      : `No calls from ${nameFor(filter)} yet.`}
                  </h3>
                  <p>
                    Recorded decisions land here.
                    <br />
                    Sometimes the best move is to wait.
                  </p>
                </div>
              )}
            </div>
            <div className="journal-note">Recorded actions & rule results.</div>
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
