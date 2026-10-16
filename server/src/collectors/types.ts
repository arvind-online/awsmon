import type { Group, Settings } from '../../../shared/types.js';

export interface CollectContext {
  now: number;
  settings: Settings;
  /** How much history each series covers, in hours (5-minute points). Defaults to 3; the detail view asks for 24. */
  hours?: number;
}

/** A group as produced by a collector. Monitor stamps lastSuccessAt and merges failures with previous data. */
export type CollectedGroup = Omit<Group, 'lastSuccessAt'>;

export interface CollectResult {
  groups: CollectedGroup[];
  /** True when the numbers above are real AWS calls. Simulated polls report what a live poll would cost, but must not be billed or recorded. */
  live: boolean;
  /** Metric requests made this poll (GetMetricStatistics: one per metric; the only billable call). */
  metricsRequested: number;
  /** Total API calls made (informational; Describe and List are free). */
  apiCalls: number;
  simulated: boolean;
}

export interface Collector {
  collect(ctx: CollectContext): Promise<CollectResult>;
  /** Collect a single group (used for the 24-hour detail view). The result holds just that group. */
  collectGroup(type: CollectedGroup['type'], ctx: CollectContext): Promise<CollectResult>;
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
