import { describe, expect, it } from 'vitest';
import { metricsToUsd, projectMonthly } from '../../shared/cost.js';
import { DEFAULT_SETTINGS } from './settings.js';

describe('cost projection', () => {
  it('prices GetMetricData at $0.01 per 1000 metrics', () => {
    expect(metricsToUsd(1000)).toBeCloseTo(0.01);
  });

  it('projects default schedule at well under a dollar for ~35 metrics', () => {
    // October 2026: 22 weekdays, 9 weekend days.
    const p = projectMonthly(DEFAULT_SETTINGS.schedule, 35, new Date(2026, 9, 14));
    // weekday: 36 working + 15 off = 51 polls; weekend: 24 polls
    expect(p.pollsPerMonth).toBe(22 * 51 + 9 * 24);
    expect(p.usd).toBeCloseTo((p.pollsPerMonth * 35 * 0.01) / 1000);
    expect(p.usd).toBeLessThan(1);
  });

  it('scales with a shorter interval', () => {
    const fast = projectMonthly({ ...DEFAULT_SETTINGS.schedule, workingIntervalMin: 5, offHoursIntervalMin: 5 }, 55, new Date(2026, 9, 14));
    expect(fast.usd).toBeGreaterThan(4);
  });
});
