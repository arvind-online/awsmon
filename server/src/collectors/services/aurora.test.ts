import { describe, expect, it } from 'vitest';
import type { Settings } from '../../../../shared/types.js';
import { ConfigSchema } from '../../config.js';
import { DEFAULT_SETTINGS } from '../../settings.js';
import { type CloudWatchLike } from '../cloudwatch.js';
import { LiveCollector } from '../live.js';
import { MockCollector } from '../mock.js';
import { auroraCollector, dbHealth, memoryUsedPct, storageUsedPct, type RdsLike } from './aurora.js';

const STEP = 300_000;
const NOW = Math.floor(Date.UTC(2026, 9, 15, 10, 7) / STEP) * STEP + 60_000;
const END = Math.floor(NOW / STEP) * STEP;
const GIB = 1024 ** 3;
const cfg = ConfigSchema.parse({
  resources: {
    aurora: [
      { instances: [{ id: 'db1', memoryGiB: 8 }, { id: 'db2' }, { id: 'gone' }] },
      { clusterId: 'cl', instances: [{ id: 'rd', role: 'reader', memoryGiB: 16 }] },
    ],
  },
});
const ctx = { now: NOW, settings: DEFAULT_SETTINGS as Settings };
const cw: CloudWatchLike = {
  send: async (cmd: { input: { MetricName?: string } }) => ({ Datapoints: [{ Timestamp: new Date(END - STEP), Average: cmd.input.MetricName === 'FreeableMemory' ? 2 * GIB : cmd.input.MetricName === 'FreeStorageSpace' ? 20 * GIB : 30 }] }),
} as unknown as CloudWatchLike;
const rds: RdsLike = {
  send: async (cmd) => {
    const id = cmd.input.DBInstanceIdentifier;
    if (id === 'gone') throw Object.assign(new Error('x'), { name: 'DBInstanceNotFoundFault' });
    return { DBInstances: [{ DBInstanceStatus: id === 'db2' ? 'storage-full' : 'available', DBInstanceClass: 'db.m7g.large', Engine: 'postgres', EngineVersion: '16.13', AllocatedStorage: 80 }] };
  },
};

describe('aurora/rds collector', () => {
  it('maps status to health', () => {
    expect(dbHealth('available')).toBe('OK');
    expect(dbHealth('backing-up')).toBe('WARN');
    expect(dbHealth('storage-full')).toBe('CRIT');
  });

  it('storage over the warn threshold is flagged', () => {
    expect(storageUsedPct([[1, 8 * GIB]], 80)).toEqual([[1, 90]]);
  });

  it('derives memory used from freeable memory and known RAM', () => {
    expect(memoryUsedPct([[1, 2 * GIB]], 8)).toEqual([[1, 75]]);
    expect(memoryUsedPct([[1, 99 * GIB]], 8)[0]![1]).toBe(0);
  });

  it('handles standalone instances, missing instances and aurora readers', async () => {
    const res = await new LiveCollector(cw, [auroraCollector(cfg, rds)], new MockCollector(cfg)).collect(ctx);
    const g = res.groups.find((x) => x.type === 'aurora')!;
    expect(g.items.map((i) => i.id)).toEqual(['db1', 'db2', 'gone', 'rd']);
    const [db1, db2, gone, rd] = g.items as [(typeof g.items)[0], (typeof g.items)[0], (typeof g.items)[0], (typeof g.items)[0]];
    expect(db1.subtitle).toBe('db.m7g.large · postgres 16.13');
    expect(db1.metrics.map((m) => m.key)).toEqual(['cpu', 'mem', 'storage', 'conns']);
    expect(db1.metrics.find((m) => m.key === 'mem')!.latest).toBe(75);
    const disk = db1.metrics.find((m) => m.key === 'storage')!;
    expect(disk.latest).toBe(75); // 20 of 80 GiB free
    expect(disk.health).toBe('OK');
    expect(db1.health).toBe('OK');
    expect(db2.metrics.map((m) => m.key)).toEqual(['cpu', 'storage', 'conns']); // no memoryGiB, no memory gauge
    expect(db2.health).toBe('CRIT');
    expect(gone.statusText).toBe('not found');
    expect(rd.subtitle).toBe('reader · db.m7g.large · postgres 16.13 · cluster cl');
    expect(rd.metrics.map((m) => m.key)).toEqual(['cpu', 'mem', 'conns', 'lag']); // Aurora storage autoscales: no storage gauge
    expect(res.metricsRequested).toBe(3 * 4 + 4); // 3 standalone x (cpu, free mem, free storage, conns) + reader x 4
    expect(res.apiCalls).toBe(res.metricsRequested + 4);
  });
});
