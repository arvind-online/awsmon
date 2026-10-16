import { describe, expect, it } from 'vitest';
import type { Settings } from '../../../../shared/types.js';
import { ConfigSchema } from '../../config.js';
import { DEFAULT_SETTINGS } from '../../settings.js';
import { type CloudWatchLike } from '../cloudwatch.js';
import { LiveCollector } from '../live.js';
import { MockCollector } from '../mock.js';
import { ec2Collector, instanceStatus, type Ec2Like } from './ec2.js';

const STEP = 300_000;
const NOW = Math.floor(Date.UTC(2026, 9, 15, 10, 7) / STEP) * STEP + 60_000;
const END = Math.floor(NOW / STEP) * STEP;
const cfg = ConfigSchema.parse({
  resources: { ec2: [{ instanceId: 'i-0aaaaaaaaaaaaaaaa', name: 'web' }, { instanceId: 'i-0bbbbbbbbbbbbbbbb' }, { instanceId: 'i-0cccccccccccccccc' }] },
});
const ctx = { now: NOW, settings: DEFAULT_SETTINGS as Settings };
const cw = (cpu: number): CloudWatchLike => ({ send: async () => ({ Datapoints: [{ Timestamp: new Date(END - STEP), Average: cpu }] }) }) as unknown as CloudWatchLike;
const ec2 = (checks = 'ok'): Ec2Like =>
  ({
    send: async (cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'DescribeInstancesCommand'
        ? {
            Reservations: [
              {
                Instances: [
                  { InstanceId: 'i-0aaaaaaaaaaaaaaaa', InstanceType: 't3.large', State: { Name: 'running' } },
                  { InstanceId: 'i-0bbbbbbbbbbbbbbbb', InstanceType: 'm5.xlarge', State: { Name: 'stopped' }, Tags: [{ Key: 'Name', Value: 'batch' }] },
                ],
              },
            ],
          }
        : { InstanceStatuses: [{ InstanceId: 'i-0aaaaaaaaaaaaaaaa', InstanceStatus: { Status: checks }, SystemStatus: { Status: 'ok' } }] },
  }) as unknown as Ec2Like;

describe('ec2 collector', () => {
  it('maps state and status checks', () => {
    expect(instanceStatus('running', { InstanceStatus: { Status: 'ok' }, SystemStatus: { Status: 'ok' } })).toEqual({ text: 'running', health: 'OK' });
    expect(instanceStatus('running', { InstanceStatus: { Status: 'impaired' } }).health).toBe('CRIT');
    expect(instanceStatus('running', { SystemStatus: { Status: 'initializing' } }).health).toBe('WARN');
    expect(instanceStatus('stopped', undefined).health).toBe('WARN');
    expect(instanceStatus('terminated', undefined).health).toBe('CRIT');
    expect(instanceStatus(undefined, undefined)).toEqual({ text: 'not found', health: 'CRIT' });
  });

  it('shows live CPU for running instances, placeholders for RAM and storage, and flags stopped or unknown ones', async () => {
    const res = await new LiveCollector(cw(35), [ec2Collector(cfg, ec2())], new MockCollector(cfg)).collect(ctx);
    const g = res.groups.find((x) => x.type === 'ec2')!;
    const by = Object.fromEntries(g.items.map((i) => [i.id, i]));
    const web = by['i-0aaaaaaaaaaaaaaaa']!;
    expect(web.name).toBe('web');
    expect(web.subtitle).toBe('t3.large · i-0aaaaaaaaaaaaaaaa');
    expect(web.health).toBe('OK');
    expect(web.metrics.map((m) => m.key)).toEqual(['cpu', 'mem', 'disk']);
    expect(web.metrics[0]!.latest).toBe(35);
    expect(web.metrics[1]).toMatchObject({ latest: null, placeholder: 'Needs CloudWatch Agent', health: 'OK' });
    expect(by['i-0bbbbbbbbbbbbbbbb']).toMatchObject({ name: 'batch', statusText: 'stopped', health: 'WARN' });
    expect(by['i-0bbbbbbbbbbbbbbbb']!.metrics[0]!.placeholder).toBe('Not running');
    expect(by['i-0cccccccccccccccc']).toMatchObject({ statusText: 'not found', health: 'CRIT' });
    expect(res.metricsRequested).toBe(1); // CPU for the one running instance only
  });

  it('goes CRIT on impaired status checks or high CPU', async () => {
    const bad = await new LiveCollector(cw(35), [ec2Collector(cfg, ec2('impaired'))], new MockCollector(cfg)).collect(ctx);
    expect(bad.groups.find((x) => x.type === 'ec2')!.items[0]!.health).toBe('CRIT');
    const hot = await new LiveCollector(cw(95), [ec2Collector(cfg, ec2())], new MockCollector(cfg)).collect(ctx);
    expect(hot.groups.find((x) => x.type === 'ec2')!.items[0]!.health).toBe('CRIT');
  });

  it('hides the card when no instances are configured', async () => {
    const empty = ConfigSchema.parse({});
    const res = await new LiveCollector(cw(1), [ec2Collector(empty, ec2())], new MockCollector(empty)).collect(ctx);
    expect(res.groups.find((x) => x.type === 'ec2')!.disabled).toBe(true);
  });
});
