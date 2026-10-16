import type { GroupHistory, GroupType } from '../../shared/types.js';
import type { Collector } from './collectors/types.js';
import type { SettingsService } from './settings.js';
import type { UsageTracker } from './usage.js';

export const HISTORY_HOURS = 24;
const TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000; // a failing card must not hammer AWS on every open

export const GROUP_TYPES: readonly GroupType[] = ['ecs', 'aurora', 'lambda', 'kinesis', 'redis', 'ec2', 'alarms'];
export const isGroupType = (s: string): s is GroupType => (GROUP_TYPES as readonly string[]).includes(s);

/**
 * 24-hour series for one card, fetched when its detail view opens. Reuses the card's own collector, so only
 * configured resources can be read. Results are cached for a few minutes and shared between concurrent callers,
 * which keeps the extra CloudWatch requests small; they are added to the monthly usage so the cost widget stays honest.
 */
export class HistoryService {
  private readonly cache = new Map<GroupType, { at: number; value: GroupHistory }>();
  private readonly failed = new Map<GroupType, { at: number; error: Error }>();
  private readonly inflight = new Map<GroupType, Promise<GroupHistory>>();

  constructor(
    private readonly collector: Collector,
    private readonly settings: SettingsService,
    private readonly usage: UsageTracker,
    private readonly now: () => number = Date.now,
  ) {}

  get(type: GroupType): Promise<GroupHistory> {
    const hit = this.cache.get(type);
    if (hit && this.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
    const fail = this.failed.get(type);
    if (fail && this.now() - fail.at < FAIL_TTL_MS) return Promise.reject(fail.error);
    const pending = this.inflight.get(type);
    if (pending) return pending;
    const run = this.load(type)
      .catch((e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e));
        this.failed.set(type, { at: this.now(), error });
        throw error;
      })
      .finally(() => this.inflight.delete(type));
    this.inflight.set(type, run);
    return run;
  }

  private async load(type: GroupType): Promise<GroupHistory> {
    const now = this.now();
    const res = await this.collector.collectGroup(type, { now, settings: this.settings.get(), hours: HISTORY_HOURS });
    const g = res.groups[0];
    if (!g) throw new Error('No data for this card');
    if (g.error) throw new Error(g.error);
    if (res.live) this.usage.record(res.metricsRequested, res.apiCalls, false);
    const value: GroupHistory = { hours: HISTORY_HOURS, generatedAt: now, group: { ...g, lastSuccessAt: now } };
    this.cache.set(type, { at: now, value });
    this.failed.delete(type);
    return value;
  }
}
