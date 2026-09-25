import { useEffect, useMemo, useRef, useState } from "react";
import type { Curve } from "./useFeed";

interface Props {
  curve: Curve;
  color: string;
  baseline: number;
  gradientId: string;
}

const PAD = { top: 12, right: 72, bottom: 22, left: 4 };
const usd = (x: number) => `$${x.toFixed(2)}`;
/** Axis labels are % from the start stake, so every bee reads on the same scale. */
const pctFrom = (x: number, base: number) => `${x >= base ? "+" : "−"}${Math.abs(((x - base) / base) * 100).toFixed(1)}%`;
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** One series per chart (the column header names it), start-equity baseline, crosshair hover. */
export function EquityChart({ curve, color, baseline, gradientId }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => {
    const { w, h } = size;
    if (w === 0 || h === 0 || curve.length === 0) return null;
    const pts = curve.length === 1 ? [[curve[0]![0] - 1000, curve[0]![1]] as [number, number], curve[0]!] : curve;
    const t0 = pts[0]![0];
    const t1 = pts[pts.length - 1]![0];
    let lo = Math.min(baseline, ...pts.map((p) => p[1]));
    let hi = Math.max(baseline, ...pts.map((p) => p[1]));
    // Never zoom in tighter than ±1% of the stake, so cents of noise do not look like cliffs.
    const pad = Math.max((hi - lo) * 0.15, baseline * 0.01);
    lo -= pad;
    hi += pad;
    const iw = w - PAD.left - PAD.right;
    const ih = h - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + (t1 === t0 ? iw : ((t - t0) / (t1 - t0)) * iw);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * ih;
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    const area = `${line}L${x(t1).toFixed(1)},${(PAD.top + ih).toFixed(1)}L${x(t0).toFixed(1)},${(PAD.top + ih).toFixed(1)}Z`;
    // Gridline labels, skipping any that would collide with the start baseline label.
    const ticks = [lo + (hi - lo) * 0.15, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.85].filter((v) => Math.abs(v - baseline) / (hi - lo) > 0.08);
    return { pts, x, y, line, area, ticks, t0, t1, ih, iw };
  }, [size, curve, baseline]);

  const onMove = (e: React.PointerEvent) => {
    if (!g) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    let bd = Infinity;
    g.pts.forEach((p, i) => {
      const d = Math.abs(g.x(p[0]) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };

  const last = g?.pts[g.pts.length - 1];
  const hp = g && hover !== null ? g.pts[hover] : null;

  return (
    <div className="chart" ref={ref} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      {g && last && (
        <svg width={size.w} height={size.h} role="img" aria-label={`Equity curve, now ${usd(last[1])}, start ${usd(baseline)}`}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {g.ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + g.iw} y1={g.y(v)} y2={g.y(v)} className="gridline" />
              <text x={PAD.left + g.iw + 8} y={g.y(v)} className="axis" dominantBaseline="middle">
                {pctFrom(v, baseline)}
              </text>
            </g>
          ))}
          <line x1={PAD.left} x2={PAD.left + g.iw} y1={g.y(baseline)} y2={g.y(baseline)} className="baseline" />
          <text x={PAD.left + g.iw + 8} y={g.y(baseline)} className="axis" dominantBaseline="middle">
            start
          </text>
          <path d={g.area} fill={`url(#${gradientId})`} />
          <path d={g.line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={g.x(last[0])} cy={g.y(last[1])} r={9} fill={color} opacity={0.25} className="pulse" />
          <circle cx={g.x(last[0])} cy={g.y(last[1])} r={4.5} fill={color} stroke="var(--card)" strokeWidth={2} />
          <text x={PAD.left + g.iw + 8} y={PAD.top + g.ih + 16} className="axis">
            {time(g.t1)}
          </text>
          <text x={PAD.left} y={PAD.top + g.ih + 16} className="axis">
            {time(g.t0)}
          </text>
          {hp && (
            <g>
              <line x1={g.x(hp[0])} x2={g.x(hp[0])} y1={PAD.top} y2={PAD.top + g.ih} className="crosshair" />
              <circle cx={g.x(hp[0])} cy={g.y(hp[1])} r={5} fill={color} stroke="var(--card)" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {g && hp && (
        <div className="tooltip" style={{ left: Math.min(g.x(hp[0]) + 12, size.w - 150), top: 8 }}>
          <div className="tt-value">
            {usd(hp[1])} <span className="dim">{pctFrom(hp[1], baseline)}</span>
          </div>
          <div className="tt-sub">{new Date(hp[0]).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
        </div>
      )}
      {!g && <div className="chart-empty">collecting equity…</div>}
    </div>
  );
}
