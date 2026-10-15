import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import type { Health, Item, Metric } from '../../../../shared/types.js';
import type { Config } from '../../config.js';
import { buildGroup, item, metric } from '../build.js';
import type { ServiceCollector } from '../types.js';

const NS = 'AWS/RDS';
const GIB = 1024 ** 3;

export interface DbInstance {
  DBInstanceStatus?: string;
  DBInstanceClass?: string;
  Engine?: string;
  EngineVersion?: string;
}

/** Minimal slice of the SDK client, so tests can fake it. */
export interface RdsLike {
  send(cmd: DescribeDBInstancesCommand): Promise<{ DBInstances?: DbInstance[] }>;
}

/** Statuses that pass by themselves (backups, resizes, patching). Anything else that is not "available" needs a look. */
const TRANSIENT = new Set(['backing-up', 'modifying', 'configuring-enhanced-monitoring', 'configuring-log-exports', 'upgrading', 'rebooting', 'starting', 'storage-optimization', 'maintenance', 'renaming', 'resetting-master-credentials']);

export function dbHealth(status: string): Health {
  return status === 'available' ? 'OK' : TRANSIENT.has(status) ? 'WARN' : 'CRIT';
}

/** Memory used, from FreeableMemory and the instance's known RAM. Points with no data stay out. */
export function memoryUsedPct(freeable: Metric['series'], memoryGiB: number): Metric['series'] {
  return freeable.map(([t, v]) => [t, Math.min(100, Math.max(0, 100 - (v / (memoryGiB * GIB)) * 100))]);
}

/** Covers Aurora clusters and standalone RDS PostgreSQL instances; both report under AWS/RDS by instance id. */
export function auroraCollector(cfg: Config, client: RdsLike): ServiceCollector {
  return {
    type: 'aurora',
    title: 'PostgreSQL databases',
    iamActions: ['rds:DescribeDBInstances', 'cloudwatch:GetMetricStatistics'],
    async collect({ cw, settings }) {
      const t = settings.thresholds;
      const items: Item[] = [];
      for (const c of cfg.resources.aurora) {
        const clusterItems = await Promise.all(
          c.instances.map(async (inst) => {
            const dimensions = { DBInstanceIdentifier: inst.id };
            cw.countCall();
            const reader = inst.role === 'reader' && c.clusterId;
            const [desc, cpu, free, conns, lag] = await Promise.all([
              client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: inst.id })).catch((e: unknown) => {
                if ((e as Error).name === 'DBInstanceNotFoundFault') return { DBInstances: [] };
                throw e;
              }),
              cw.series({ namespace: NS, metricName: 'CPUUtilization', dimensions, stat: 'Average' }),
              cw.series({ namespace: NS, metricName: 'FreeableMemory', dimensions, stat: 'Average' }),
              cw.series({ namespace: NS, metricName: 'DatabaseConnections', dimensions, stat: 'Average' }),
              reader ? cw.series({ namespace: NS, metricName: 'AuroraReplicaLag', dimensions, stat: 'Average' }) : Promise.resolve(null),
            ]);
            const d = desc.DBInstances?.[0];
            const status = d ? (d.DBInstanceStatus ?? 'unknown') : 'not found';
            const parts = [
              inst.role === 'standalone' ? undefined : inst.role,
              d?.DBInstanceClass,
              d?.Engine && d.EngineVersion ? `${d.Engine} ${d.EngineVersion}` : d?.Engine,
              c.clusterId ? `cluster ${c.clusterId}` : undefined,
            ].filter(Boolean);
            const metrics = [metric('cpu', 'CPU', 'percent', cpu, { warn: t.cpuWarnPct, crit: t.cpuCritPct, bad: 'high' })];
            if (inst.memoryGiB) metrics.push(metric('mem', 'Memory used', 'percent', memoryUsedPct(free, inst.memoryGiB), { warn: t.memWarnPct, crit: t.memCritPct, bad: 'high' }));
            metrics.push(metric('conns', 'Connections', 'count', conns));
            if (lag) metrics.push(metric('lag', 'Replica lag', 'ms', lag, { warn: 500, crit: 2000, bad: 'high' }));
            return item(inst.id, inst.id, parts.join(' · ') || undefined, status, d ? dbHealth(status) : 'CRIT', metrics);
          }),
        );
        items.push(...clusterItems);
      }
      return buildGroup('aurora', 'PostgreSQL databases', items);
    },
  };
}
