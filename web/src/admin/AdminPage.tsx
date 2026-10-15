import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { projectMonthly } from '../../../shared/cost';
import { DAYS } from '../../../shared/schedule';
import type { BackgroundMode, Day, DisplayScale, Settings, ThemePref } from '../../../shared/types';
import { ApiError, api, setCsrf } from '../api';
import { Check, Logo } from '../components/Icons';
import { WaveBackground } from '../components/WaveBackground';
import { usd } from '../format';
import { useCardOpacity } from '../hooks/misc';
import { useTheme } from '../hooks/useTheme';

interface Me {
  configured: boolean;
  signedIn: boolean;
  user?: string;
  csrfToken?: string;
}

/** Text drafts for numeric fields, so users can type freely and we validate on save. */
interface Draft {
  timezone: string;
  workingDays: Day[];
  workingStart: string;
  workingEnd: string;
  workingIntervalMin: string;
  offHoursIntervalMin: string;
  escEnabled: boolean;
  escIntervalMin: string;
  cooldownSec: string;
  dailyCap: string;
  cpuWarnPct: string;
  cpuCritPct: string;
  memWarnPct: string;
  memCritPct: string;
  iterWarnSec: string;
  iterCritSec: string;
  defaultTheme: ThemePref;
  pixelShift: boolean;
  showCostByDefault: boolean;
  background: BackgroundMode;
  backgroundIntensity: 'subtle' | 'medium';
  statusAmbience: boolean;
  displayScale: DisplayScale;
  kioskShowRefresh: boolean;
  cardOpacity: string;
  notificationsEnabled: boolean;
}

const toDraft = (s: Settings): Draft => ({
  timezone: s.schedule.timezone,
  workingDays: s.schedule.workingDays,
  workingStart: s.schedule.workingStart,
  workingEnd: s.schedule.workingEnd,
  workingIntervalMin: String(s.schedule.workingIntervalMin),
  offHoursIntervalMin: String(s.schedule.offHoursIntervalMin),
  escEnabled: s.escalation.enabled,
  escIntervalMin: String(s.escalation.intervalMin),
  cooldownSec: String(s.manualRefresh.cooldownSec),
  dailyCap: String(s.manualRefresh.dailyCap),
  cpuWarnPct: String(s.thresholds.cpuWarnPct),
  cpuCritPct: String(s.thresholds.cpuCritPct),
  memWarnPct: String(s.thresholds.memWarnPct),
  memCritPct: String(s.thresholds.memCritPct),
  iterWarnSec: String(s.thresholds.iteratorAgeWarnMs / 1000),
  iterCritSec: String(s.thresholds.iteratorAgeCritMs / 1000),
  defaultTheme: s.ui.defaultTheme,
  pixelShift: s.ui.pixelShift,
  showCostByDefault: s.ui.showCostByDefault,
  background: s.ui.background,
  backgroundIntensity: s.ui.backgroundIntensity,
  statusAmbience: s.ui.statusAmbience,
  displayScale: s.ui.displayScale,
  kioskShowRefresh: s.ui.kioskShowRefresh,
  cardOpacity: String(s.ui.cardOpacity),
  notificationsEnabled: s.notifications.enabled,
});

const num = (s: string): number => (/^\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : Number.NaN);

