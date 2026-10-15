import { DescribeStreamSummaryCommand } from '@aws-sdk/client-kinesis';
import type { Health } from '../../../../shared/types.js';
import type { Config } from '../../config.js';
import { buildGroup, item, metric } from '../build.js';
import type { ServiceCollector } from '../types.js';

const PER = '5 min';
const NS = 'AWS/Kinesis';

/** Minimal slice of the SDK client, so tests can fake it. */
export interface KinesisLike {
  send(cmd: DescribeStreamSummaryCommand): Promise<{
    StreamDescriptionSummary?: { StreamStatus?: string; OpenShardCount?: number; StreamModeDetails?: { StreamMode?: string } };
  }>;
}

/** ACTIVE is healthy; UPDATING is a transient change; anything else (CREATING, DELETING, unknown) needs attention. */
export function streamHealth(status: string): Health {
  return status === 'ACTIVE' ? 'OK' : status === 'UPDATING' ? 'WARN' : 'CRIT';
}

export function kinesisCollector(cfg: Config, client: KinesisLike): ServiceCollector {
  return {
    type: 'kinesis',
    title: 'Kinesis',
    iamActions: ['kinesis:DescribeStreamSummary', 'cloudwatch:GetMetricStatistics'],
    async collect({ cw, settings }) {
      const t = settings.thresholds;
      const items = await Promise.all(
        cfg.resources.kinesis.map(async ({ stream }) => {
          const dimensions = { StreamName: stream };
          cw.countCall();
          const [summary, inc, out, age, thr] = await Promise.all([
            client.send(new DescribeStreamSummaryCommand({ StreamName: stream })),
            cw.series({ namespace: NS, metricName: 'IncomingRecords', dimensions, stat: 'Sum', fillZero: true }),
            cw.series({ namespace: NS, metricName: 'GetRecords.Records', dimensions, stat: 'Sum', fillZero: true }),
            cw.series({ namespace: NS, metricName: 'GetRecords.IteratorAgeMilliseconds', dimensions, stat: 'Maximum' }),
            cw.series({ namespace: NS, metricName: 'WriteProvisionedThroughputExceeded', dimensions, stat: 'Sum', fillZero: true }),
          ]);
          const d = summary.StreamDescriptionSummary;
          const status = d?.StreamStatus ?? 'UNKNOWN';
          const shards = d?.OpenShardCount;
          const mode = d?.StreamModeDetails?.StreamMode === 'ON_DEMAND' ? 'on-demand' : 'provisioned';
          return item(stream, stream, shards !== undefined ? `${mode} · ${shards} ${shards === 1 ? 'shard' : 'shards'}` : mode, status, streamHealth(status), [
            metric('in', 'Incoming', 'count', inc, { per: PER }),
            metric('out', 'Read', 'count', out, { per: PER }),
            metric('age', 'Iterator age', 'ms', age, { warn: t.iteratorAgeWarnMs, crit: t.iteratorAgeCritMs, bad: 'high' }),
            metric('thr', 'Write throttles', 'count', thr, { warn: 1, crit: 10, bad: 'high', per: PER }),
          ]);
        }),
      );
      return buildGroup('kinesis', 'Kinesis', items);
    },
  };
}
