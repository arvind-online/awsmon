import { describe, expect, it } from 'vitest';
import type { Settings } from '../../../../shared/types.js';
import { ConfigSchema } from '../../config.js';
import { DEFAULT_SETTINGS } from '../../settings.js';
import { StatisticsReader, type CloudWatchLike } from '../cloudwatch.js';
import { LiveCollector } from '../live.js';
import { MockCollector } from '../mock.js';
import { kinesisCollector, streamHealth, type KinesisLike } from './kinesis.js';

const STEP = 300_000;
const NOW = Math.floor(Date.UTC(2026, 9, 15, 10, 7) / STEP) * STEP + 60_000;
const END = Math.floor(NOW / STEP) * STEP;
const cfg = ConfigSchema.parse({ resources: { kinesis: [{ stream: 'a' }, { stream: 'b' }] } });
const ctx = { now: NOW, settings: DEFAULT_SETTINGS as Settings };

const cw = (age: number): CloudWatchLike =>
  ({
    send: async (cmd: { input: { MetricName?: string } }) => {
      const throttles = cmd.input.MetricName === 'WriteProvisionedThroughputExceeded';
      return { Datapoints: [{ Timestamp: new Date(END - STEP), Sum: throttles ? 0 : 10, Maximum: age }] };
    },
  }) as unknown as CloudWatchLike;
const kin = (status: string, shards = 2, mode = 'PROVISIONED'): KinesisLike => ({
  send: async () => ({ StreamDescriptionSummary: { StreamStatus: status, OpenShardCount: shards, StreamModeDetails: { StreamMode: mode } } }),
});

describe('kinesis collector', () => {
  it('maps stream status', () => {
    expect(streamHealth('ACTIVE')).toBe('OK');
    expect(streamHealth('UPDATING')).toBe('WARN');
    expect(streamHealth('DELETING')).toBe('CRIT');
  });

  it('combines the status API with metrics and counts calls', async () => {
    const mock = new MockCollector(cfg);
    const res = await new LiveCollector(cw(5000), [kinesisCollector(cfg, kin('ACTIVE'))], mock).collect(ctx);
    const g = res.groups.find((x) => x.type === 'kinesis')!;
    expect(g.simulated).toBeUndefined();
    expect(g.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(g.items[0]!.subtitle).toBe('provisioned · 2 shards');
    expect(g.items[0]!.statusText).toBe('ACTIVE');
    expect(g.items[0]!.metrics.find((m) => m.key === 'age')!.latest).toBe(5000);
    expect(res.metricsRequested).toBe(8); // 2 streams x 4 metrics
    expect(res.apiCalls).toBe(10); // + 2 free DescribeStreamSummary calls
  });

  it('raises the stream to CRIT when iterator age passes the threshold, and to WARN while updating', async () => {
    const mock = new MockCollector(cfg);
    const slow = await new LiveCollector(cw(400_000), [kinesisCollector(cfg, kin('ACTIVE'))], mock).collect(ctx);
    expect(slow.groups.find((x) => x.type === 'kinesis')!.health).toBe('CRIT');
    const upd = await new LiveCollector(cw(1000), [kinesisCollector(cfg, kin('UPDATING', 1, 'ON_DEMAND'))], mock).collect(ctx);
    const g = upd.groups.find((x) => x.type === 'kinesis')!;
    expect(g.health).toBe('WARN');
    expect(g.items[0]!.subtitle).toBe('on-demand · 1 shard');
  });

  it('isolates a Describe failure', async () => {
    const bad: KinesisLike = { send: async () => Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' })) };
    const res = await new LiveCollector(cw(1), [kinesisCollector(cfg, bad)], new MockCollector(cfg)).collect(ctx);
    expect(res.groups.find((x) => x.type === 'kinesis')!.error).toBe('AccessDeniedException: denied');
  });
});
