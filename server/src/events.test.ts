import { describe, expect, it } from 'vitest';
import type { Group, Health } from '../../shared/types.js';
import { diffHealth } from './events.js';

const item = (id: string, health: Health) => ({ id, name: id, health, statusText: 'ok', metrics: [] });
const group = (items: ReturnType<typeof item>[], extra: Partial<Group> = {}): Group => ({ type: 'ecs', title: 'ECS services', health: 'OK', items, lastSuccessAt: 1, ...extra });

describe('diffHealth', () => {
  it('records item transitions only', () => {
    const ev = diffHealth([group([item('a', 'OK'), item('b', 'OK')])], [group([item('a', 'WARN'), item('b', 'OK')])], 100);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ itemId: 'a', from: 'OK', to: 'WARN', at: 100 });
  });

  it('ignores items that appear for the first time', () => {
    expect(diffHealth([group([])], [group([item('new', 'CRIT')])], 1)).toEqual([]);
  });

  it('records a collector failing and recovering, without item noise while failing', () => {
    const ok = group([item('a', 'OK')]);
    const failing = group([item('a', 'OK')], { error: 'boom' });
    const failEv = diffHealth([ok], [failing], 1);
    expect(failEv).toHaveLength(1);
    expect(failEv[0]).toMatchObject({ itemId: '', to: 'UNKNOWN' });
    const recoverEv = diffHealth([failing], [group([item('a', 'OK')])], 2);
    expect(recoverEv[0]).toMatchObject({ itemId: '', from: 'UNKNOWN', note: 'Collector recovered' });
  });
});
