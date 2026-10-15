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
