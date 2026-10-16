import { DescribeInstanceStatusCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { Health, Item } from '../../../../shared/types.js';
import type { Config } from '../../config.js';
import { buildGroup, item, metric, placeholderMetric } from '../build.js';
import type { ServiceCollector } from '../types.js';

const NS = 'AWS/EC2';
const AGENT_NOTE = 'Needs CloudWatch Agent';

export interface Ec2Instance {
  InstanceId?: string;
  InstanceType?: string;
  State?: { Name?: string };
  Tags?: { Key?: string; Value?: string }[];
}
export interface Ec2Status {
  InstanceId?: string;
  InstanceStatus?: { Status?: string };
  SystemStatus?: { Status?: string };
}

/** Minimal slice of the SDK client, so tests can fake it. */
export interface Ec2Like {
  send(cmd: DescribeInstancesCommand): Promise<{ Reservations?: { Instances?: Ec2Instance[] }[] }>;
  send(cmd: DescribeInstanceStatusCommand): Promise<{ InstanceStatuses?: Ec2Status[] }>;
}

/** Instance state plus the two EC2 status checks. Impaired checks are CRIT; anything not steadily running is WARN. */
export function instanceStatus(state: string | undefined, st: Ec2Status | undefined): { text: string; health: Health } {
  if (!state) return { text: 'not found', health: 'CRIT' };
  if (state === 'terminated' || state === 'shutting-down') return { text: state, health: 'CRIT' };
  if (state !== 'running') return { text: state, health: 'WARN' };
  const checks = [st?.SystemStatus?.Status, st?.InstanceStatus?.Status];
  if (checks.includes('impaired')) return { text: 'running · status check failed', health: 'CRIT' };
  if (checks.includes('initializing')) return { text: 'running · initializing', health: 'WARN' };
  return { text: 'running', health: 'OK' };
}

/** EC2 is observed through the control plane and CloudWatch only. RAM and disk need the CloudWatch Agent, so they are placeholders for now. */
export function ec2Collector(cfg: Config, client: Ec2Like): ServiceCollector {
  return {
    type: 'ec2',
    title: 'EC2 instances',
    iamActions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus', 'cloudwatch:GetMetricStatistics'],
    async collect({ cw, settings }) {
      const t = settings.thresholds;
      const wanted = cfg.resources.ec2;
      if (wanted.length === 0) return { ...buildGroup('ec2', 'EC2 instances', []), disabled: true, emptyNote: 'No instances configured' };
      // A filter (rather than InstanceIds) so an unknown ID shows as "not found" instead of failing the whole call.
      cw.countCall(2);
      const desc = await client.send(new DescribeInstancesCommand({ Filters: [{ Name: 'instance-id', Values: wanted.map((w) => w.instanceId) }] }));
      const instances = new Map((desc.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => [i.InstanceId, i]));
      // DescribeInstanceStatus has no instance-id filter and rejects unknown IDs, so ask only for the ones that exist.
      const known = [...instances.keys()].filter((id): id is string => !!id);
      const stat = known.length ? await client.send(new DescribeInstanceStatusCommand({ InstanceIds: known, IncludeAllInstances: true })) : { InstanceStatuses: [] };
      const statuses = new Map((stat.InstanceStatuses ?? []).map((s) => [s.InstanceId, s]));

      const items: Item[] = await Promise.all(
        wanted.map(async ({ instanceId, name }) => {
          const inst = instances.get(instanceId);
          const state = inst?.State?.Name;
          const { text, health } = instanceStatus(state, statuses.get(instanceId));
          const display = name ?? inst?.Tags?.find((x) => x.Key === 'Name')?.Value ?? instanceId;
          const subtitle = [inst?.InstanceType, display !== instanceId ? instanceId : undefined].filter(Boolean).join(' · ');
          const cpu =
            state === 'running'
              ? metric('cpu', 'CPU', 'percent', await cw.series({ namespace: NS, metricName: 'CPUUtilization', dimensions: { InstanceId: instanceId }, stat: 'Average' }), { warn: t.cpuWarnPct, crit: t.cpuCritPct, bad: 'high' })
              : placeholderMetric('cpu', 'CPU', 'percent', 'Not running');
          return item(instanceId, display, subtitle || undefined, text, health, [
            cpu,
            placeholderMetric('mem', 'RAM', 'percent', AGENT_NOTE),
            placeholderMetric('disk', 'Storage', 'percent', AGENT_NOTE),
          ]);
        }),
      );
      return buildGroup('ec2', 'EC2 instances', items);
    },
  };
}
