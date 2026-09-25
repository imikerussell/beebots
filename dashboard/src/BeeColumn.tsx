import { EquityChart } from "./EquityChart";
import { BEE_META, type BeeName, type PublicBee } from "./types";
import type { Curve, FeedState } from "./useFeed";

const CAP_LABEL: Record<string, string> = { trade_cap: "BENCHED", fee_budget: "BENCHED", loss_stop: "SENT HOME", retired: "RETIRED" };

export const money = (x: number, d = 2) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const signed = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const px = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 1 }) : x >= 1 ? x.toFixed(3) : x.toPrecision(4);

function Delta({ usd, pct }: { usd: number; pct?: number }) {
  const up = usd >= 0;
  return (
    <span className={up ? "good" : "bad"}>
      {up ? "▲" : "▼"} {signed(usd)}
      {pct !== undefined && <span className="dim"> ({up ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</span>}
    </span>
  );
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const frac = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="num">{text}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${frac >= 1 ? "full" : frac >= 0.75 ? "warn" : ""}`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

export function ProbBars({ top3, choice, color, big }: { top3: Array<[string, number]>; choice: string | null; color: string; big?: boolean }) {
  return (
    <div className={`probs ${big ? "big" : ""}`}>
      {top3.map(([label, p]) => (
        <div className={`prob ${label === choice ? "chosen" : ""}`} key={label}>
          <span className="prob-label">{label}</span>
          <span className="prob-track">
            <span className="prob-fill" style={{ width: `${Math.max(2, p * 100)}%`, background: label === choice ? color : "var(--muted-bar)" }} />
          </span>
          <span className="prob-p num">{Math.round(p * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  name: BeeName;
  bee: PublicBee | undefined;
  curve: Curve | undefined;
  baseline: number;
  rank: number;
  gap: number | null;
  flash: FeedState["flashes"][BeeName];
}

export function BeeColumn({ name, bee, curve, baseline, rank, gap, flash }: Props) {
  const meta = BEE_META[name];
  const p = bee?.position ?? null;
  const flashing = flash && Date.now() - flash.at < 2500;
  const cap = bee?.cap ?? null;

  return (
    <section className={`bee ${flashing ? `flash-${flash.kind}` : ""}`} style={{ ["--bee" as string]: meta.color, ["--bee-glow" as string]: meta.glow }}>
      <header className="bee-head">
        <div className="portrait">
          <img src={meta.img} alt={`${meta.short} portrait`} />
        </div>
        <div className="bee-id">
          <div className="bee-name">{meta.short}</div>
          <div className="bee-tag">
            {meta.tagline || meta.styleLabel}
            {meta.coins.length > 0 && <span className="bee-coins"> · {meta.coins.join(" ")}</span>}
            {meta.tagline && <span className="bee-style"> · {meta.styleLabel}</span>}
          </div>
          {meta.rules && (
            <div className="bee-rules" title={meta.rules}>
              {meta.rules}
            </div>
          )}
        </div>
        <div className="rank">
          <div className="rank-n">#{rank}</div>
          {gap !== null && <div className="rank-gap num">{gap === 0 ? "leading" : `${money(gap)} behind`}</div>}
        </div>
      </header>

      <div className="equity">
        <div className="equity-value num">{bee ? money(bee.equityUsd) : "–"}</div>
        {bee && <Delta usd={bee.pnlUsd} pct={bee.pnlPct} />}
      </div>

      {/* In the flow, never over the equity figure. */}
      {cap && (
        <div className="cap-banner" role="status">
          <div className="cap-title">{CAP_LABEL[cap]}</div>
          <div className="cap-detail">{bee?.last?.status}</div>
        </div>
      )}
      <div className={`position ${p ? p.side : "flat"}`}>
        {p ? (
          <>
            <div className="pos-main">
              <span className={`side ${p.side}`}>{p.side === "long" ? "▲ LONG" : "▼ SHORT"}</span>
              <span className="pos-coin">{p.coin}</span>
              <span className="pos-size num">{p.sizeUsd !== null ? money(p.sizeUsd, 0) : ""}</span>
            </div>
            <div className="pos-upl num">
              <Delta usd={p.uplUsd} />
              <span className="dim"> unrealised · {p.minutesHeld}m held</span>
            </div>
            <div className="pos-px num dim">
              entry {px(p.entryPx)} → mark {px(p.markPx)} · stop {px(p.stopPx)}
            </div>
          </>
        ) : (
          <div className="pos-main">
            <span className="side flat">FLAT</span>
            <span className="dim">{bee?.flatMinutes ?? 0}m in cash</span>
          </div>
        )}
      </div>

      <EquityChart curve={curve ?? []} color={meta.color} baseline={baseline} gradientId={`g-${meta.short}`} />

      <div className="last">
        <div className="last-head">
          <span className="eyebrow">Jev’s last call</span>
          {bee?.last?.latencyMs != null && <span className="dim num">{bee.last.latencyMs} ms</span>}
        </div>
        {cap === "trade_cap" || cap === "fee_budget" ? (
          <div className="dim">sitting out while benched: nothing Jev picks could be acted on until 00:00 UTC</div>
        ) : bee?.last?.top3.length ? (
          <ProbBars top3={bee.last.top3} choice={bee.last.choice} color={meta.color} big />
        ) : (
          <div className="dim">waiting…</div>
        )}
        <div className="status">{bee?.last?.status ?? ""}</div>
      </div>

      <div className="meters">
        <Meter label="Trades today" value={bee?.tradesToday ?? 0} max={bee?.maxTradesPerDay ?? 1} text={`${bee?.tradesToday ?? 0} / ${bee?.maxTradesPerDay ?? "–"}`} />
        <Meter label="Fee budget" value={bee?.feesTodayUsd ?? 0} max={bee?.feeBudgetUsd ?? 1} text={`${money(bee?.feesTodayUsd ?? 0)} / ${money(bee?.feeBudgetUsd ?? 0)}`} />
      </div>

      <div className="costs num">
        <div>
          <span className="eyebrow">fees</span>
          {money(bee?.totals.feesUsd ?? 0)}
        </div>
        <div>
          <span className="eyebrow">funding</span>
          {signed(bee?.totals.fundingUsd ?? 0)}
        </div>
        <div>
          <span className="eyebrow">Jev</span>
          {money(bee?.totals.jevUsd ?? 0, 4)}
        </div>
        <div>
          <span className="eyebrow">calls</span>
          {(bee?.totals.decisions ?? 0).toLocaleString()}
        </div>
      </div>

      {flashing && flash.kind === "funding" && <div className="funding-chip num">{flash.text}</div>}
    </section>
  );
}
