import { DescribeReplicationGroupsCommand } from '@aws-sdk/client-elasticache';
import type { Health, Item } from '../../../../shared/types.js';
import type { Config } from '../../config.js';
import { worst } from '../../health.js';
import { buildGroup, item, metric } from '../build.js';
import type { ServiceCollector } from '../types.js';

const PER = '5 min';
const NS = 'AWS/ElastiCache';

export interface RedisGroup {
  Status?: string;
  NodeGroups?: { NodeGroupId?: string; Status?: string; NodeGroupMembers?: { CacheClusterId?: string; CurrentRole?: string }[] }[];
}

/** Minimal slice of the SDK client, so tests can fake it. */
export interface ElastiCacheLike {
  send(cmd: DescribeReplicationGroupsCommand): Promise<{ ReplicationGroups?: RedisGroup[] }>;
}

export function redisStatusHealth(status: string | undefined): Health {
  if (status === 'available') return 'OK';
  return status === 'modifying' || status === 'snapshotting' ? 'WARN' : 'CRIT';
}

/** Redis is observed through the control plane and CloudWatch only; the cache itself is never connected to. */
export function redisCollector(cfg: Config, client: ElastiCacheLike): ServiceCollector {
  return {
    type: 'redis',
    title: 'ElastiCache Redis',
    iamActions: ['elasticache:DescribeReplicationGroups', 'cloudwatch:GetMetricStatistics'],
    async collect({ cw, settings }) {
      const t = settings.thresholds;
      const items: Item[] = [];
      for (const rg of cfg.resources.redis) {
        cw.countCall();
        const res = await client.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: rg.replicationGroupId })).catch((e: unknown) => {
          if ((e as Error).name === 'ReplicationGroupNotFoundFault') return { ReplicationGroups: [] };
          throw e;
        });
        const group = res.ReplicationGroups?.[0];
        const members = new Map<string, { shard?: string; role?: string; shardStatus?: string }>();
        for (const ng of group?.NodeGroups ?? []) {
          for (const m of ng.NodeGroupMembers ?? []) if (m.CacheClusterId) members.set(m.CacheClusterId, { shard: ng.NodeGroupId, role: m.CurrentRole, shardStatus: ng.Status });
        }
        const nodeItems = await Promise.all(
          rg.nodes.map(async (node) => {
            const dimensions = { CacheClusterId: node };
            const [cpu, mem, conns, evict] = await Promise.all([
              cw.series({ namespace: NS, metricName: 'EngineCPUUtilization', dimensions, stat: 'Average' }),
              cw.series({ namespace: NS, metricName: 'DatabaseMemoryUsagePercentage', dimensions, stat: 'Average' }),
              cw.series({ namespace: NS, metricName: 'CurrConnections', dimensions, stat: 'Average' }),
              cw.series({ namespace: NS, metricName: 'Evictions', dimensions, stat: 'Sum', fillZero: true }),
            ]);
            const m = members.get(node);
            const status = !group ? 'not found' : !m ? 'not in group' : (m.shardStatus ?? group.Status ?? 'unknown');
            const health = !group || !m ? 'CRIT' : worst([redisStatusHealth(group.Status), redisStatusHealth(m.shardStatus ?? group.Status)]);
            const subtitle = [m?.role, m?.shard ? `shard ${m.shard}` : undefined, rg.replicationGroupId].filter(Boolean).join(' · ');
            return item(node, node, subtitle, status, health, [
              metric('cpu', 'Engine CPU', 'percent', cpu, { warn: t.cpuWarnPct, crit: t.cpuCritPct, bad: 'high' }),
              metric('mem', 'Memory used', 'percent', mem, { warn: t.memWarnPct, crit: t.memCritPct, bad: 'high' }),
              metric('conns', 'Connections', 'count', conns),
              metric('evict', 'Evictions', 'count', evict, { warn: 1, crit: 100, bad: 'high', per: PER }),
            ]);
          }),
        );
        items.push(...nodeItems);
      }
      return buildGroup('redis', 'ElastiCache Redis', items);
    },
  };
}
