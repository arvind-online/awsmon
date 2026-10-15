import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, Health, PollTrigger, Snapshot } from '../../shared/types.js';
import type { Collector } from './collectors/types.js';
import { type EventLog, diffHealth } from './events.js';
import { writeJsonAtomic } from './fsutil.js';
import { worst } from './health.js';
import type { Scheduler } from './scheduler/scheduler.js';
import type { SettingsService } from './settings.js';
import type { UsageTracker } from './usage.js';

type Events = { snapshot: [Snapshot]; refreshing: [PollTrigger] };

/** Runs one collection, assembles the snapshot, keeps the cache and persists the last one. */
export class Monitor extends EventEmitter<Events> {
  private current?: Snapshot;
  private metricsPerPoll = 0;
  private simulated = true;
  private scheduler?: Scheduler;
  private readonly file: string;

  constructor(
    private readonly collector: Collector,
    private readonly settings: SettingsService,
    private readonly usage: UsageTracker,
    private readonly events: EventLog,
    dataDir: string,
  ) {
    super();
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'last-snapshot.json');
    if (existsSync(this.file)) {
      try {
        const restored = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
        if (restored.version === 1 && Array.isArray(restored.groups)) {
          this.current = {
            ...restored,
            restored: true,
            groups: restored.groups.map((g) => ({ ...g, lastSuccessAt: g.lastSuccessAt ?? restored.generatedAt })),
            events: this.events.recent(),
          };
          this.metricsPerPoll = restored.poll.metricsRequested;
          this.simulated = restored.cost?.simulated ?? true;
        }
      } catch {
        /* ignore corrupt cache */
      }
    }
  }

  attach(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  snapshot(): Snapshot | undefined {
    return this.current;
  }

  /** When the cached data was last fully successful, if it is usable as a starting point. */
  lastGoodAt(): number | undefined {
    const s = this.current;
    if (!s || s.poll.error || s.groups.some((g) => g.error)) return undefined;
    return s.generatedAt;
  }

  /** Re-publish the cached snapshot with a fresh schedule/cost view. Never touches AWS. */
  republish(): void {
    if (!this.current || !this.scheduler) return;
    const plan = this.scheduler.plan();
    this.current = {
      ...this.current,
      poll: { ...this.current.poll, intervalMin: plan.effectiveMin, window: plan.window, escalated: plan.escalated, nextDueAt: this.scheduler.nextDueAt() },
      cost: this.usage.cost(this.settings.get(), this.metricsPerPoll, this.simulated),
    };
    this.emit('snapshot', this.current);
  }

  async poll(trigger: PollTrigger): Promise<Health> {
    this.emit('refreshing', trigger);
    const started = Date.now();
    const settings = this.settings.get();
    const prevGroups = this.current?.groups ?? [];
    let groups: Group[] = prevGroups;
    let metricsRequested = 0;
    let error: string | undefined;
    try {
      const res = await this.collector.collect({ now: started, settings });
      groups = this.merge(prevGroups, res.groups, started);
      metricsRequested = res.metricsRequested;
      this.simulated = res.simulated;
      this.metricsPerPoll = res.metricsRequested;
      this.usage.record(res.metricsRequested, res.apiCalls);
    } catch (e) {
      error = (e as Error).message;
    }
    const finishedAt = Date.now();
    if (!error) this.events.add(diffHealth(prevGroups, groups, finishedAt));

    // The scheduler records lastPollAt after this resolves; compute nextDue as if the poll just finished.
    const plan = this.scheduler?.plan() ?? { window: 'working' as const, effectiveMin: settings.schedule.workingIntervalMin, escalated: false };
    const health = worst(groups.filter((g) => !g.disabled).map((g) => (g.error ? 'UNKNOWN' : g.health)));
    const overall: Health = error ? (groups.length ? worst([health, 'UNKNOWN']) : 'UNKNOWN') : health;
    this.current = {
      version: 1,
      generatedAt: error && this.current ? this.current.generatedAt : finishedAt,
      overall,
      poll: {
        trigger,
        durationMs: finishedAt - started,
        intervalMin: plan.effectiveMin,
        window: plan.window,
        escalated: plan.escalated,
        nextDueAt: finishedAt + plan.effectiveMin * 60_000,
        metricsRequested,
        error,
      },
      groups,
      cost: this.usage.cost(settings, this.metricsPerPoll, this.simulated),
      events: this.events.recent(),
    };
    this.persist();
    this.emit('snapshot', this.current);
    if (error) throw new Error(error);
    return overall;
  }

  /** A failed group keeps its previous items (shown as stale) instead of going blank. */
  private merge(prev: Group[], next: Awaited<ReturnType<Collector['collect']>>['groups'], now: number): Group[] {
    const byType = new Map(prev.map((g) => [g.type, g]));
    return next.map((g) => {
      const before = byType.get(g.type);
      if (!g.error) return { ...g, lastSuccessAt: now };
      return { ...g, items: before?.items ?? [], health: before?.health ?? 'UNKNOWN', lastSuccessAt: before?.lastSuccessAt ?? 0 };
    });
  }

  private persist(): void {
    if (!this.current) return;
    try {
      writeJsonAtomic(this.file, this.current);
    } catch (e) {
      console.warn('Could not persist snapshot:', (e as Error).message);
    }
  }
}
