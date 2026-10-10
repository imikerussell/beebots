import type { ReactNode } from "react";
import { EquityChart } from "./EquityChart";
import type { Cat, CatId, Profile, Snapshot } from "./types";
import type { Curve } from "./useFeed";

export const usd = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
export const CAT_IDS: CatId[] = ["tiger", "mochi"];
export const CAT_META = {
  tiger: {
    name: "DARK Wall-E",
    persona: "DARK",
    img: "/cats/wall-e-dark.png",
    style: "The bolder side",
    coins: ["BTC", "ETH", "SOL"],
    color: "#ffb443",
    number: "01",
  },
  mochi: {
    name: "Good Wall-E",
    persona: "GOOD",
    img: "/cats/wall-e-good.png",
    style: "The patient, friendly side",
    coins: ["BTC", "ETH"],
    color: "#85cfff",
    number: "02",
  },
};

// Keep existing ledger IDs and custom names; translate the original default names.
export const catName = (id: CatId, name?: string) =>
  !name || name === (id === "tiger" ? "Tiger" : "Mochi")
    ? CAT_META[id].name
    : name;

export function CatCard({
  id,
  cat,
  meta,
  curve,
  snap,
  coaching,
}: {
  id: CatId;
  cat?: Cat;
  meta?: Profile["cats"][number];
  curve?: Curve;
  snap: Snapshot | null;
  coaching?: ReactNode;
}) {
  const identity = CAT_META[id];
  const name = catName(id, cat?.name ?? meta?.name);
  const trainerEntry = snap?.coach?.entries.find(e => e.cat === id && e.review && "quip" in e.review && ["pending", "accepted"].includes(e.status));
  const trainerReview = trainerEntry?.review;
  const metrics = cat
    ? [
        ["Realized P&L", usd(cat.totals.realisedUsd)],
        ["Unrealized P&L", usd(cat.uplUsd)],
        ["Fees", usd(cat.totals.feesUsd)],
        ["Funding", usd(cat.totals.fundingUsd)],
        ["Max drawdown", `${cat.maxDrawdownPct.toFixed(2)}%`],
        ["Exposure", usd(cat.exposureUsd)],
        ["Stop price", cat.position?.stopPx?.toLocaleString() ?? "—"],
        [
          "Decision latency",
          cat.last?.latencyMs == null ? "—" : `${cat.last.latencyMs} ms`,
        ],
      ]
    : [
        "Realized P&L",
        "Unrealized P&L",
        "Fees",
        "Funding",
        "Max drawdown",
        "Exposure",
        "Stop price",
        "Decision latency",
      ].map((label) => [label, "—"]);
  return (
    <article className={`cat ${id}`}>
      <div className="cat-hero">
        <img
          className="cat-portrait"
          src={identity.img}
          alt={`${name}, Wall-E the brown tabby ${id === "tiger" ? "wearing a black cape in dramatic amber light" : "in soft, friendly daylight"}`}
        />
        <div className="cat-identity">
          <span className="cat-number">
            {identity.persona} / {identity.number}
          </span>
          <h2 aria-label={name}>
            {name === identity.name ? (
              <>
                <span className="persona-attribute">{identity.persona}</span>{" "}
                <span className="persona-name">Wall-E</span>
              </>
            ) : name}
          </h2>
          <p className="cat-personality">{identity.style}</p>
          <div className="coin-tags">
            {(meta?.coins ?? identity.coins).map((coin) => (
              <span key={coin}>{coin}</span>
            ))}
          </div>
        </div>
        <span className="strategy-tag">
          {id === "tiger" ? "↗ DAILY BREAKOUT" : "≈ TREND FOLLOWING"}
        </span>
      </div>
      <div className="cat-body">
        {trainerReview && "quip" in trainerReview && <div className="trainer-quip"><p><b>Trainer{trainerEntry?.status === "pending" ? " suggestion" : ""}:</b> {trainerReview.quip}</p><p>{trainerReview.reason}</p></div>}
        <div className="equity-heading">
          <span className="eyebrow">Portfolio equity</span>
          <span
            className={`position-tag ${cat?.position ? "position-open" : ""}`}
          >
            {cat
              ? cat.position
                ? `${cat.position.side.toUpperCase()} ${cat.position.coin}`
                : "IN CASH"
              : "AWAITING ENGINE"}
          </span>
        </div>
        <div className="equity">
          <strong>{cat ? usd(cat.equityUsd) : "—"}</strong>
          {cat && (
            <span className={cat.pnlUsd >= 0 ? "positive" : "negative"}>
              {cat.pnlUsd >= 0 ? "↗" : "↘"} {pct(cat.pnlPct)}
              <small>{usd(cat.pnlUsd)}</small>
            </span>
          )}
        </div>
        <div className="capital-line">
          Allocated <b>{cat ? usd(cat.allocatedUsd) : "—"}</b>
          <span>
            Cash <b>{cat ? usd(cat.cashUsd) : "—"}</b>
          </span>
        </div>
        <EquityChart
          curve={curve ?? (cat && snap ? [[snap.ts, cat.equityUsd]] : [])}
          color={identity.color}
          baseline={cat?.allocatedUsd ?? 100}
          gradientId={id}
        />
        <div className="chart-caption">
          <span>
            <i /> EQUITY HISTORY
          </span>
          <span>Since allocation · USD</span>
        </div>
        <div className="decision">
          <div className="decision-head">
            <span className="eyebrow">Latest recorded action</span>
            <span className="decision-time">
              {cat?.last
                ? new Date(cat.last.ts).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—"}
            </span>
          </div>
          <h3>
            {cat?.last?.choice ??
              (cat?.last ? "Risk check / model error" : "Watching. Waiting.")}
          </h3>
          <p>
            {cat?.last?.status ??
              (cat
                ? "No decision recorded yet. Cash is a valid position."
                : "Connect the engine to see recorded decisions.")}
          </p>
          {cat?.last?.vetoedBy && (
            <div className="negative">Risk veto: {cat.last.vetoedBy}</div>
          )}
          {cat?.cap && <div className="negative">Entry limit: {cat.cap}</div>}
        </div>
        {coaching}
        <dl className="metrics">
          {metrics.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="entry-budget">
          <div>
            <span>Entries today</span>
            <b>{cat ? `${cat.tradesToday} / ${cat.maxTradesPerDay}` : "—"}</b>
          </div>
          <div className="meter-track">
            <div
              style={{
                width: `${cat ? Math.min(100, (cat.tradesToday / Math.max(1, cat.maxTradesPerDay)) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
        {cat?.position && (
          <p className="position-detail">
            {cat.position.contracts} contracts @{" "}
            {cat.position.entryPx.toFixed(2)}
          </p>
        )}
        <details className="strategy-details">
          <summary>
            How {name} trades <span aria-hidden="true">↗</span>
          </summary>
          <p>
            {meta?.tagline ??
              (id === "tiger"
                ? "Bizzy volatility breakout"
                : "Breezy long/short trend")}
          </p>
          {meta?.strategyFacts?.length ? (
            <ul>
              {meta.strategyFacts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          ) : (
            <p>Connect the engine to load the current strategy rules.</p>
          )}
          {meta?.rules && <p>{meta.rules}</p>}
          <p>Experiment rules; profitability has not been established.</p>
        </details>
      </div>
    </article>
  );
}
