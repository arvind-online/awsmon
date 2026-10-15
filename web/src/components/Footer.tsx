import type { CostInfo, HealthEvent } from '../../../shared/types';
import { formatClock, HEALTH_LABEL, usd } from '../format';
import { Eye, EyeOff, Plus } from './Icons';
import { Dot } from './StatusBadge';

export function CostChip({ cost, shown, onToggle }: { cost: CostInfo | undefined; shown: boolean; onToggle: () => void }) {
  return (
    <button className={`cost${shown ? ' cost-open' : ''}`} onClick={onToggle} aria-pressed={shown} title={shown ? 'Hide cost' : 'Show estimated cost of running this dashboard'}>
      <span className="cost-label">Dashboard cost</span>
      {shown && cost ? (
        <span className="cost-vals">
          <span>
            <b>{usd(cost.actualMonthToDateUsd)}</b> this month so far
          </span>
          <span className="sep" />
          <span>
            <b>{usd(cost.projectedMonthlyUsd)}</b>/mo projected
          </span>
          <span className="sep" />
          <span title="Live collectors use GetMetricStatistics, which shares a free allowance of 1,000,000 requests a month across your whole AWS account. This is only this dashboard's share (estimate).">
            <b>{cost.projectedFreeTierPct < 1 ? '<1' : Math.round(cost.projectedFreeTierPct)}%</b> of free tier{cost.projectedFreeTierPct >= 100 ? ' (over)' : ''}
          </span>
          {cost.simulated && <em>simulated</em>}
        </span>
      ) : (
        <span className="cost-mask">$ ••••</span>
      )}
      {shown ? <EyeOff width={15} height={15} /> : <Eye width={15} height={15} />}
    </button>
  );
}

/** The latest health transitions, newest first. The same log will feed notifications later. */
export function RecentChanges({ events }: { events: HealthEvent[] }) {
  const recent = events.slice(0, 4);
  return (
    <div className="recent" aria-live="polite">
      <span className="recent-label">Recent changes</span>
      {recent.length === 0 ? (
        <span className="muted">None in the latest polls</span>
      ) : (
        recent.map((e) => (
          <span key={e.id} className={`event event-${e.to.toLowerCase()}`} title={`${new Date(e.at).toLocaleString()}${e.note ? ` · ${e.note}` : ''}`}>
            <time>{formatClock(e.at)}</time>
            <Dot health={e.to} />
            <b>{e.name}</b>
            <span className="muted">
              {HEALTH_LABEL[e.from]} → {HEALTH_LABEL[e.to]}
            </span>
          </span>
        ))
      )}
    </div>
  );
}

export function Footer({ children, hidden, onRestore, onRestoreAll }: { children: React.ReactNode; hidden: { id: string; title: string }[]; onRestore: (id: string) => void; onRestoreAll: () => void }) {
  return (
    <footer className="footbar">
      {children}
      <div className="hidden-tray">
        {hidden.length > 0 && <span className="hidden-label">Hidden</span>}
        {hidden.map((h) => (
          <button key={h.id} className="chip" onClick={() => onRestore(h.id)} title={`Show ${h.title}`}>
            <Plus width={13} height={13} />
            {h.title}
          </button>
        ))}
        {hidden.length > 1 && (
          <button className="chip chip-ghost" onClick={onRestoreAll}>
            Show all
          </button>
        )}
      </div>
    </footer>
  );
}