function fromDraft(d: Draft): { settings?: Settings; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const n = (field: keyof Draft, path: string, label: string, opts: { int?: boolean } = {}) => {
    const v = num(String(d[field]));
    if (Number.isNaN(v)) errors[path] = `${label} must be a number`;
    else if (opts.int && !Number.isInteger(v)) errors[path] = 'Whole numbers only';
    return v;
  };
  const settings: Settings = {
    schedule: {
      timezone: d.timezone.trim() || 'local',
      workingDays: d.workingDays,
      workingStart: d.workingStart,
      workingEnd: d.workingEnd,
      workingIntervalMin: n('workingIntervalMin', 'schedule.workingIntervalMin', 'Interval', { int: true }),
      offHoursIntervalMin: n('offHoursIntervalMin', 'schedule.offHoursIntervalMin', 'Interval', { int: true }),
    },
    escalation: { enabled: d.escEnabled, intervalMin: n('escIntervalMin', 'escalation.intervalMin', 'Interval', { int: true }) },
    manualRefresh: { cooldownSec: n('cooldownSec', 'manualRefresh.cooldownSec', 'Cooldown', { int: true }), dailyCap: n('dailyCap', 'manualRefresh.dailyCap', 'Cap', { int: true }) },
    thresholds: {
      cpuWarnPct: n('cpuWarnPct', 'thresholds.cpuWarnPct', 'Value'),
      cpuCritPct: n('cpuCritPct', 'thresholds.cpuCritPct', 'Value'),
      memWarnPct: n('memWarnPct', 'thresholds.memWarnPct', 'Value'),
      memCritPct: n('memCritPct', 'thresholds.memCritPct', 'Value'),
      iteratorAgeWarnMs: Math.round(n('iterWarnSec', 'thresholds.iteratorAgeWarnMs', 'Value') * 1000),
      iteratorAgeCritMs: Math.round(n('iterCritSec', 'thresholds.iteratorAgeCritMs', 'Value') * 1000),
    },
    ui: {
      defaultTheme: d.defaultTheme,
      pixelShift: d.pixelShift,
      showCostByDefault: d.showCostByDefault,
      background: d.background,
      backgroundIntensity: d.backgroundIntensity,
      statusAmbience: d.statusAmbience,
      displayScale: d.displayScale,
      kioskShowRefresh: d.kioskShowRefresh,
      cardOpacity: n('cardOpacity', 'ui.cardOpacity', 'Opacity', { int: true }),
    },
    notifications: { enabled: d.notificationsEnabled },
  };
  return Object.keys(errors).length ? { errors } : { settings, errors };
}

