import { describe, expect, it } from 'vitest';
import { FREE_TIER_REQUESTS, freeTierPct, metricsToUsd, projectMonthly, requestsToUsd } from '../../shared/cost.js';
import { DEFAULT_SETTINGS } from './settings.js';

describe('cost projection', () => {
  it('prices GetMetricData at $0.01 per 1000 metrics', () => {
    expect(metricsToUsd(1000)).toBeCloseTo(0.01);
  });

  it('GetMetricStatistics is free up to the monthly allowance, then $0.01 per 1000', () => {
    expect(requestsToUsd(0)).toBe(0);
    expect(requestsToUsd(FREE_TIER_REQUESTS)).toBe(0);
    expect(requestsToUsd(FREE_TIER_REQUESTS + 5000)).toBeCloseTo(0.05);
    expect(freeTierPct(250_000)).toBe(25);
  });

  it('projects default schedule at well under a dollar for ~35 metrics', () => {
    // October 2026: 22 weekdays, 9 weekend days.
    const p = projectMonthly(DEFAULT_SETTINGS.schedule, 35, new Date(2026, 9, 14));
    // weekday: 36 working + 15 off = 51 polls; weekend: 24 polls
    expect(p.pollsPerMonth).toBe(22 * 51 + 9 * 24);
    expect(p.usd).toBe(0); // 1,338 polls x 35 = ~47k requests, far inside the free allowance
    expect(p.freeTierPct).toBeCloseTo(((1338 * 35) / 1_000_000) * 100);
  });

  it('scales with a shorter interval', () => {
    const fast = projectMonthly({ ...DEFAULT_SETTINGS.schedule, workingIntervalMin: 5, offHoursIntervalMin: 5 }, 55, new Date(2026, 9, 14));
    expect(fast.freeTierPct).toBeGreaterThan(45); // 8,928 polls x 55 = ~491k requests
    expect(fast.usd).toBe(0);
    const faster = projectMonthly({ ...DEFAULT_SETTINGS.schedule, workingIntervalMin: 1, offHoursIntervalMin: 1 }, 130, new Date(2026, 9, 14));
    expect(faster.usd).toBeGreaterThan(0); // 44,640 polls x 130 = 5.8M requests
  });
});
