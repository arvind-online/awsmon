import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Health } from '../../../shared/types.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { Scheduler } from './scheduler.js';

const settings = { ...DEFAULT_SETTINGS, schedule: { ...DEFAULT_SETTINGS.schedule, timezone: 'UTC' } };
const t0 = Date.parse('2026-10-14T10:00:00Z'); // Wednesday, working hours

function make(overrides: Partial<typeof settings> = {}, results: Health[] = ['OK'], initialLastPollAt?: number) {
  let now = t0;
  let i = 0;
  const poll = vi.fn(async () => results[Math.min(i++, results.length - 1)] as Health);
  const s = new Scheduler({ getSettings: () => ({ ...settings, ...overrides }), poll, now: () => now, tickMs: 1000, initialLastPollAt });
  return { s, poll, advance: (ms: number) => (now += ms), tick: () => (s as unknown as { tick(): void }).tick() };
}

afterEach(() => vi.useRealTimers());

describe('Scheduler', () => {
  it('polls when the interval for the current window has elapsed', async () => {
    const { s, poll, advance, tick } = make();
    await s.refresh(); // first poll
    expect(poll).toHaveBeenCalledTimes(1);
    advance(14 * 60_000);
    tick();
    expect(poll).toHaveBeenCalledTimes(1);
    advance(61_000);
    tick();
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('manual refresh respects the cooldown', async () => {
    const { s, poll, advance } = make();
    await s.refresh();
    const denied = await s.refresh();
    expect(denied).toMatchObject({ ok: false });
    expect(poll).toHaveBeenCalledTimes(1);
    advance(61_000);
    expect(await s.refresh()).toEqual({ ok: true });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('enforces the daily manual cap', async () => {
    const { s, advance } = make({ manualRefresh: { cooldownSec: 10, dailyCap: 2 } });
    await s.refresh();
    advance(11_000);
    await s.refresh();
    advance(11_000);
    await s.refresh();
    advance(11_000);
    expect(await s.refresh()).toMatchObject({ ok: false, reason: expect.stringContaining('Daily') });
  });

  it('collapses concurrent refreshes into one poll', async () => {
    const { s, poll } = make();
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('escalates when unhealthy (if enabled) and de-escalates after two OK polls', async () => {
    const { s, advance, tick } = make({ escalation: { enabled: true, intervalMin: 5 } }, ['CRIT', 'OK', 'OK']);
    await s.refresh();
    expect(s.plan()).toMatchObject({ escalated: true, effectiveMin: 5 });
    advance(5 * 60_000 + 1000);
    tick();
    await Promise.resolve();
    await Promise.resolve();
    advance(5 * 60_000 + 1000);
    tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.plan().escalated).toBe(false);
  });

  it('never escalates when disabled', async () => {
    const { s } = make({}, ['CRIT']);
    await s.refresh();
    expect(s.plan().escalated).toBe(false);
  });

  it('skips the startup poll when cached data is still fresh', () => {
    const { s, poll } = make({}, ['OK'], t0 - 5 * 60_000);
    expect(s.start()).toBe(false);
    s.stop();
    expect(poll).not.toHaveBeenCalled();
    expect(s.nextDueAt()).toBe(t0 + 10 * 60_000);
  });

  it('polls at startup when cached data is older than the interval', () => {
    const { s, poll } = make({}, ['OK'], t0 - 20 * 60_000);
    expect(s.start()).toBe(true);
    s.stop();
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
