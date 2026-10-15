import { describe, expect, it } from 'vitest';
import type { Settings } from '../../../../shared/types.js';
import { ConfigSchema } from '../../config.js';
import { DEFAULT_SETTINGS } from '../../settings.js';
import { type CloudWatchLike } from '../cloudwatch.js';
import { LiveCollector } from '../live.js';
import { MockCollector } from '../mock.js';
import { redisCollector, redisStatusHealth, type ElastiCacheLike } from './redis.js';

const STEP = 300_000;
const NOW = Math.floor(Date.UTC(2026, 9, 15, 10, 7) / STEP) * STEP + 60_000;
const END = Math.floor(NOW / STEP) * STEP;
const cfg = ConfigSchema.parse({ resources: { redis: [{ replicationGroupId: 'rg', nodes: ['rg-0001-001', 'rg-0002-001', 'stray'] }, { replicationGroupId: 'missing', nodes: ['m-001'] }] } });
const ctx = { now: NOW, settings: DEFAULT_SETTINGS as Settings };
const cw: CloudWatchLike = { send: async () => ({ Datapoints: [{ Timestamp: new Date(END - STEP), Average: 42, Sum: 0 }] }) } as unknown as CloudWatchLike;
const ec = (shardStatus = 'available'): ElastiCacheLike => ({
  send: async (cmd) => {
    if (cmd.input.ReplicationGroupId === 'missing') throw Object.assign(new Error('x'), { name: 'ReplicationGroupNotFoundFault' });
    return {
      ReplicationGroups: [
        {
          Status: 'available',
          NodeGroups: [
            { NodeGroupId: '0001', Status: 'available', NodeGroupMembers: [{ CacheClusterId: 'rg-0001-001', CurrentRole: 'primary' }] },
            { NodeGroupId: '0002', Status: shardStatus, NodeGroupMembers: [{ CacheClusterId: 'rg-0002-001' }] },
          ],
        },
      ],
    };
  },
});

describe('redis collector', () => {
  it('maps status', () => {
    expect(redisStatusHealth('available')).toBe('OK');
    expect(redisStatusHealth('snapshotting')).toBe('WARN');
    expect(redisStatusHealth('create-failed')).toBe('CRIT');
  });

  it('builds nodes from the replication group and metrics; flags unknown nodes and missing groups', async () => {
    const res = await new LiveCollector(cw, [redisCollector(cfg, ec())], new MockCollector(cfg)).collect(ctx);
    const g = res.groups.find((x) => x.type === 'redis')!;
    const by = Object.fromEntries(g.items.map((i) => [i.id, i]));
    expect(by['rg-0001-001']!.subtitle).toBe('primary · shard 0001 · rg');
    expect(by['rg-0002-001']!.subtitle).toBe('shard 0002 · rg');
    expect(by['rg-0001-001']!.health).toBe('OK');
    expect(by['rg-0001-001']!.metrics.map((m) => m.key)).toEqual(['cpu', 'mem', 'conns', 'evict']);
    expect(by['stray']!.statusText).toBe('not in group');
    expect(by['stray']!.health).toBe('CRIT');
    expect(by['m-001']!.statusText).toBe('not found');
    expect(res.metricsRequested).toBe(16); // 4 nodes x 4 metrics
    expect(res.apiCalls).toBe(18); // + 2 free Describe calls
  });

  it('warns while a shard is modifying', async () => {
    const res = await new LiveCollector(cw, [redisCollector(cfg, ec('modifying'))], new MockCollector(cfg)).collect(ctx);
    expect(res.groups.find((x) => x.type === 'redis')!.items.find((i) => i.id === 'rg-0002-001')!.health).toBe('WARN');
  });
});
