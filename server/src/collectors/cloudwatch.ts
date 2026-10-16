import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import type { Point } from '../../../shared/types.js';
import type { Config } from '../config.js';
import type { MetricQuery, MetricReader } from './types.js';

export const PERIOD_S = 300;
export const DEFAULT_HOURS = 3;
export const pointsFor = (hours: number) => Math.round((hours * 3600) / PERIOD_S);
const MAX_CONCURRENT = 6;

export function createCloudWatchClient(cfg: Config): CloudWatchClient {
  return new CloudWatchClient(awsClientConfig(cfg));
}

/** Shared settings for every read-only AWS client. */
export function awsClientConfig(cfg: Config) {
  return { region: cfg.aws.region, profile: cfg.aws.profile, maxAttempts: 3 };
}

/** Minimal slice of the SDK client, so tests can fake it. */
export interface CloudWatchLike {
  send(cmd: GetMetricStatisticsCommand): Promise<{ Datapoints?: { Timestamp?: Date; Sum?: number; Average?: number; Maximum?: number; Minimum?: number }[] }>;
}

/** GetMetricStatistics reader (free-tier eligible). One instance per poll; counts requests for the cost estimate. */
export class StatisticsReader implements MetricReader {
  requests = 0;
  otherCalls = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly client: CloudWatchLike,
    private readonly now: number,
    private readonly hours: number = DEFAULT_HOURS,
  ) {}

  countCall(n = 1): void {
    this.otherCalls += n;
  }

  async series(q: MetricQuery): Promise<Point[]> {
    await this.acquire();
    try {
      this.requests += 1;
      // End on the last completed 5-minute boundary so a half-filled bucket never shows as a dip.
      const stepMs = PERIOD_S * 1000;
      const end = Math.floor(this.now / stepMs) * stepMs;
      const start = end - pointsFor(this.hours) * stepMs;
      const res = await this.client.send(
        new GetMetricStatisticsCommand({
          Namespace: q.namespace,
          MetricName: q.metricName,
          Dimensions: Object.entries(q.dimensions).map(([Name, Value]) => ({ Name, Value })),
          StartTime: new Date(start),
          EndTime: new Date(end),
          Period: PERIOD_S,
          Statistics: [q.stat],
        }),
      );
      const byBucket = new Map<number, number>();
      for (const d of res.Datapoints ?? []) {
        const v = d[q.stat];
        if (d.Timestamp && typeof v === 'number') byBucket.set(Math.round(d.Timestamp.getTime() / stepMs) * stepMs, v);
      }
      const pts: Point[] = [];
      for (let t = start; t < end; t += stepMs) {
        const v = byBucket.get(t);
        if (v !== undefined) pts.push([t, v]);
        else if (q.fillZero) pts.push([t, 0]);
      }
      return pts;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}