function Field({ label, hint, error, children, suffix }: { label: string; hint?: string; error?: string; children: ReactNode; suffix?: string }) {
  return (
    <label className={`field${error ? ' field-error' : ''}`}>
      <span className="field-label">{label}</span>
      <span className="field-control">
        {children}
        {suffix && <span className="field-suffix">{suffix}</span>}
      </span>
      {error ? <span className="field-msg">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className={`switch-row${disabled ? ' is-disabled' : ''}`}>
      <div>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      <button type="button" role="switch" aria-checked={checked} className={`switch${checked ? ' is-on' : ''}`} onClick={() => !disabled && onChange(!checked)} disabled={disabled}>
        <i />
      </button>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {desc && <p className="panel-desc">{desc}</p>}
      <div className="panel-grid">{children}</div>
    </section>
  );
}

export function AdminPage() {
  const { theme } = useTheme(undefined);
  const [me, setMe] = useState<Me | null>(null);

  const loadMe = useCallback(async () => {
    const m = await api<Me>('/api/admin/me');
    setCsrf(m.csrfToken ?? '');
    setMe(m);
  }, []);
  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  return (
    <div className="app admin">
      <div className="vignette" aria-hidden />
      <WaveBackground mode="waves" intensity="subtle" />
      <div className="admin-shell">
        <header className="admin-top">
          <a className="brand" href="/">
            <span className="logo">
              <Logo width={22} height={22} />
            </span>
            <div>
              <b>AWS Monitor</b>
              <small>Admin · {theme} theme</small>
            </div>
          </a>
          <div className="topbar-right">
            {me?.signedIn && (
              <button
                className="btn"
                onClick={async () => {
                  await api('/api/admin/logout', { method: 'POST' });
                  setCsrf('');
                  await loadMe();
                }}
              >
                Sign out
              </button>
            )}
            <a className="btn" href="/">
              ← Dashboard
            </a>
          </div>
        </header>
        {!me ? <div className="skeleton admin-skeleton" /> : !me.configured ? <NotConfigured /> : !me.signedIn ? <Login onDone={loadMe} /> : <Editor />}
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <section className="panel narrow">
      <h3>Admin is not configured</h3>
      <p className="panel-desc">Set an admin password hash and session secret to enable this page. From the project folder run:</p>
      <pre className="code">npm run init-config</pre>
      <p className="panel-desc">or provide <code>MONITOR_ADMIN_PASSWORD_HASH</code> and <code>MONITOR_SESSION_SECRET</code> as environment variables.</p>
    </section>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/login', { method: 'POST', body: { username, password } });
      // Only same-site paths: never an absolute or protocol-relative URL (open-redirect guard).
      const next = new URLSearchParams(location.search).get('next');
      if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
        location.assign(next);
        return;
      }
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel narrow login" onSubmit={submit}>
      <h3>Sign in</h3>
      <p className="panel-desc">Administrator access is required to change polling and display settings.</p>
      <Field label="Username">
        <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label="Password">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="btn btn-primary" disabled={busy || !username || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

function Editor() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [metricsPerPoll, setMetricsPerPoll] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    void api<{ settings: Settings; metricsPerPoll: number }>('/api/admin/settings').then((r) => {
      setDraft(toDraft(r.settings));
      setMetricsPerPoll(r.metricsPerPoll);
    });
  }, []);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    setSaved('idle');
  };

  const parsed = useMemo(() => (draft ? fromDraft(draft) : null), [draft]);
  const previewOpacity = draft && /^\d+$/.test(draft.cardOpacity) ? Number(draft.cardOpacity) : undefined;
  useCardOpacity(previewOpacity);
  const projection = useMemo(() => {
    const s = parsed?.settings?.schedule;
    if (!s || !Number.isInteger(s.workingIntervalMin) || !Number.isInteger(s.offHoursIntervalMin) || s.workingIntervalMin < 1 || s.offHoursIntervalMin < 1) return null;
    return projectMonthly(s, metricsPerPoll, new Date());
  }, [parsed, metricsPerPoll]);

  if (!draft || !parsed) return <div className="skeleton admin-skeleton" />;

  const err = (k: string) => errors[k];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!parsed.settings) {
      setErrors(parsed.errors);
      return;
    }
    setSaved('saving');
    try {
      const r = await api<{ settings: Settings }>('/api/admin/settings', { method: 'PUT', body: parsed.settings });
      setDraft(toDraft(r.settings));
      setErrors({});
      setSaved('saved');
    } catch (ex) {
      setSaved('idle');
      if (ex instanceof ApiError && ex.issues) {
        setErrors(Object.fromEntries(ex.issues.map((i) => [i.path, i.message])));
        setFormError('Some values need attention.');
      } else setFormError((ex as Error).message);
    }
  };

  const cheap = projection && projection.usd < 1;
  return (
    <form className="admin-grid" onSubmit={save}>
      <div className="admin-col">
        <Section title="Polling schedule" desc="Working hours poll more often; everything outside the window (including weekends) is treated as off hours automatically.">
          <Field label="Working hours: poll every" suffix="min" error={err('schedule.workingIntervalMin')} hint="Any whole number of minutes, e.g. 10 or 15.">
            <input inputMode="numeric" value={draft.workingIntervalMin} onChange={(e) => set('workingIntervalMin', e.target.value)} />
          </Field>
          <Field label="Off hours: poll every" suffix="min" error={err('schedule.offHoursIntervalMin')} hint="60 = once an hour.">
            <input inputMode="numeric" value={draft.offHoursIntervalMin} onChange={(e) => set('offHoursIntervalMin', e.target.value)} />
          </Field>
          <Field label="Working hours start" error={err('schedule.workingStart')}>
            <input type="time" value={draft.workingStart} onChange={(e) => set('workingStart', e.target.value)} />
          </Field>
          <Field label="Working hours end" error={err('schedule.workingEnd')}>
            <input type="time" value={draft.workingEnd} onChange={(e) => set('workingEnd', e.target.value)} />
          </Field>
          <div className="span-2">
            <span className="field-label">Working days</span>
            <div className="day-chips">
              {DAYS.map((day) => {
                const on = draft.workingDays.includes(day);
                return (
                  <button key={day} type="button" className={`chip chip-day${on ? ' chip-on' : ''}`} aria-pressed={on} onClick={() => set('workingDays', on ? draft.workingDays.filter((x) => x !== day) : [...draft.workingDays, day])}>
                    {on && <Check width={12} height={12} strokeWidth={3} />}
                    {day}
                  </button>
                );
              })}
            </div>
          </div>
          <Field label="Time zone" error={err('schedule.timezone')} hint='"local" uses this PC, or an IANA name like Asia/Kolkata.'>
            <input value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </Field>
        </Section>

        <Section title="Adaptive escalation" desc="When something is unhealthy, poll faster until it recovers. Never slows polling down.">
          <div className="span-2">
            <Switch checked={draft.escEnabled} onChange={(v) => set('escEnabled', v)} label="Enable escalation" hint="Off by default." />
          </div>
          <Field label="Escalated interval" suffix="min" error={err('escalation.intervalMin')}>
            <input inputMode="numeric" value={draft.escIntervalMin} onChange={(e) => set('escIntervalMin', e.target.value)} disabled={!draft.escEnabled} />
          </Field>
        </Section>

        <Section title="Manual refresh limits" desc="Guards against accidental cost from repeated Refresh clicks.">
          <Field label="Cooldown" suffix="sec" error={err('manualRefresh.cooldownSec')}>
            <input inputMode="numeric" value={draft.cooldownSec} onChange={(e) => set('cooldownSec', e.target.value)} />
          </Field>
          <Field label="Daily cap" suffix="per day" error={err('manualRefresh.dailyCap')}>
            <input inputMode="numeric" value={draft.dailyCap} onChange={(e) => set('dailyCap', e.target.value)} />
          </Field>
        </Section>
      </div>

      <div className="admin-col">
        <section className={`panel cost-panel${cheap ? '' : ' cost-panel-warn'}`}>
          <h3>Estimated cost of this schedule</h3>
          {projection ? (
            <>
              <div className="cost-big">
                {usd(projection.usd)}
                <span>/ month</span>
              </div>
              <p className="panel-desc">
                {projection.pollsPerMonth.toLocaleString()} polls × {metricsPerPoll || '–'} metrics ≈ {projection.metricsPerMonth.toLocaleString()} metrics requested (CloudWatch GetMetricData, $0.01 per 1,000). Describe/List calls are free. Escalated polls are extra.
              </p>
              {draft.workingIntervalMin !== '' && Number(draft.workingIntervalMin) < 5 && <p className="form-error">Intervals under 5 minutes raise cost noticeably.</p>}
            </>
          ) : (
            <p className="panel-desc">Enter valid intervals to see an estimate.</p>
          )}
        </section>

        <Section title="Thresholds" desc="Warn and critical levels used to colour tiles and charts.">
          <Field label="CPU warn" suffix="%" error={err('thresholds.cpuWarnPct')}>
            <input inputMode="decimal" value={draft.cpuWarnPct} onChange={(e) => set('cpuWarnPct', e.target.value)} />
          </Field>
          <Field label="CPU critical" suffix="%" error={err('thresholds.cpuCritPct')}>
            <input inputMode="decimal" value={draft.cpuCritPct} onChange={(e) => set('cpuCritPct', e.target.value)} />
          </Field>
          <Field label="Memory warn" suffix="%" error={err('thresholds.memWarnPct')}>
            <input inputMode="decimal" value={draft.memWarnPct} onChange={(e) => set('memWarnPct', e.target.value)} />
          </Field>
          <Field label="Memory critical" suffix="%" error={err('thresholds.memCritPct')}>
            <input inputMode="decimal" value={draft.memCritPct} onChange={(e) => set('memCritPct', e.target.value)} />
          </Field>
          <Field label="Kinesis iterator age warn" suffix="sec" error={err('thresholds.iteratorAgeWarnMs')}>
            <input inputMode="decimal" value={draft.iterWarnSec} onChange={(e) => set('iterWarnSec', e.target.value)} />
          </Field>
          <Field label="Kinesis iterator age critical" suffix="sec" error={err('thresholds.iteratorAgeCritMs')}>
            <input inputMode="decimal" value={draft.iterCritSec} onChange={(e) => set('iterCritSec', e.target.value)} />
          </Field>
        </Section>

        <Section title="Display" desc="Applies to every display, including the kiosk.">
          <Field label="Default theme">
            <select value={draft.defaultTheme} onChange={(e) => set('defaultTheme', e.target.value as ThemePref)}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="auto">Match system</option>
            </select>
          </Field>
          <Field label="Display scale" hint="Enlarges everything for viewing from a distance.">
            <select value={draft.displayScale} onChange={(e) => set('displayScale', e.target.value as DisplayScale)}>
              <option value="desk">Desk (100%)</option>
              <option value="wall">Wall (118%)</option>
              <option value="tv">TV (140%)</option>
            </select>
          </Field>
          <Field label="Background">
            <select value={draft.background} onChange={(e) => set('background', e.target.value as BackgroundMode)}>
              <option value="waves">Moving waves</option>
              <option value="static">Still waves</option>
              <option value="off">Off</option>
            </select>
          </Field>
          <Field label="Wave intensity">
            <select value={draft.backgroundIntensity} onChange={(e) => set('backgroundIntensity', e.target.value as 'subtle' | 'medium')} disabled={draft.background === 'off'}>
              <option value="subtle">Subtle</option>
              <option value="medium">Medium</option>
            </select>
          </Field>
          <div className="span-2 opacity-field">
            <Field label="Card opacity" suffix="%" error={err('ui.cardOpacity')} hint="Lower values let the background ribbon show through the cards. Previewed live on this page.">
              <input inputMode="numeric" value={draft.cardOpacity} onChange={(e) => set('cardOpacity', e.target.value)} />
            </Field>
            <input
              type="range"
              min={50}
              max={100}
              step={1}
              aria-label="Card opacity"
              value={Number.isFinite(Number(draft.cardOpacity)) ? Number(draft.cardOpacity) : 88}
              onChange={(e) => set('cardOpacity', e.target.value)}
            />
          </div>
          <div className="span-2">
            <Switch checked={draft.statusAmbience} onChange={(v) => set('statusAmbience', v)} label="Status-aware waves" hint="While something is unhealthy, the waves warm faintly and move a little faster." disabled={draft.background === 'off'} />
            <Switch checked={draft.pixelShift} onChange={(v) => set('pixelShift', v)} label="Pixel shift" hint="Nudges the layout a few pixels every couple of minutes to reduce burn-in." />
            <Switch checked={draft.showCostByDefault} onChange={(v) => set('showCostByDefault', v)} label="Show dashboard cost by default" hint="Otherwise it is masked until you click the eye icon." />
            <Switch checked={draft.kioskShowRefresh} onChange={(v) => set('kioskShowRefresh', v)} label="Refresh button in kiosk mode" hint="Kiosk mode (?display=kiosk) hides layout, theme and admin controls." />
            <Switch checked={draft.notificationsEnabled} onChange={(v) => set('notificationsEnabled', v)} label="Notifications" hint="Coming soon: alerts via your email service." disabled />
          </div>
        </Section>

        <div className="save-bar">
          {formError && <span className="form-error">{formError}</span>}
          {saved === 'saved' && (
            <span className="saved">
              <Check width={14} height={14} strokeWidth={3} /> Saved and applied
            </span>
          )}
          <button className="btn btn-primary" disabled={saved === 'saving'}>
            {saved === 'saving' ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </form>
  );
}
