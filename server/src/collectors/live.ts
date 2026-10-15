import type { CollectedGroup, CollectContext, CollectResult, Collector, ServiceCollector } from './types.js';
import { type CloudWatchLike, StatisticsReader } from './cloudwatch.js';

/** Short, single-line error text for the UI. SDK errors can be long and mention account details. */
export function describeError(e: unknown): string {
  const msg = e instanceof Error ? (e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message) : String(e);
  return msg.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Runs the real service collectors, isolating failures per collector (the monitor keeps the previous items and marks
 * the group stale). Groups without a real collector yet come from the fallback and are flagged as simulated.
 */
export class LiveCollector implements Collector {
  constructor(
    private readonly client: CloudWatchLike,
    private readonly services: ServiceCollector[],
    private readonly fallback: Collector,
  ) {}

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const cw = new StatisticsReader(this.client, ctx.now);
    const placeholders = await this.fallback.collect(ctx);
    const real = new Map<string, CollectedGroup>();
    await Promise.all(
      this.services.map(async (svc) => {
        try {
          real.set(svc.type, await svc.collect({ ...ctx, cw }));
        } catch (e) {
          real.set(svc.type, { type: svc.type, title: svc.title, items: [], health: 'UNKNOWN', error: describeError(e) });
        }
      }),
    );
    const groups = placeholders.groups.map((g) => real.get(g.type) ?? (g.disabled ? g : { ...g, simulated: true }));
    return {
      groups,
      metricsRequested: cw.requests,
      apiCalls: cw.requests,
      simulated: groups.some((g) => g.simulated),
    };
  }
}
