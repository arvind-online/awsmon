import { isWorkingTime } from '../../../shared/schedule.js';
import type { Health, PollTrigger, Settings } from '../../../shared/types.js';

export interface Plan {
  window: 'working' | 'off';
  baseMin: number;
  effectiveMin: number;
  escalated: boolean;
}

/** Pure: which interval applies at `now`. */
export function planFor(now: number, s: Settings, escalated: boolean): Plan {
  const working = isWorkingTime(now, s.schedule);
  const baseMin = working ? s.schedule.workingIntervalMin : s.schedule.offHoursIntervalMin;
  const effectiveMin = escalated && s.escalation.enabled ? Math.min(baseMin, s.escalation.intervalMin) : baseMin;
  return { window: working ? 'working' : 'off', baseMin, effectiveMin, escalated: escalated && s.escalation.enabled };
}

export type RefreshResult = { ok: true } | { ok: false; reason: string; retryAfterSec: number };

export interface SchedulerDeps {
  getSettings: () => Settings;
  /** Performs one collection. Resolves with overall health, rejects on failure. */
  poll: (trigger: PollTrigger) => Promise<Health>;
  now?: () => number;
  tickMs?: number;
  /** When the cached data was last fully refreshed. If still fresh, the startup poll is skipped. */
  initialLastPollAt?: number;
}

const OK_STREAK_TO_DEESCALATE = 2;

/**
 * Polls on a "next due" basis. Every tick compares time since the last poll with the interval for
 * the *current* window, so entering working hours (shorter interval) triggers a catch-up poll right away.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private lastPollAt = 0;
  private failures = 0;
  private escalated = false;
  private okStreak = 0;
  private manualDay = '';
  private manualCount = 0;
  private readonly now: () => number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Returns true if a startup poll was triggered. */
  start(): boolean {
    const initial = this.deps.initialLastPollAt;
    // Skip the startup poll when cached data is still within its interval. This keeps restarts
    // (crash loops, dev auto-reload, Windows reboots) from spending extra AWS calls.
    const fresh = initial !== undefined && this.now() - initial < planFor(this.now(), this.deps.getSettings(), false).effectiveMin * 60_000;
    if (fresh) this.lastPollAt = initial;
    else void this.run('startup');
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 10_000);
    this.timer.unref();
    return !fresh;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  plan(): Plan {
    return planFor(this.now(), this.deps.getSettings(), this.escalated);
  }

  nextDueAt(): number {
    if (this.lastPollAt === 0) return this.now();
    const interval = this.plan().effectiveMin * 60_000;
    const backoff = this.failures > 0 ? Math.min(interval, 30_000 * 2 ** (this.failures - 1)) : interval;
    return this.lastPollAt + backoff;
  }

  /** Single-flight manual refresh with cooldown and daily cap. */
  async refresh(): Promise<RefreshResult> {
    const s = this.deps.getSettings().manualRefresh;
    const now = this.now();
    if (this.inFlight) {
      await this.inFlight;
      return { ok: true };
    }
    const sinceSec = (now - this.lastPollAt) / 1000;
    if (this.lastPollAt && sinceSec < s.cooldownSec) {
      return { ok: false, reason: 'Data was refreshed moments ago', retryAfterSec: Math.ceil(s.cooldownSec - sinceSec) };
    }
    const day = new Date(now).toDateString();
    if (day !== this.manualDay) {
      this.manualDay = day;
      this.manualCount = 0;
    }
    if (this.manualCount >= s.dailyCap) {
      return { ok: false, reason: 'Daily manual refresh limit reached', retryAfterSec: 3600 };
    }
    this.manualCount++;
    await this.run('manual');
    return { ok: true };
  }

  private tick(): void {
    if (this.inFlight) return;
    if (this.now() >= this.nextDueAt()) void this.run(this.escalated ? 'escalation' : 'schedule');
  }

  private run(trigger: PollTrigger): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const overall = await this.deps.poll(trigger);
        this.failures = 0;
        this.updateEscalation(overall);
      } catch {
        this.failures++;
      } finally {
        this.lastPollAt = this.now();
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  private updateEscalation(overall: Health): void {
    if (!this.deps.getSettings().escalation.enabled) {
      this.escalated = false;
      this.okStreak = 0;
      return;
    }
    if (overall !== 'OK') {
      this.escalated = true;
      this.okStreak = 0;
    } else if (this.escalated && ++this.okStreak >= OK_STREAK_TO_DEESCALATE) {
      this.escalated = false;
      this.okStreak = 0;
    }
  }
}
