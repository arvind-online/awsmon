import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.js';
import { MockCollector } from './collectors/mock.js';
import type { CollectResult, Collector } from './collectors/types.js';
import { HistoryService, isGroupType } from './history.js';
import { DEFAULT_SETTINGS } from './settings.js';

const cfg = ConfigSchema.parse({ resources: { kinesis: [{ stream: 'a' }] } });
const settings = { get: () => DEFAULT_SETTINGS } as never;
const usage = () => {
  const calls: unknown[][] = [];
  return { calls, record: (...a: unknown[]) => void calls.push(a) } as never as { calls: unknown[][] } & import('./usage.js').UsageTracker;
};

describe('HistoryService', () => {
  it('knows the card names and nothing else', () => {
    expect(isGroupType('kinesis')).toBe(true);
    expect(isGroupType('../etc')).toBe(false);
  });

  it('returns 24 hours of simulated points for one card', async () => {
    const h = await new HistoryService(new MockCollector(cfg), settings, usage()).get('kinesis');
    expect(h.hours).toBe(24);
    expect(h.group.type).toBe('kinesis');
    expect(h.group.items[0]!.metrics.find((m) => m.key === 'age')!.series).toHaveLength(288);
  });

  it('caches, shares concurrent loads, records live usage once, and backs off after a failure', async () => {
    let loads = 0;
    let t = 1_000_000;
    let fail = false;
    const collector: Collector = {
      collect: async () => ({}) as CollectResult,
      collectGroup: async (type) => {
        loads += 1;
        if (fail) return { groups: [{ type, title: 'x', health: 'UNKNOWN', items: [], error: 'boom' }], live: true, metricsRequested: 0, apiCalls: 0, simulated: false };
        return { groups: [{ type, title: 'x', health: 'OK', items: [] }], live: true, metricsRequested: 14, apiCalls: 16, simulated: false };
      },
    };
    const u = usage();
    const svc = new HistoryService(collector, settings, u, () => t);
    await Promise.all([svc.get('kinesis'), svc.get('kinesis')]);
    await svc.get('kinesis');
    expect(loads).toBe(1);
    expect(u.calls).toEqual([[14, 16, false]]);
    t += 6 * 60_000; // past the 5-minute cache
    fail = true;
    await expect(svc.get('kinesis')).rejects.toThrow('boom');
    await expect(svc.get('kinesis')).rejects.toThrow('boom');
    expect(loads).toBe(2); // second failure served from the 30 s back-off
  });
});
