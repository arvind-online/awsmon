import { useId, useMemo, useState } from 'react';
import type { Metric, Point, Unit } from '../../../shared/types';
import { formatClock, formatDayClock, formatValue } from '../format';
import { useChangeKey, useMorph } from '../hooks/anim';
import { useSize, useTween } from '../hooks/misc';

/** Monotone cubic interpolation (Fritsch–Carlson): smooth without overshooting the data. */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    m.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1));
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2);
  t.push(m[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${(pts[i]![0] + h).toFixed(1)},${(pts[i]![1] + t[i]! * h).toFixed(1)},${(pts[i + 1]![0] - h).toFixed(1)},${(pts[i + 1]![1] - t[i + 1]! * h).toFixed(1)},${pts[i + 1]![0].toFixed(1)},${pts[i + 1]![1].toFixed(1)}`;
  }
  return d;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * p;
}

/** Axis maximum made of four equal, round steps (1, 2, 2.5, 5 x 10^n), so every gridline label is a clean number. */
const MS_STEPS = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
function quarterMax(v: number, unit?: Unit): number {
  if (unit === 'ms') return 4 * (MS_STEPS.find((s) => s >= v / 4) ?? MS_STEPS.at(-1)!);
  return 4 * niceMax(v / 4 || 0.25);
}

const HOUR_MS = 3_600_000;
/** Round local-clock tick times (every 1, 2, 3, 4 or 6 hours) so a long axis reads 06:00 pm, 10:00 pm, ... instead of 05:40 pm, 09:39 pm. */
function hourTicks(t0: number, t1: number): number[] {
  const step = [1, 2, 3, 4, 6, 12].find((h) => (t1 - t0) / (h * HOUR_MS) <= 7) ?? 12;
  const d = new Date(t0);
  d.setMinutes(0, 0, 0);
  const out: number[] = [];
  for (let t = d.getTime(); t <= t1; t += HOUR_MS) {
    if (t >= t0 && new Date(t).getHours() % step === 0) out.push(t);
  }
  return out;
}

export type SeriesDef = { label: string; points: Point[]; color: string };

/** Tiny inline trend line (one or more series). No axes; the adjacent number carries the value. */
export function Sparkline({ points, series, color = 'var(--series-1)', height = 24, fill = true }: { points?: Point[]; series?: { points: Point[]; color: string }[]; color?: string; height?: number; fill?: boolean }) {
  const id = useId();
  const defs = useMemo(() => series ?? [{ points: points ?? [], color }], [series, points, color]);
  const targets = useMemo(() => defs.map((d) => d.points), [defs]);
  const { frame, domain } = useMorph(targets);
  // Y range from the target data so the scale stays put while lines morph.
  const [lo, hi] = useMemo(() => {
    const vs = targets.flat().map((p) => p[1]);
    return vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 1];
  }, [targets]);
  const span = hi - lo || 1;
  const tN = domain[1] - domain[0] || 1;
  const toXY = (p: Point): [number, number] => [((p[0] - domain[0]) / tN) * 100, 90 - ((p[1] - lo) / span) * 80];
  const paths = frame.map((pts) => {
    if (pts.length < 2) return null;
    const xy = pts.map(toXY);
    const line = smoothPath(xy);
    return { line, area: `${line}L${xy.at(-1)![0]},100L${xy[0]![0]},100Z`, last: xy.at(-1)! };
  });
  if (paths.every((p) => !p)) return <div style={{ height }} />;
  const first = paths[0];
  return (
    <div className="spark" style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
        <defs>
          <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={defs[0]!.color} stopOpacity="0.3" />
            <stop offset="1" stopColor={defs[0]!.color} stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-c`}>
            <rect x="0" y="-5" width="100" height="110" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id}-c)`}>
          {fill && defs.length === 1 && first && <path d={first.area} fill={`url(#${id}-g)`} />}
          {paths.map((p, i) => p && <path key={i} d={p.line} fill="none" stroke={defs[i]!.color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />)}
        </g>
      </svg>
      {defs.length === 1 && first && first.last[0] >= 99 && <span className="spark-dot" style={{ top: `${first.last[1]}%`, background: defs[0]!.color }} />}
    </div>
  );
}

