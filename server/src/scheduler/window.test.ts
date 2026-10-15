import { describe, expect, it } from 'vitest';
import { isWorkingTime } from '../../../shared/schedule.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { planFor } from './scheduler.js';

const sched = { ...DEFAULT_SETTINGS.schedule, timezone: 'Asia/Kolkata' };
// Wed 2026-10-14 in IST
const ist = (hhmm: string, date = '2026-10-14') => Date.parse(`${date}T${hhmm}:00+05:30`);

describe('isWorkingTime', () => {
  it('is working inside Mon-Fri 09:00-18:00', () => {
    expect(isWorkingTime(ist('09:00'), sched)).toBe(true);
    expect(isWorkingTime(ist('17:59'), sched)).toBe(true);
  });
  it('is off at the end boundary and outside', () => {
    expect(isWorkingTime(ist('18:00'), sched)).toBe(false);
    expect(isWorkingTime(ist('08:59'), sched)).toBe(false);
  });
  it('treats weekends as non-working', () => {
    expect(isWorkingTime(ist('12:00', '2026-10-17'), sched)).toBe(false); // Saturday
  });
  it('honours the zone, not the process zone', () => {
    const utcNoon = Date.parse('2026-10-14T12:00:00Z'); // 17:30 IST
    expect(isWorkingTime(utcNoon, sched)).toBe(true);
    expect(isWorkingTime(utcNoon, { ...sched, timezone: 'America/New_York' })).toBe(false); // 08:00 EDT
  });
  it('supports windows that cross midnight', () => {
    const night = { ...sched, workingStart: '22:00', workingEnd: '06:00' };
    expect(isWorkingTime(ist('23:00'), night)).toBe(true); // Wed night
    expect(isWorkingTime(ist('05:00', '2026-10-15'), night)).toBe(true); // Thu early, belongs to Wed
    expect(isWorkingTime(ist('05:00', '2026-10-17'), night)).toBe(true); // Sat early, belongs to Fri
    expect(isWorkingTime(ist('05:00', '2026-10-18'), night)).toBe(false); // Sun early, belongs to Sat
  });
});

describe('planFor', () => {
  const s = { ...DEFAULT_SETTINGS, schedule: sched };
  it('uses defaults of 15 min working and 60 min off', () => {
    expect(planFor(ist('10:00'), s, false)).toMatchObject({ window: 'working', effectiveMin: 15 });
    expect(planFor(ist('22:00'), s, false)).toMatchObject({ window: 'off', effectiveMin: 60 });
  });
  it('escalation only tightens and only when enabled', () => {
    const on = { ...s, escalation: { enabled: true, intervalMin: 5 } };
    expect(planFor(ist('22:00'), on, true).effectiveMin).toBe(5);
    expect(planFor(ist('10:00'), { ...on, escalation: { enabled: true, intervalMin: 30 } }, true).effectiveMin).toBe(15);
    expect(planFor(ist('22:00'), s, true).effectiveMin).toBe(60);
  });
});
