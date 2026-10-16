import type { Health, Unit } from '../../shared/types';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatValue(unit: Unit, v: number | null): string {
  if (v === null || Number.isNaN(v)) return '–';
  switch (unit) {
    case 'percent':
      return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
    case 'bytes': {
      const gib = v / 1024 ** 3;
      return gib >= 1 ? `${gib.toFixed(gib < 10 ? 1 : 0)} GiB` : `${(v / 1024 ** 2).toFixed(0)} MiB`;
    }
    case 'ms':
      if (v >= 60_000) return `${(v / 60_000).toFixed(1)} min`;
      if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
      return `${int.format(v)}ms`;
    case 'rate':
      return `${compact.format(v)}/s`;
    case 'count':
      return v >= 1000 ? compact.format(v) : v < 10 && v % 1 !== 0 ? v.toFixed(1) : int.format(v);
  }
}

/** "Fri 16:00": used on long time axes and tooltips where the day matters. */
export function formatDayClock(ts: number): string {
  return `${new Date(ts).toLocaleDateString([], { weekday: 'short' })} ${formatClock(ts)}`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function countdown(ts: number, now: number): string {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function usd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export const HEALTH_LABEL: Record<Health, string> = { OK: 'Healthy', WARN: 'Warning', CRIT: 'Critical', UNKNOWN: 'Unknown' };
