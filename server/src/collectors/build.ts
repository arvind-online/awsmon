import type { Health, Item, Metric, Point, Unit } from '../../../shared/types.js';
import { levelFor, worst } from '../health.js';
import type { CollectedGroup } from './types.js';

export function metric(
  key: string,
  label: string,
  unit: Unit,
  series: Point[],
  opts: { warn?: number; crit?: number; bad?: 'high' | 'low' | 'none'; per?: string } = {},
): Metric {
  const latest = series.at(-1)?.[1] ?? null;
  const bad = opts.bad ?? 'none';
  return { key, label, unit, latest, series, warn: opts.warn, crit: opts.crit, bad, per: opts.per, health: levelFor(latest, opts.warn, opts.crit, bad) };
}

/** A metric with no data source yet. Healthy by definition, so it never colours the item or the group. */
export function placeholderMetric(key: string, label: string, unit: Unit, placeholder: string): Metric {
  return { key, label, unit, latest: null, series: [], bad: 'none', health: 'OK', placeholder };
}

export function item(id: string, name: string, subtitle: string | undefined, statusText: string, statusHealth: Health, metrics: Metric[]): Item {
  return { id, name, subtitle, statusText, health: worst([statusHealth, ...metrics.map((m) => m.health)]), metrics };
}

export function buildGroup(type: CollectedGroup['type'], title: string, items: Item[]): CollectedGroup {
  return { type, title, items, health: worst(items.map((i) => i.health)), emptyNote: items.length === 0 ? 'Nothing configured' : undefined };
}
