import type { Health, Snapshot, ThemePref } from '../../../shared/types';
import { countdown, HEALTH_LABEL, relativeTime } from '../format';
import { useNow } from '../hooks/misc';
import type { Connection } from '../hooks/useMonitor';
import { Alert, Auto, Check, Cross, Gear, Layout, Logo, Moon, Question, Refresh, Sun, Wifi } from './Icons';

const THEME_ICON = { dark: Moon, light: Sun, auto: Auto } as const;
const STATUS_ICON = { OK: Check, WARN: Alert, CRIT: Cross, UNKNOWN: Question } as const;

interface Props {
  snapshot: Snapshot | null;
  connection: Connection;
  refreshing: boolean;
  theme: ThemePref;
  editing: boolean;
  kiosk: boolean;
  showRefresh: boolean;
  onRefresh: () => void;
  onTheme: () => void;
  onToggleEdit: () => void;
}

function Clock({ now }: { now: number }) {
  const d = new Date(now);
  return (
    <div className="clock" aria-label="Current time">
      <b>{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
      <small>{d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</small>
    </div>
  );
}

function Freshness({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const interval = Math.max(1, snapshot.poll.nextDueAt - snapshot.generatedAt);
  const frac = Math.min(1, Math.max(0, (now - snapshot.generatedAt) / interval));
  const stale = now - snapshot.generatedAt > 2 * snapshot.poll.intervalMin * 60_000 + 30_000;
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <div className={`fresh${stale ? ' fresh-stale' : ''}`} title={`Generated ${new Date(snapshot.generatedAt).toLocaleString()}`}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <circle cx="13" cy="13" r={r} className="fresh-track" />
        <circle cx="13" cy="13" r={r} className="fresh-arc" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 13 13)" />
      </svg>
      <div>
        <b>{stale ? 'Data is stale' : `Updated ${relativeTime(snapshot.generatedAt, now)}`}</b>
        <small>next in {countdown(snapshot.poll.nextDueAt, now)}</small>
      </div>
    </div>
  );
}

export function Header({ snapshot, connection, refreshing, theme, editing, kiosk, showRefresh, onRefresh, onTheme, onToggleEdit }: Props) {
  // The once-a-second tick lives here so the rest of the dashboard doesn't re-render every second.
  const now = useNow(1000);
  const overall: Health = snapshot?.overall ?? 'UNKNOWN';
  const Icon = STATUS_ICON[overall];
  const ThemeIcon = THEME_ICON[theme];
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand">
          <span className="logo">
            <Logo width={22} height={22} />
          </span>
          <div>
            <b>AWS Monitor</b>
            <small>{snapshot?.cost.simulated ? 'Simulated data' : 'Live metrics'}</small>
          </div>
        </div>
        <div className={`overall overall-${overall.toLowerCase()}`}>
          <Icon width={15} height={15} strokeWidth={2.4} />
          <span>{snapshot ? HEALTH_LABEL[overall] : 'Connecting'}</span>
        </div>
      </div>

      <Clock now={now} />

      <div className="topbar-right">
        {connection !== 'open' && (
          <div className="conn" role="status">
            <Wifi width={15} height={15} />
            {connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </div>
        )}
        {snapshot && <Freshness snapshot={snapshot} now={now} />}
        {showRefresh && (
          <button className={`btn btn-primary${refreshing ? ' is-busy' : ''}`} onClick={onRefresh} disabled={refreshing || connection !== 'open'} title="Fetch the latest data now (rate-limited)">
            <Refresh className="spin-on-busy" width={16} height={16} />
            <span>{refreshing ? 'Refreshing' : 'Refresh'}</span>
          </button>
        )}
        {!kiosk && (
          <>
            <button className={`icon-btn${editing ? ' is-on' : ''}`} onClick={onToggleEdit} title="Customize layout" aria-pressed={editing} aria-label="Customize layout">
              <Layout />
            </button>
            <button className="icon-btn" onClick={onTheme} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}>
              <ThemeIcon />
            </button>
            <a className="icon-btn" href="/admin" title="Admin settings" aria-label="Admin settings">
              <Gear />
            </a>
          </>
        )}
      </div>
    </header>
  );
}
