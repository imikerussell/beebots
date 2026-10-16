import { useEffect, useRef } from "react";

export interface Report {
  mode: string;
  backends?: Array<{ provider: string; requestedModel: string }>;
  asOf: number;
  cats: Array<{
    cat: string;
    startingEquityUsd: number;
    endingEquityUsd: number;
    netReturnPct: number;
    netPnlUsd: number;
    realisedPnlUsd: number;
    unrealisedPnlUsd: number;
    feesUsd: number;
    estimatedInferenceCostUsd?: number;
    netPnlAfterEstimatedInferenceUsd?: number;
    fundingUsd: number;
    simulatedSlippageUsd: number;
    maxDrawdownPct: number;
    timeExposedHours: number;
    entries: number;
    exits: number;
    vetoes: number;
    modelFailures: number;
    performance?: {
      closedTrades: number;
      winRatePct: number | null;
      expectancyUsd: number | null;
      profitFactor: number | null;
      medianHoldingMinutes: number | null;
      turnoverUsd: number;
    };
    inferenceLatencyMs: {
      median: number | null;
      p95: number | null;
      samples: number;
    };
  }>;
  limitations: string;
}
const dollars = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export function MorningReport({
  report,
  names,
  close,
}: {
  report: Report | string;
  names: Record<string, string>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const rows: Array<[string, (c: Report["cats"][number]) => string]> = [
    ["Starting equity", (c) => dollars(c.startingEquityUsd)],
    ["Ending equity", (c) => dollars(c.endingEquityUsd)],
    [
      "Net return",
      (c) => `${c.netReturnPct.toFixed(2)}% (${dollars(c.netPnlUsd)})`,
    ],
    ["Realized P&L", (c) => dollars(c.realisedPnlUsd)],
    ["Unrealized P&L", (c) => dollars(c.unrealisedPnlUsd)],
    ["Fees", (c) => dollars(c.feesUsd)],
    [
      "Estimated cloud API cost",
      (c) => dollars(c.estimatedInferenceCostUsd ?? 0),
    ],
    [
      "P&L after estimated API cost",
      (c) => dollars(c.netPnlAfterEstimatedInferenceUsd ?? c.netPnlUsd),
    ],
    ["Funding", (c) => dollars(c.fundingUsd)],
    ["Simulated spread / slippage", (c) => dollars(c.simulatedSlippageUsd)],
    ["Maximum drawdown", (c) => `${c.maxDrawdownPct.toFixed(2)}%`],
    ["Time exposed", (c) => `${c.timeExposedHours.toFixed(2)} hours`],
    ["Entries / exits", (c) => `${c.entries} / ${c.exits}`],
    ["Completed round trips", (c) => c.performance ? String(c.performance.closedTrades) : "—"],
    ["Win rate after fees", (c) => c.performance?.winRatePct == null ? "—" : `${c.performance.winRatePct.toFixed(1)}%`],
    ["Average net P&L per trade", (c) => c.performance?.expectancyUsd == null ? "—" : dollars(c.performance.expectancyUsd)],
    ["Profit factor after fees", (c) => c.performance?.profitFactor == null ? "—" : c.performance.profitFactor.toFixed(2)],
    ["Median holding time", (c) => c.performance?.medianHoldingMinutes == null ? "—" : `${c.performance.medianHoldingMinutes.toFixed(1)} min`],
    ["Completed-trade turnover", (c) => c.performance ? dollars(c.performance.turnoverUsd) : "—"],
    ["Vetoes / model failures", (c) => `${c.vetoes} / ${c.modelFailures}`],
    [
      "Median / p95 inference",
      (c) =>
        `${c.inferenceLatencyMs.median ?? "—"} / ${c.inferenceLatencyMs.p95 ?? "—"} ms`,
    ],
  ];
  return (
    <dialog ref={dialog} onCancel={close} aria-label="Morning report">
      <div className="section-title">
        <h2>Morning report</h2>
        <button onClick={close}>Close</button>
      </div>
      {typeof report === "string" ? (
        <p>{report}</p>
      ) : (
        <>
          <p>
            {report.mode} · Whole-run comparison · As of{" "}
            {new Date(report.asOf).toLocaleString()}
          </p>
          <p>
            Providers:{" "}
            {report.backends
              ?.map((b) => `${b.provider} / ${b.requestedModel}`)
              .join(", ") || "No decisions recorded"}
          </p>
          <table className="report-table">
            <thead>
              <tr>
                <th>Measure</th>
                {report.cats.map((c) => (
                  <th key={c.cat}>{names[c.cat] ?? c.cat}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {report.cats.map((c) => (
                    <td key={c.cat}>{value(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {report.cats.some(c=>c.performance) && <p className="muted">Trade statistics reconstruct complete opening-to-flat cycles, including adds, trims and all fill fees. Funding and API costs remain separate; slippage is already included in fills. Profit factor is undefined without losing trades. Coin, direction, exit and strategy-version breakdowns are in the recorded report data below.</p>}
          <p className="muted">{report.limitations}</p>
          <details>
            <summary>Recorded report data</summary>
            <pre>{JSON.stringify(report, null, 2)}</pre>
          </details>
          <a href="/report" download="catfolio-report.json">
            Download report JSON
          </a>
        </>
      )}
    </dialog>
  );
}
