import type { Group, Settings } from '../../../shared/types.js';

export interface CollectContext {
  now: number;
  settings: Settings;
}

/** A group as produced by a collector. Monitor stamps lastSuccessAt and merges failures with previous data. */
export type CollectedGroup = Omit<Group, 'lastSuccessAt'>;

export interface CollectResult {
  groups: CollectedGroup[];
  /** Metrics requested from GetMetricData this poll (the only billable call). */
  metricsRequested: number;
  /** Total API calls made (informational; Describe and List are free). */
  apiCalls: number;
  simulated: boolean;
}

export interface Collector {
  collect(ctx: CollectContext): Promise<CollectResult>;
}

/** What a service collector may use. One instance per poll, so the counters are per poll. */
export interface ServiceContext extends CollectContext {
  cw: MetricReader;
}

export interface MetricQuery {
  namespace: string;
  metricName: string;
  dimensions: Record<string, string>;
  stat: 'Sum' | 'Average' | 'Maximum' | 'Minimum';
  /** Sum-type metrics have no datapoint when nothing happened; true fills those buckets with 0. */
  fillZero?: boolean;
}

/** The shared CloudWatch layer: bounded concurrency, usage counting, 5-minute points over the last 3 hours. */
export interface MetricReader {
  /** Count a non-metric AWS call (Describe/List are free) for the informational API-call total. */
  countCall(n?: number): void;
  series(q: MetricQuery): Promise<import('../../../shared/types.js').Point[]>;
}

/** A real (AWS-backed) collector for one dashboard group. Adding a service means adding one of these. */
export interface ServiceCollector {
  type: CollectedGroup['type'];
  title: string;
  /** IAM actions this collector needs, used to generate the least-privilege policy. */
  iamActions: string[];
  collect(ctx: ServiceContext): Promise<CollectedGroup>;
}
