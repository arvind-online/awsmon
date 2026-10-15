import { DescribeServicesCommand } from '@aws-sdk/client-ecs';
import type { Health, Item } from '../../../../shared/types.js';
import type { Config } from '../../config.js';
import { worst } from '../../health.js';
import { buildGroup, item, metric } from '../build.js';
import type { ServiceCollector } from '../types.js';

const NS = 'AWS/ECS';
const BATCH = 10; // DescribeServices accepts at most 10 services per call

export interface EcsService {
  serviceName?: string;
  status?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  deployments?: { status?: string; rolloutState?: string }[];
}

/** Minimal slice of the SDK client, so tests can fake it. */
export interface EcsLike {
  send(cmd: DescribeServicesCommand): Promise<{ services?: EcsService[]; failures?: { arn?: string; reason?: string }[] }>;
}

/** Status text and health for one service. Running below desired is CRIT; a rollout in progress is only WARN. */
export function serviceStatus(s: EcsService | undefined): { text: string; health: Health } {
  if (!s) return { text: 'not found', health: 'CRIT' };
  const desired = s.desiredCount ?? 0;
  const running = s.runningCount ?? 0;
  const base = `${running}/${desired} tasks running`;
  const rollout = s.deployments?.find((d) => d.status === 'PRIMARY')?.rolloutState;
  if (s.status === 'INACTIVE') return { text: 'inactive', health: 'CRIT' };
  if (s.status === 'DRAINING') return { text: 'draining', health: 'WARN' };
  if (rollout === 'FAILED') return { text: `${base}, deployment failed`, health: 'CRIT' };
  const hs: Health[] = [];
  const notes: string[] = [];
  if (running < desired) {
    hs.push('CRIT');
    if (s.pendingCount) notes.push(`${s.pendingCount} pending`);
  }
  if (rollout === 'IN_PROGRESS') {
    hs.push('WARN');
    notes.push('deploying');
  }
  return { text: notes.length ? `${base}, ${notes.join(', ')}` : base, health: worst(hs) };
}

export function ecsCollector(cfg: Config, client: EcsLike): ServiceCollector {
  return {
    type: 'ecs',
    title: 'ECS services',
    iamActions: ['ecs:DescribeServices', 'cloudwatch:GetMetricStatistics'],
    async collect({ cw, settings }) {
      const t = settings.thresholds;
      const items: Item[] = [];
      for (const { cluster, services } of cfg.resources.ecs) {
        const found = new Map<string, EcsService>();
        for (let i = 0; i < services.length; i += BATCH) {
          cw.countCall();
          const res = await client.send(new DescribeServicesCommand({ cluster, services: services.slice(i, i + BATCH) }));
          for (const s of res.services ?? []) if (s.serviceName) found.set(s.serviceName, s);
        }
        const clusterItems = await Promise.all(
          services.map(async (name) => {
            const dimensions = { ClusterName: cluster, ServiceName: name };
            const [cpu, mem] = await Promise.all([
              cw.series({ namespace: NS, metricName: 'CPUUtilization', dimensions, stat: 'Average' }),
              cw.series({ namespace: NS, metricName: 'MemoryUtilization', dimensions, stat: 'Average' }),
            ]);
            const st = serviceStatus(found.get(name));
            return item(`${cluster}/${name}`, name, `cluster ${cluster}`, st.text, st.health, [
              metric('cpu', 'CPU', 'percent', cpu, { warn: t.cpuWarnPct, crit: t.cpuCritPct, bad: 'high' }),
              metric('mem', 'Memory', 'percent', mem, { warn: t.memWarnPct, crit: t.memCritPct, bad: 'high' }),
            ]);
          }),
        );
        items.push(...clusterItems);
      }
      return buildGroup('ecs', 'ECS services', items);
    },
  };
}
