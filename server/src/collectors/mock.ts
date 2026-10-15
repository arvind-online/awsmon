import type { Config } from '../config.js';
import type { GroupType, Health, Item, Metric, Point, Unit } from '../../../shared/types.js';
import { levelFor, worst } from '../health.js';
import type { CollectContext, CollectResult, CollectedGroup, Collector } from './types.js';

const STEP_MS = 5 * 60_000;
const POINTS = 36; // 3 hours at 5-minute resolution, as GetMetricData would return

/** Deterministic hash noise in [0,1). */
function noise(seed: number, k: number): number {
  let h = (seed * 374761393 + k * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface Wave {
  base: number;
  amp: number;
  periodMin: number;
  jitter: number;
  min?: number;
  max?: number;
  /** Optional spike: [every N minutes, lasts M minutes, adds X]. */
  spike?: [number, number, number];
}

function wave(id: string, w: Wave, now: number): Point[] {
  const seed = seedOf(id);
  const phase = noise(seed, 1) * Math.PI * 2;
  const end = Math.floor(now / STEP_MS) * STEP_MS;
  const pts: Point[] = [];
  for (let i = POINTS - 1; i >= 0; i--) {
    const t = end - i * STEP_MS;
    const minutes = t / 60_000;
    let v = w.base + w.amp * Math.sin((2 * Math.PI * minutes) / w.periodMin + phase) + (noise(seed, Math.floor(t / STEP_MS)) - 0.5) * 2 * w.jitter;
    if (w.spike) {
      const [every, lasts, add] = w.spike;
      const offset = Math.floor(noise(seed, 7) * every);
      if ((minutes + offset) % every < lasts) v += add;
    }
    pts.push([t, Math.min(w.max ?? Infinity, Math.max(w.min ?? 0, v))]);
  }
  return pts;
}

function metric(
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

function item(id: string, name: string, subtitle: string | undefined, statusText: string, statusHealth: Health, metrics: Metric[]): Item {
  return { id, name, subtitle, statusText, health: worst([statusHealth, ...metrics.map((m) => m.health)]), metrics };
}

const PER = '5 min';

/** MOCK_FAIL=kinesis,redis simulates those collectors failing, to exercise staleness handling. */
const failing = () => new Set((process.env.MOCK_FAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean));

export class MockCollector implements Collector {
  constructor(private readonly cfg: Config) {}

  async collect({ now, settings }: CollectContext): Promise<CollectResult> {
    const t = settings.thresholds;
    const groups: CollectedGroup[] = [];
    const fail = failing();
    let metricsRequested = 0;
    const count = (items: Item[]) => {
      for (const i of items) metricsRequested += i.metrics.length;
      return items;
    };

    // ECS
    const ecsItems: Item[] = [];
    for (const c of this.cfg.resources.ecs) {
      for (const svc of c.services) {
        const id = `${c.cluster}/${svc}`;
        const desired = 2;
        const degraded = noise(seedOf(id), Math.floor(now / 3_600_000)) > 0.93;
        const running = degraded ? desired - 1 : desired;
        ecsItems.push(
          item(id, svc, `cluster ${c.cluster}`, `${running}/${desired} tasks running`, running < desired ? 'CRIT' : 'OK', [
            metric('cpu', 'CPU', 'percent', wave(`${id}:cpu`, { base: 38, amp: 18, periodMin: 140, jitter: 6, max: 100 }, now), { warn: t.cpuWarnPct, crit: t.cpuCritPct, bad: 'high' }),
            metric('mem', 'Memory', 'percent', wave(`${id}:mem`, { base: 54, amp: 8, periodMin: 300, jitter: 2, max: 100 }, now), { warn: t.memWarnPct, crit: t.memCritPct, bad: 'high' }),
          ]),
        );
      }
    }
    groups.push(group('ecs', 'ECS services', count(ecsItems), fail));

    // Aurora PostgreSQL
    const auroraItems: Item[] = [];
    for (const c of this.cfg.resources.aurora) {
      for (const inst of c.instances) {
        const memGiB = inst.memoryGiB ?? 16;
        const memUsedPct = wave(`${inst.id}:mem`, { base: 58, amp: 6, periodMin: 400, jitter: 1.5, max: 100 }, now);
        const metrics = [
          metric('cpu', 'CPU', 'percent', wave(`${inst.id}:cpu`, { base: inst.role === 'writer' ? 34 : 18, amp: 14, periodMin: 110, jitter: 5, max: 100, spike: inst.role === 'writer' ? [240, 15, 35] : undefined }, now), { warn: t.cpuWarnPct, crit: t.cpuCritPct, bad: 'high' }),
          metric('mem', 'Memory used', 'percent', memUsedPct, { warn: t.memWarnPct, crit: t.memCritPct, bad: 'high' }),
          metric('conns', 'Connections', 'count', wave(`${inst.id}:conns`, { base: 120, amp: 40, periodMin: 180, jitter: 10 }, now)),
        ];
        if (inst.role === 'reader') metrics.push(metric('lag', 'Replica lag', 'ms', wave(`${inst.id}:lag`, { base: 12, amp: 6, periodMin: 90, jitter: 4 }, now), { warn: 500, crit: 2000, bad: 'high' }));
        auroraItems.push(item(inst.id, inst.id, `${inst.role} · ${memGiB} GiB · cluster ${c.clusterId}`, 'available', 'OK', metrics));
      }
    }
    groups.push(group('aurora', 'Aurora PostgreSQL', count(auroraItems), fail));

    // Lambda
    const lambdaItems = count(
      this.cfg.resources.lambda.map((fn, i) => {
        const inv = wave(`${fn.name}:inv`, { base: 220 + i * 90, amp: 120, periodMin: 160, jitter: 30, spike: i === 1 ? [300, 20, 400] : undefined }, now);
        const err = inv.map(([ts, v]): Point => [ts, Math.max(0, v * (0.004 + noise(seedOf(fn.name), Math.floor(ts / STEP_MS)) * (i === 1 ? 0.03 : 0.006)))]);
        return item(fn.name, fn.name, 'function', 'active', 'OK', [
          metric('inv', 'Invocations', 'count', inv, { per: PER }),
          metric('err', 'Errors', 'count', err, { warn: 5, crit: 20, bad: 'high', per: PER }),
          metric('thr', 'Throttles', 'count', wave(`${fn.name}:thr`, { base: 0.4, amp: 0.3, periodMin: 200, jitter: 0.3 }, now), { warn: 3, crit: 10, bad: 'high', per: PER }),
          metric('dur', 'Duration', 'ms', wave(`${fn.name}:dur`, { base: 240 + i * 60, amp: 70, periodMin: 130, jitter: 25 }, now)),
        ]);
      }),
    );
    groups.push(group('lambda', 'Lambda', lambdaItems, fail));

    // Kinesis
    const kinesisItems = count(
      this.cfg.resources.kinesis.map((k, i) => {
        const age = wave(`${k.stream}:age`, { base: 4000, amp: 2500, periodMin: 150, jitter: 1500, spike: i === 0 ? [180, 25, 90_000] : undefined }, now);
        return item(k.stream, k.stream, 'stream', 'ACTIVE', 'OK', [
          metric('in', 'Incoming', 'count', wave(`${k.stream}:in`, { base: 1800 + i * 700, amp: 600, periodMin: 120, jitter: 150 }, now), { per: PER }),
          metric('out', 'Read', 'count', wave(`${k.stream}:out`, { base: 1790 + i * 700, amp: 590, periodMin: 120, jitter: 150 }, now), { per: PER }),
          metric('age', 'Iterator age', 'ms', age, { warn: t.iteratorAgeWarnMs, crit: t.iteratorAgeCritMs, bad: 'high' }),
          metric('thr', 'Write throttles', 'count', wave(`${k.stream}:thr`, { base: 0.2, amp: 0.15, periodMin: 200, jitter: 0.2 }, now), { warn: 1, crit: 10, bad: 'high', per: PER }),
        ]);
      }),
    );
    groups.push(group('kinesis', 'Kinesis', kinesisItems, fail));

    // ElastiCache Redis
    const redisItems: Item[] = [];
    for (const g of this.cfg.resources.redis) {
      g.nodes.forEach((n, i) => {
        redisItems.push(
          item(n, n, `${i === 0 ? 'primary' : 'replica'} · ${g.replicationGroupId}`, 'available', 'OK', [
            metric('cpu', 'Engine CPU', 'percent', wave(`${n}:cpu`, { base: 14, amp: 7, periodMin: 100, jitter: 3, max: 100 }, now), { warn: t.cpuWarnPct, crit: t.cpuCritPct, bad: 'high' }),
            metric('mem', 'Memory used', 'percent', wave(`${n}:mem`, { base: 46, amp: 4, periodMin: 500, jitter: 1, max: 100 }, now), { warn: t.memWarnPct, crit: t.memCritPct, bad: 'high' }),
            metric('conns', 'Connections', 'count', wave(`${n}:conns`, { base: 85, amp: 20, periodMin: 150, jitter: 6 }, now)),
            metric('evict', 'Evictions', 'count', wave(`${n}:evict`, { base: 0, amp: 0, periodMin: 100, jitter: 0 }, now), { warn: 1, crit: 100, bad: 'high', per: PER }),
          ]),
        );
      });
    }
    groups.push(group('redis', 'ElastiCache Redis', count(redisItems), fail));

    // Alarms: provisioned, disabled until the collector is switched on.
    const alarmsOn = this.cfg.collectors.alarms.enabled;
    groups.push({
      type: 'alarms',
      title: 'CloudWatch alarms',
      health: 'OK',
      items: [],
      disabled: !alarmsOn,
      emptyNote: alarmsOn ? 'No alarms in ALARM state' : 'Not set up yet',
    });

    return { groups, metricsRequested, apiCalls: 1 + this.cfg.resources.ecs.length + this.cfg.resources.aurora.length * 2 + this.cfg.resources.kinesis.length + this.cfg.resources.redis.length, simulated: true };
  }
}

function group(type: GroupType, title: string, items: Item[], fail: Set<string>): CollectedGroup {
  if (fail.has(type)) return { type, title, items: [], health: 'UNKNOWN', error: 'Simulated collector failure (MOCK_FAIL)' };
  return { type, title, items, health: worst(items.map((i) => i.health)), emptyNote: items.length === 0 ? 'Nothing configured' : undefined };
}
