import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, HealthEvent } from '../../shared/types.js';
import { writeJsonAtomic } from './fsutil.js';

const MAX_EVENTS = 200;

/**
 * Health transitions between consecutive snapshots: the history behind the "Recent changes" strip,
 * and the input a future RuleEngine/Notifier will consume.
 */
export function diffHealth(prev: Group[], next: Group[], at: number): HealthEvent[] {
  const events: HealthEvent[] = [];
  const prevGroups = new Map(prev.map((g) => [g.type, g]));
  for (const g of next) {
    const pg = prevGroups.get(g.type);
    if (!pg) continue;
    if (!!g.error !== !!pg.error) {
      events.push({
        id: randomUUID(),
        at,
        groupType: g.type,
        itemId: '',
        name: g.title,
        from: pg.error ? 'UNKNOWN' : pg.health,
        to: g.error ? 'UNKNOWN' : g.health,
        note: g.error ? 'Collector failing; showing last known data' : 'Collector recovered',
      });
    }
    if (g.error) continue; // items are carried over unchanged while failing
    const prevItems = new Map(pg.items.map((i) => [i.id, i]));
    for (const it of g.items) {
      const pi = prevItems.get(it.id);
      if (pi && pi.health !== it.health) {
        events.push({ id: randomUUID(), at, groupType: g.type, itemId: it.id, name: it.name, from: pi.health, to: it.health, note: it.statusText });
      }
    }
  }
  return events;
}

export class EventLog {
  private events: HealthEvent[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'events.json');
    if (existsSync(this.file)) {
      try {
        const e = JSON.parse(readFileSync(this.file, 'utf8')) as HealthEvent[];
        if (Array.isArray(e)) this.events = e.slice(0, MAX_EVENTS);
      } catch {
        /* start fresh */
      }
    }
  }

  add(events: HealthEvent[]): void {
    if (events.length === 0) return;
    this.events = [...[...events].reverse(), ...this.events].slice(0, MAX_EVENTS);
    writeJsonAtomic(this.file, this.events);
  }

  recent(n = 20): HealthEvent[] {
    return this.events.slice(0, n);
  }
}
