import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './fsutil.js';
import { z } from 'zod';
import { DAYS, parseHHMM } from '../../shared/schedule.js';
import type { PublicSettings, Settings } from '../../shared/types.js';

const hhmm = z.string().refine((s) => {
  try {
    parseHHMM(s);
    return true;
  } catch {
    return false;
  }
}, 'Use 24h HH:MM');

const minutes = z.number().int('Whole minutes only').min(1, 'At least 1 minute').max(1440, 'At most 1440 minutes (24h)');

const timezone = z.string().refine((tz) => {
  if (tz === 'local') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');

export const SettingsSchema = z
  .object({
    dataSource: z.enum(['live', 'simulated']),
    schedule: z.object({
      timezone,
      workingDays: z.array(z.enum(DAYS as [string, ...string[]])).max(7),
      workingStart: hhmm,
      workingEnd: hhmm,
      workingIntervalMin: minutes,
      offHoursIntervalMin: minutes,
    }),
    escalation: z.object({ enabled: z.boolean(), intervalMin: minutes }),
    manualRefresh: z.object({
      cooldownSec: z.number().int().min(10).max(3600),
      dailyCap: z.number().int().min(1).max(1000),
    }),
    thresholds: z.object({
      cpuWarnPct: z.number().min(1).max(100),
      cpuCritPct: z.number().min(1).max(100),
      memWarnPct: z.number().min(1).max(100),
      memCritPct: z.number().min(1).max(100),
      storageWarnPct: z.number().min(1).max(100),
      storageCritPct: z.number().min(1).max(100),
      iteratorAgeWarnMs: z.number().int().min(1000).max(86_400_000),
      iteratorAgeCritMs: z.number().int().min(1000).max(86_400_000),
    }),
    ui: z.object({
      defaultTheme: z.enum(['light', 'dark', 'auto']),
      pixelShift: z.boolean(),
      showCostByDefault: z.boolean(),
      background: z.enum(['waves', 'static', 'off']),
      backgroundIntensity: z.enum(['subtle', 'medium']),
      statusAmbience: z.boolean(),
      displayScale: z.enum(['desk', 'wall', 'tv']),
      kioskShowRefresh: z.boolean(),
      cardOpacity: z.number().int('Whole percent only').min(50, 'At least 50%').max(100, 'At most 100%'),
    }),
    notifications: z.object({ enabled: z.boolean() }),
  })
  .strict()
  .superRefine((s, ctx) => {
    const t = s.thresholds;
    if (t.cpuWarnPct >= t.cpuCritPct) ctx.addIssue({ code: 'custom', path: ['thresholds', 'cpuWarnPct'], message: 'Warn must be below critical' });
    if (t.memWarnPct >= t.memCritPct) ctx.addIssue({ code: 'custom', path: ['thresholds', 'memWarnPct'], message: 'Warn must be below critical' });
    if (t.storageWarnPct >= t.storageCritPct) ctx.addIssue({ code: 'custom', path: ['thresholds', 'storageWarnPct'], message: 'Warn must be below critical' });
    if (t.iteratorAgeWarnMs >= t.iteratorAgeCritMs) ctx.addIssue({ code: 'custom', path: ['thresholds', 'iteratorAgeWarnMs'], message: 'Warn must be below critical' });
    if (s.schedule.workingStart === s.schedule.workingEnd) ctx.addIssue({ code: 'custom', path: ['schedule', 'workingEnd'], message: 'Start and end must differ' });
  });

export const DEFAULT_SETTINGS: Settings = {
  dataSource: 'simulated',
  schedule: {
    timezone: 'local',
    workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    workingStart: '09:00',
    workingEnd: '18:00',
    workingIntervalMin: 15,
    offHoursIntervalMin: 60,
  },
  escalation: { enabled: false, intervalMin: 5 },
  manualRefresh: { cooldownSec: 60, dailyCap: 100 },
  thresholds: {
    cpuWarnPct: 70,
    cpuCritPct: 90,
    memWarnPct: 80,
    memCritPct: 90,
    storageWarnPct: 80,
    storageCritPct: 90,
    iteratorAgeWarnMs: 60_000,
    iteratorAgeCritMs: 300_000,
  },
  ui: {
    defaultTheme: 'dark',
    pixelShift: true,
    showCostByDefault: false,
    background: 'waves',
    backgroundIntensity: 'subtle',
    statusAmbience: false,
    displayScale: 'desk',
    kioskShowRefresh: true,
    cardOpacity: 88,
  },
  notifications: { enabled: false },
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

export function toPublic(s: Settings): PublicSettings {
  return {
    ui: s.ui,
    manualRefresh: s.manualRefresh,
    schedule: { workingIntervalMin: s.schedule.workingIntervalMin, offHoursIntervalMin: s.schedule.offHoursIntervalMin },
  };
}

/** Runtime-editable settings: defaults < config seed < data/settings.json (admin edits). */
export class SettingsService extends EventEmitter<{ change: [Settings] }> {
  private current: Settings;
  private readonly file: string;

  constructor(dataDir: string, seed: Record<string, unknown>) {
    super();
    this.file = join(dataDir, 'settings.json');
    mkdirSync(dataDir, { recursive: true });
    let merged = deepMerge(DEFAULT_SETTINGS, seed);
    if (existsSync(this.file)) {
      try {
        merged = deepMerge(merged, JSON.parse(readFileSync(this.file, 'utf8')));
      } catch (e) {
        console.warn('Ignoring unreadable settings file:', (e as Error).message);
      }
    }
    const parsed = SettingsSchema.safeParse(merged);
    if (!parsed.success) {
      console.warn('Stored settings invalid, falling back to defaults:', z.prettifyError(parsed.error));
      this.current = DEFAULT_SETTINGS;
    } else {
      this.current = parsed.data as Settings;
    }
  }

  get(): Settings {
    return this.current;
  }

  /** Validates and applies a full settings object. Throws ZodError on invalid input. */
  update(input: unknown): Settings {
    const next = SettingsSchema.parse(input) as Settings;
    this.current = next;
    writeJsonAtomic(this.file, next, true);
    this.emit('change', next);
    return next;
  }
}
