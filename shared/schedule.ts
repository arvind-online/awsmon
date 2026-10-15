import type { Day, ScheduleSettings } from './types.js';

export const DAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function parseHHMM(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`Invalid time "${s}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const WEEKDAY_TO_DAY: Record<string, Day> = {
  Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri', Sat: 'Sat', Sun: 'Sun',
};

/** Weekday and minutes-since-midnight of an instant in the given zone ("local" = process zone). */
export function zonedParts(ts: number, timezone: string): { day: Day; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    ...(timezone === 'local' ? {} : { timeZone: timezone }),
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = WEEKDAY_TO_DAY[get('weekday')];
  if (!day) throw new Error('Could not resolve weekday');
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function previousDay(d: Day): Day {
  return DAYS[(DAYS.indexOf(d) + 6) % 7] as Day;
}

/** Working time = a working day inside [start, end). Windows that cross midnight belong to the day they start on. */
export function isWorkingTime(ts: number, s: ScheduleSettings): boolean {
  const start = parseHHMM(s.workingStart);
  const end = parseHHMM(s.workingEnd);
  const { day, minutes } = zonedParts(ts, s.timezone);
  if (start === end) return false;
  if (start < end) return s.workingDays.includes(day) && minutes >= start && minutes < end;
  if (minutes >= start) return s.workingDays.includes(day);
  if (minutes < end) return s.workingDays.includes(previousDay(day));
  return false;
}

/** Length of the working window in minutes (handles windows crossing midnight). */
export function workingWindowMinutes(s: Pick<ScheduleSettings, 'workingStart' | 'workingEnd'>): number {
  const start = parseHHMM(s.workingStart);
  const end = parseHHMM(s.workingEnd);
  if (start === end) return 0;
  return end > start ? end - start : 1440 - start + end;
}
