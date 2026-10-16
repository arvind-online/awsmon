import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './fsutil.js';
import { freeTierPct, projectMonthly, requestsToUsd } from '../../shared/cost.js';
import type { CostInfo, Settings } from '../../shared/types.js';

interface UsageFile {
  month: string; // YYYY-MM
  metricsRequested: number;
  apiCalls: number;
  polls: number;
}

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Counts real CloudWatch requests so the UI can show a month-to-date figure and a projection. Simulated polls are never recorded. */
export class UsageTracker {
  private usage: UsageFile;
  private readonly file: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = join(dataDir, 'usage.json');
    this.usage = { month: monthKey(new Date(this.now())), metricsRequested: 0, apiCalls: 0, polls: 0 };
    if (existsSync(this.file)) {
      try {
        const u = JSON.parse(readFileSync(this.file, 'utf8')) as UsageFile;
        if (u.month === this.usage.month) this.usage = u;
      } catch {
        /* start fresh */
      }
    }
  }

  /** `poll` is false for on-demand reads (the detail view), which cost requests but are not scheduled polls. */
  record(metricsRequested: number, apiCalls: number, poll = true): void {
    this.rollover();
    this.usage.metricsRequested += metricsRequested;
    this.usage.apiCalls += apiCalls;
    if (poll) this.usage.polls += 1;
    writeJsonAtomic(this.file, this.usage);
  }

  cost(settings: Settings, metricsPerPoll: number, simulated: boolean): CostInfo {
    this.rollover();
    const proj = projectMonthly(settings.schedule, metricsPerPoll, new Date(this.now()));
    return {
      actualMonthToDateUsd: requestsToUsd(this.usage.metricsRequested),
      projectedMonthlyUsd: proj.usd,
      freeTierUsedPct: freeTierPct(this.usage.metricsRequested),
      projectedFreeTierPct: proj.freeTierPct,
      metricsRequestedMonth: this.usage.metricsRequested,
      apiCallsMonth: this.usage.apiCalls,
      pollsMonth: this.usage.polls,
      simulated,
    };
  }

  private rollover(): void {
    const key = monthKey(new Date(this.now()));
    if (this.usage.month !== key) this.usage = { month: key, metricsRequested: 0, apiCalls: 0, polls: 0 };
  }
}
