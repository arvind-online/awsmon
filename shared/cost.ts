import { DAYS, workingWindowMinutes } from './schedule.js';
import type { ScheduleSettings } from './types.js';

/** CloudWatch API pricing, shared by both metric APIs: $0.01 per 1,000. Describe and List calls of other services are free. */
export const PRICE_PER_1000_USD = 0.01;
/** GetMetricStatistics (what the live collectors use) gets 1,000,000 free requests per month, account-wide. */
export const FREE_TIER_REQUESTS = 1_000_000;

/** GetMetricData: every metric requested is billed (no free tier). Kept for the future `metricsApi: "data"` mode. */
export function metricsToUsd(metrics: number): number {
  return (metrics / 1000) * PRICE_PER_1000_USD;
}

/**
 * GetMetricStatistics: free up to the monthly allowance, then billed per request. The allowance is shared with everything
 * else in the account, which this app cannot see, so treat the result as an estimate of our own share.
 */
export function requestsToUsd(requests: number): number {
  return (Math.max(0, requests - FREE_TIER_REQUESTS) / 1000) * PRICE_PER_1000_USD;
}

/** Share of the monthly free allowance used by `requests`, in percent. */
export function freeTierPct(requests: number): number {
  return (requests / FREE_TIER_REQUESTS) * 100;
}

export interface Projection {
  pollsPerMonth: number;
  metricsPerMonth: number;
  usd: number;
  /** Projected share of the monthly free request allowance, in percent. */
  freeTierPct: number;
}

/**
 * Projected monthly cost for the current calendar month of `ref`, from the schedule alone.
 * Escalation is not included (it is bounded by how often things go unhealthy).
 */
export function projectMonthly(schedule: ScheduleSettings, metricsPerPoll: number, ref: Date): Projection {
  const year = ref.getFullYear();
  const month = ref.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const workMin = workingWindowMinutes(schedule);
  const workPollsPerWorkingDay = Math.floor(workMin / schedule.workingIntervalMin);
  const offMinOnWorkingDay = 1440 - workMin;
  const offPollsPerWorkingDay = Math.floor(offMinOnWorkingDay / schedule.offHoursIntervalMin);
  const offPollsPerNonWorkingDay = Math.floor(1440 / schedule.offHoursIntervalMin);

  let polls = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    // JS: 0 = Sunday. DAYS is Monday-first.
    const dow = DAYS[(new Date(year, month, d).getDay() + 6) % 7];
    polls += dow && schedule.workingDays.includes(dow)
      ? workPollsPerWorkingDay + offPollsPerWorkingDay
      : offPollsPerNonWorkingDay;
  }
  const metrics = polls * metricsPerPoll;
  return { pollsPerMonth: polls, metricsPerMonth: metrics, usd: requestsToUsd(metrics), freeTierPct: freeTierPct(metrics) };
}
