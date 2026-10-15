// Types shared by server and web. Import with `import type` only.

export type Health = 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN';
export type Unit = 'percent' | 'bytes' | 'count' | 'ms' | 'rate';
export type GroupType = 'ecs' | 'aurora' | 'lambda' | 'kinesis' | 'redis' | 'alarms';
export type Day = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export type PollTrigger = 'startup' | 'schedule' | 'manual' | 'escalation';
export type ThemePref = 'light' | 'dark' | 'auto';
export type BackgroundMode = 'waves' | 'static' | 'off';
export type DisplayScale = 'desk' | 'wall' | 'tv';
export type DataSource = 'live' | 'simulated';

export type Point = [ts: number, value: number];

export interface Metric {
  key: string;
  label: string;
  unit: Unit;
  latest: number | null;
  series: Point[];
  warn?: number;
  crit?: number;
  /** Which direction is bad. Used for threshold lines and colouring. */
  bad: 'high' | 'low' | 'none';
  health: Health;
  /** Aggregation window for summed metrics, e.g. "5 min" for "Invocations / 5 min". */
  per?: string;
}

export interface Item {
  id: string;
  name: string;
  subtitle?: string;
  health: Health;
  statusText: string;
  metrics: Metric[];
}

export interface Group {
  type: GroupType;
  title: string;
  health: Health;
  items: Item[];
  /** Shown instead of items when the group has nothing to display. */
  emptyNote?: string;
  /** Collector switched off in config (e.g. alarms before any exist). The UI hides its widget. */
  disabled?: boolean;
  /** Placeholder data from the simulated collector, shown while live mode has no real collector for this service yet. */
  simulated?: boolean;
  /** Last time this group's collector succeeded. Older than the poll implies its data is stale. */
  lastSuccessAt: number;
  /** Error from the most recent attempt; previous items are kept and shown as stale. */
  error?: string;
}

export interface HealthEvent {
  id: string;
  at: number;
  groupType: GroupType;
  /** Empty for group-level events such as a collector failing. */
  itemId: string;
  name: string;
  from: Health;
  to: Health;
  note?: string;
}

export interface LayoutCell {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CostInfo {
  actualMonthToDateUsd: number;
  projectedMonthlyUsd: number;
  metricsRequestedMonth: number;
  apiCallsMonth: number;
  pollsMonth: number;
  simulated: boolean;
}

export interface PollInfo {
  trigger: PollTrigger;
  durationMs: number;
  intervalMin: number;
  window: 'working' | 'off';
  escalated: boolean;
  nextDueAt: number;
  metricsRequested: number;
  error?: string;
}

export interface Snapshot {
  version: 1;
  generatedAt: number;
  /** True when loaded from disk after a restart and not yet refreshed. */
  restored?: boolean;
  overall: Health;
  poll: PollInfo;
  groups: Group[];
  cost: CostInfo;
  /** Most recent health transitions, newest first. */
  events: HealthEvent[];
}

export interface ScheduleSettings {
  timezone: string; // IANA zone or "local"
  workingDays: Day[];
  workingStart: string; // HH:MM
  workingEnd: string; // HH:MM
  workingIntervalMin: number;
  offHoursIntervalMin: number;
}

export interface Settings {
  /** Where data comes from. Simulated needs no AWS access; live reads CloudWatch (and Describe APIs) read-only. */
  dataSource: DataSource;
  schedule: ScheduleSettings;
  escalation: { enabled: boolean; intervalMin: number };
  manualRefresh: { cooldownSec: number; dailyCap: number };
  thresholds: {
    cpuWarnPct: number;
    cpuCritPct: number;
    memWarnPct: number;
    memCritPct: number;
    iteratorAgeWarnMs: number;
    iteratorAgeCritMs: number;
  };
  ui: {
    defaultTheme: ThemePref;
    pixelShift: boolean;
    showCostByDefault: boolean;
    background: BackgroundMode;
    backgroundIntensity: 'subtle' | 'medium';
    /** Faintly tint and quicken the waves while something is unhealthy. */
    statusAmbience: boolean;
    displayScale: DisplayScale;
    /** Show the Refresh button in kiosk display mode. */
    kioskShowRefresh: boolean;
    /** Card background opacity in percent (50-100). Lower lets the background ribbon show through. */
    cardOpacity: number;
  };
  notifications: { enabled: boolean };
}

/** The slice of settings the display is allowed to see. */
export interface PublicSettings {
  ui: Settings['ui'];
  manualRefresh: Settings['manualRefresh'];
  schedule: Pick<ScheduleSettings, 'workingIntervalMin' | 'offHoursIntervalMin'>;
}

export type ServerMessage =
  | { type: 'hello'; serverVersion: string; settings: PublicSettings }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'settings'; settings: PublicSettings }
  | { type: 'layout'; layout: LayoutCell[] | null }
  | { type: 'refreshing'; trigger: PollTrigger }
  | { type: 'refresh-denied'; reason: string; retryAfterSec: number }
  | { type: 'ping' };

export type ClientMessage = { type: 'refresh' } | { type: 'pong' };
