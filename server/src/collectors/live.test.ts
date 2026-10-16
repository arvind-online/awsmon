import { describe, expect, it } from 'vitest';
import type { Settings } from '../../../shared/types.js';
import { ConfigSchema } from '../config.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { StatisticsReader, type CloudWatchLike } from './cloudwatch.js';
import { LiveCollector } from './live.js';
import { MockCollector } from './mock.js';
import { lambdaCollector } from './services/lambda.js';

const STEP = 300_000;
const NOW = Math.floor(Date.UTC(2026, 9, 15, 10, 7) / STEP) * STEP + 2 * 60_000; // 2 min into a bucket
const END = Math.floor(NOW / STEP) * STEP;

const cfg = ConfigSchema.parse({ resources: { lambda: [{ name: 'fn-a' }, { name: 'fn-b' }], ecs: [{ cluster: 'c', services: ['s'] }] } });
const ctx = { now: NOW, settings: DEFAULT_SETTINGS as Settings };

function fakeClient(fn: (name: string, metric: string) => { Timestamp: Date; Sum?: number; Average?: number }[] | Error): CloudWatchLike & { calls: number } {
  const c = {
    calls: 0,
    async send(cmd: { input: { MetricName?: string; Dimensions?: { Value?: string }[] } }) {
      c.calls += 1;
      const r = fn(cmd.input.Dimensions?.[0]?.Value ?? '', cmd.input.MetricName ?? '');
      if (r instanceof Error) throw r;
      return { Datapoints: r };
    },
  };
  return c as unknown as CloudWatchLike & { calls: number };
}

describe('StatisticsReader', () => {
  it('returns 5-minute points ending at the last completed bucket, sorted, with zero fill for sums', async () => {
    const client = fakeClient(() => [
      { Timestamp: new Date(END - STEP), Sum: 7 },
      { Timestamp: new Date(END - 3 * STEP), Sum: 3 },
    ]);
    const r = new StatisticsReader(client, NOW);
    const s = await r.series({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensions: { FunctionName: 'x' }, stat: 'Sum', fillZero: true });
    expect(s).toHaveLength(36);
    expect(s.at(-1)).toEqual([END - STEP, 7]);
    expect(s.at(-2)).toEqual([END - 2 * STEP, 0]);
    expect(s.every(([t], i) => i === 0 || t > s[i - 1]![0])).toBe(true);
    expect(r.requests).toBe(1);
  });

  it('covers 24 hours (288 points) when asked, in a single request', async () => {
    const client = fakeClient(() => [{ Timestamp: new Date(END - STEP), Sum: 1 }]);
    const r = new StatisticsReader(client, NOW, 24);
    const s = await r.series({ namespace: 'AWS/Lambda', metricName: 'Errors', dimensions: { FunctionName: 'x' }, stat: 'Sum', fillZero: true });
    expect(s).toHaveLength(288);
    expect(r.requests).toBe(1);
  });

  it('leaves gaps for averages (no zero fill)', async () => {
    const client = fakeClient(() => [{ Timestamp: new Date(END - STEP), Average: 120 }]);
    const s = await new StatisticsReader(client, NOW).series({ namespace: 'AWS/Lambda', metricName: 'Duration', dimensions: { FunctionName: 'x' }, stat: 'Average' });
    expect(s).toEqual([[END - STEP, 120]]);
  });
});

describe('LiveCollector', () => {
  const mock = new MockCollector(cfg);

  it('builds the Lambda group from CloudWatch data and counts requests', async () => {
    const client = fakeClient((_, metric) => [{ Timestamp: new Date(END - STEP), Sum: metric === 'Errors' ? 25 : 100, Average: 90 }]);
    const res = await new LiveCollector(client, [lambdaCollector(cfg)], mock).collect(ctx);
    const lambda = res.groups.find((g) => g.type === 'lambda')!;
    expect(lambda.simulated).toBeUndefined();
    expect(lambda.items.map((i) => i.id)).toEqual(['fn-a', 'fn-b']);
    const errors = lambda.items[0]!.metrics.find((m) => m.key === 'err')!;
    expect(errors.latest).toBe(25);
    expect(errors.health).toBe('CRIT');
    expect(lambda.health).toBe('CRIT');
    expect(res.metricsRequested).toBe(8); // 2 functions x 4 metrics
    expect(res.apiCalls).toBe(8);
  });

  it('flags groups without a real collector as simulated, but not disabled ones', async () => {
    const res = await new LiveCollector(fakeClient(() => []), [lambdaCollector(cfg)], mock).collect(ctx);
    expect(res.groups.find((g) => g.type === 'ecs')!.simulated).toBe(true);
    expect(res.groups.find((g) => g.type === 'alarms')!.simulated).toBeUndefined();
    expect(res.simulated).toBe(true);
  });

  it('isolates a failing collector into an errored group instead of failing the poll', async () => {
    const err = Object.assign(new Error('User: arn:aws:iam::123 is not authorized\nto perform: cloudwatch:GetMetricStatistics'), { name: 'AccessDenied' });
    const res = await new LiveCollector(fakeClient(() => err), [lambdaCollector(cfg)], mock).collect(ctx);
    const lambda = res.groups.find((g) => g.type === 'lambda')!;
    expect(lambda.error).toMatch(/^AccessDenied: User:/);
    expect(lambda.error).not.toContain('\n');
    expect(lambda.items).toEqual([]);
    expect(res.groups.find((g) => g.type === 'ecs')).toBeDefined();
  });

  it('marks a function with no invocations as idle', async () => {
    const res = await new LiveCollector(fakeClient(() => []), [lambdaCollector(cfg)], mock).collect(ctx);
    expect(res.groups.find((g) => g.type === 'lambda')!.items[0]!.statusText).toMatch(/idle/);
  });
});