/** Horizontal gauge with warn/crit tick marks. Fill animates between values. */
export function Bar({ value, max = 100, warn, crit, health }: { value: number | null; max?: number; warn?: number; crit?: number; health: string }) {
  const pct = value === null ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="bar" role="meter" aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={max}>
      <div className={`bar-fill bar-${health.toLowerCase()}`} style={{ width: `${pct}%` }} />
      {warn !== undefined && <i className="bar-tick" style={{ left: `${(warn / max) * 100}%` }} />}
      {crit !== undefined && <i className="bar-tick bar-tick-crit" style={{ left: `${(crit / max) * 100}%` }} />}
    </div>
  );
}

/** Radial gauge for percentages, animated sweep and count. */
export function Ring({ value, health, label, size = 84 }: { value: number | null; health: string; label: string; size?: number }) {
  const v = useTween(value);
  const r = 40;
  const c = 2 * Math.PI * r;
  const pct = v === null ? 0 : Math.min(100, Math.max(0, v));
  const arc = c * 0.75; // 270° sweep
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <circle className="ring-track" cx="50" cy="50" r={r} strokeDasharray={`${arc} ${c}`} transform="rotate(135 50 50)" />
        <circle className={`ring-fill ring-${health.toLowerCase()}`} cx="50" cy="50" r={r} strokeDasharray={`${(arc * pct) / 100} ${c}`} transform="rotate(135 50 50)" />
      </svg>
      <div className="ring-text">
        <strong>{v === null ? '–' : `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

const meaningful = (a: number | null, b: number | null) => a !== b && (a === null || b === null || Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b), 1e-9) * 0.005);

/** Animated number that eases toward new values and glows briefly when it changes. */
export function Num({ value, unit }: { value: number | null; unit: Unit }) {
  const v = useTween(value, 700);
  const flash = useChangeKey(value, meaningful);
  // A small random stagger so a poll ripples across the screen instead of every value moving in lockstep.
  const delay = useMemo(() => `${Math.round(Math.random() * 450)}ms`, [flash]);
  return (
    <span key={flash} className={flash ? 'num num-flash' : 'num'} style={flash ? ({ '--flash-delay': delay } as React.CSSProperties) : undefined}>
      {formatValue(unit, v)}
    </span>
  );
}

const PAD = { l: 38, r: 10, t: 10, b: 20 };
const PAD_COMPACT = { l: 2, r: 2, t: 6, b: 4 };
const PAD_DETAILED = { l: 54, r: 16, t: 14, b: 30 };

/** Responsive area/line chart: threshold lines, morphing updates, and a hover crosshair + tooltip. */
export function AreaChart({
  series,
  unit,
  warn,
  crit,
  bad = 'none',
  compact = false,
  detailed = false,
}: {
  series: SeriesDef[];
  unit: Unit;
  warn?: number;
  crit?: number;
  bad?: Metric['bad'];
  compact?: boolean;
  /** Full-size variant for the detail modal: 5 Y ticks, 7 X ticks with the day shown, and a day+time tooltip. */
  detailed?: boolean;
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const targets = useMemo(() => series.map((s) => s.points), [series]);
  const { frame, domain } = useMorph(targets);
  const pad = compact ? PAD_COMPACT : detailed ? PAD_DETAILED : PAD;

  const geo = useMemo(() => {
    const all = targets.flat();
    if (all.length === 0 || w < 40 || h < 24) return null;
    const dataMax = Math.max(...all.map((p) => p[1]));
    let max = unit === 'percent' ? Math.min(100, niceMax(Math.max(dataMax * 1.25, 10))) : niceMax(dataMax * 1.2 || 1);
    if (detailed) max = unit === 'percent' ? Math.min(100, quarterMax(Math.max(dataMax * 1.15, 10))) : quarterMax(dataMax * 1.15 || 1, unit);
    if (bad === 'high' && warn !== undefined && warn > max && warn <= max * 1.4) max = niceMax(warn * 1.1);
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const y = (v: number) => pad.t + ih - (Math.min(v, max) / max) * ih;
    return { max, iw, ih, y };
  }, [targets, w, h, unit, warn, bad, pad, detailed]);

  if (!geo) return <div className={`chart${detailed ? ' chart-detailed' : ''}`} ref={ref} />;
  const [t0, t1] = domain;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * geo.iw;
  const baseY = pad.t + geo.ih;
  const paths = frame.map((pts) => {
    const xy = pts.map((p): [number, number] => [x(p[0]), geo.y(p[1])]);
    const line = smoothPath(xy);
    return { line, area: xy.length > 1 ? `${line}L${xy.at(-1)![0]},${baseY}L${xy[0]![0]},${baseY}Z` : '' };
  });

  const ref0 = series[0]?.points ?? [];
  const onMove = (e: React.PointerEvent) => {
    if (ref0.length === 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const scale = rect.width / w || 1; // display scale (CSS zoom)
    const t = t0 + (((e.clientX - rect.left) / scale - pad.l) / geo.iw) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < ref0.length; i++) if (Math.abs(ref0[i]![0] - t) < Math.abs(ref0[best]![0] - t)) best = i;
    setHover(best);
  };
  const ticks = compact ? [] : (detailed ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1]).map((f) => f * geo.max);
  const xTicks = detailed ? hourTicks(t0, t1) : [t0, (t0 + t1) / 2, t1];
  const xLabel = (t: number, i: number) => (detailed && (i === 0 || new Date(t).getHours() === 0) ? formatDayClock(t) : formatClock(t));
  const anchor = (t: number) => (x(t) < pad.l + 36 ? 'start' : x(t) > w - pad.r - 36 ? 'end' : 'middle');
  const hoverTs = hover !== null ? ref0[hover]?.[0] : undefined;

  return (
    <div className={`chart${detailed ? ' chart-detailed' : ''}`} ref={ref} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg width={w} height={h} role="img" aria-label="Time series chart">
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`${id}-${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity={series.length > 1 ? 0.16 : 0.28} />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
          <clipPath id={`${id}-clip`}>
            <rect x={pad.l} y={0} width={geo.iw} height={h} />
          </clipPath>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line className="grid" x1={pad.l} x2={w - pad.r} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="axis" x={pad.l - 8} y={geo.y(t) + 3.5} textAnchor="end">
              {formatValue(unit, t).replace('.0', '')}
            </text>
          </g>
        ))}
        {!compact &&
          xTicks.map((t, i) => (
            <g key={i}>
              {detailed && <line className="grid grid-v" x1={x(t)} x2={x(t)} y1={pad.t} y2={baseY} />}
              <text className="axis" x={x(t)} y={h - (detailed ? 8 : 4)} textAnchor={detailed ? anchor(t) : i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
                {xLabel(t, i)}
              </text>
            </g>
          ))}
        {bad === 'high' &&
          ([[warn, 'warn'], [crit, 'crit']] as const).map(([v, k]) =>
            v !== undefined && v <= geo.max ? <line key={k} className={`thresh thresh-${k}`} x1={pad.l} x2={w - pad.r} y1={geo.y(v)} y2={geo.y(v)} /> : null,
          )}
        <g clipPath={`url(#${id}-clip)`}>
          {series.map((s, i) => (
            <g key={i} className="series-in" style={{ animationDelay: `${i * 120}ms` }}>
              {i === 0 && <path d={paths[i]?.area} fill={`url(#${id}-${i})`} />}
              <path d={paths[i]?.line} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          ))}
        </g>
        {hover !== null && hoverTs !== undefined && (
          <g>
            <line className="crosshair" x1={x(hoverTs)} x2={x(hoverTs)} y1={pad.t} y2={baseY} />
            {series.map((s, i) => {
              const p = s.points[hover];
              return p ? <circle key={i} className="hover-dot" cx={x(p[0])} cy={geo.y(p[1])} r={4} fill={s.color} /> : null;
            })}
          </g>
        )}
      </svg>
      {hover !== null && hoverTs !== undefined && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(hoverTs), 70), w - 70), top: compact ? -48 : 6 }}>
          <div className="tooltip-time">{detailed ? formatDayClock(hoverTs) : formatClock(hoverTs)}</div>
          {series.map((s, i) => (
            <div key={i} className="tooltip-row">
              <i style={{ background: s.color }} />
              <span>{s.label}</span>
              <b>{formatValue(unit, s.points[hover]?.[1] ?? null)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items, caption }: { items: { label: string; color: string }[]; caption?: string }) {
  return (
    <div className="legend">
      {items.length > 1 &&
        items.map((i) => (
          <span key={i.label}>
            <i style={{ background: i.color }} />
            {i.label}
          </span>
        ))}
      {caption && <em className="legend-caption">{caption}</em>}
    </div>
  );
}
