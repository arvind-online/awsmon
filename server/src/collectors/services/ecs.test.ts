import { describe, expect, it } from 'vitest';
import type { Settings } from '../../../../shared/types.js';
import { ConfigSchema } from '../../config.js';
import { DEFAULT_SETTINGS } from '../../settings.js';
import { type CloudWatchLike } from '../cloudwatch.js';
import { LiveCollector } from '../live.js';
import { MockCollector } from '../mock.js';
import { ecsCollector, serviceStatus, type EcsLike, type EcsService } from './ecs.js';

const STEP = 300_000;
const NOW = Math.floor(Date.UTC(2026, 9, 15, 10, 7) / STEP) * STEP + 60_000;
const END = Math.floor(NOW / STEP) * STEP;
const names = Array.from({ length: 12 }, (_, i) => `svc${i}`);
const cfg = ConfigSchema.parse({ resources: { ecs: [{ cluster: 'c1', services: names }, { cluster: 'c2', services: ['solo'] }] } });
const ctx = { now: NOW, settings: DEFAULT_SETTINGS as Settings };
const cw = (value: number): CloudWatchLike => ({ send: async () => ({ Datapoints: [{ Timestamp: new Date(END - STEP), Average: value }] }) }) as unknown as CloudWatchLike;
const svc = (name: string, o: Partial<EcsService> = {}): EcsService => ({ serviceName: name, status: 'ACTIVE', desiredCount: 2, runningCount: 2, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }], ...o });

describe('serviceStatus', () => {
  it('maps service state to health', () => {
    expect(serviceStatus(svc('a'))).toEqual({ text: '2/2 tasks running', health: 'OK' });
    expect(serviceStatus(svc('a', { runningCount: 1, pendingCount: 1 }))).toEqual({ text: '1/2 tasks running, 1 pending', health: 'CRIT' });
    expect(serviceStatus(svc('a', { deployments: [{ status: 'PRIMARY', rolloutState: 'IN_PROGRESS' }] })).health).toBe('WARN');
    expect(serviceStatus(svc('a', { deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED' }] })).health).toBe('CRIT');
    expect(serviceStatus(svc('a', { status: 'DRAINING' })).health).toBe('WARN');
    expect(serviceStatus(svc('a', { desiredCount: 0, runningCount: 0 })).health).toBe('OK');
    expect(serviceStatus(undefined)).toEqual({ text: 'not found', health: 'CRIT' });
  });
});

describe('ecs collector', () => {
  it('batches DescribeServices in tens, merges status with CPU/memory, and counts calls', async () => {
    const seen: number[] = [];
    const client: EcsLike = {
      send: async (cmd) => {
        const list = cmd.input.services ?? [];
        seen.push(list.length);
        return { services: list.filter((n) => n !== 'svc3').map((n) => svc(n, n === 'svc1' ? { runningCount: 0 } : {})) };
      },
    };
    const res = await new LiveCollector(cw(42), [ecsCollector(cfg, client)], new MockCollector(cfg)).collect(ctx);
    const g = res.groups.find((x) => x.type === 'ecs')!;
    expect(seen).toEqual([10, 2, 1]);
    expect(g.items).toHaveLength(13);
    expect(g.items[0]!.id).toBe('c1/svc0');
    expect(g.items[0]!.metrics.find((m) => m.key === 'cpu')!.latest).toBe(42);
    expect(g.items.find((i) => i.name === 'svc1')!.health).toBe('CRIT');
    expect(g.items.find((i) => i.name === 'svc3')!.statusText).toBe('not found');
    expect(g.health).toBe('CRIT');
    expect(res.metricsRequested).toBe(26);
    expect(res.apiCalls).toBe(29);
  });

  it('isolates a Describe failure', async () => {
    const bad: EcsLike = { send: async () => Promise.reject(Object.assign(new Error('nope'), { name: 'AccessDeniedException' })) };
    const res = await new LiveCollector(cw(1), [ecsCollector(cfg, bad)], new MockCollector(cfg)).collect(ctx);
    expect(res.groups.find((x) => x.type === 'ecs')!.error).toBe('AccessDeniedException: nope');
  });
});
