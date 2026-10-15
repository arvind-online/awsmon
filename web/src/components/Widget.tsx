import type { ReactNode } from 'react';
import type { Health } from '../../../shared/types';
import { useChangeKey } from '../hooks/anim';
import { EyeOff, Grip } from './Icons';
import { StatusBadge } from './StatusBadge';

export interface WidgetProps {
  title: string;
  icon: ReactNode;
  health?: Health;
  meta?: ReactNode;
  /** Shown when this widget's collector failed and the data is the last known values. */
  stale?: string;
  /** This widget shows placeholder data because live mode has no real collector for it yet. */
  simulated?: boolean;
  editing: boolean;
  canHide: boolean;
  /** No title bar outside customize mode (the content speaks for itself); it reappears as the drag handle. */
  bare?: boolean;
  index: number;
  onHide: () => void;
  children: ReactNode;
}

/** Card frame shared by every dashboard component. The header is the drag handle in customize mode. */
export function Widget({ title, icon, health, meta, stale, simulated, editing, canHide, bare, index, onHide, children }: WidgetProps) {
  const changed = useChangeKey(health);
  return (
    <section className={`widget${editing ? ' widget-editing' : ''}${health ? ` widget-${health.toLowerCase()}` : ''}${stale ? ' widget-stale' : ''}`} style={{ '--i': index } as React.CSSProperties}>
      {changed > 0 && <i key={changed} className="widget-flash" aria-hidden />}
      <header className={`widget-head${bare && !editing ? ' widget-head-bare' : ''}`}>
        {editing && <Grip className="grip" width={16} height={16} />}
        <span className="widget-icon">{icon}</span>
        <h2>{title}</h2>
        {health && <StatusBadge health={health} />}
        {stale && (
          <span className="stale-pill" title={stale}>
            stale
          </span>
        )}
        {simulated && !stale && (
          <span className="stale-pill" title="No live collector for this service yet; showing simulated data">
            simulated
          </span>
        )}
        <span className="widget-meta">{meta}</span>
        {canHide && (
          <button className="icon-btn no-drag hide-btn" onClick={onHide} title={`Hide ${title} until next reload`} aria-label={`Hide ${title}`}>
            <EyeOff width={15} height={15} />
          </button>
        )}
      </header>
      <div className="widget-body">{children}</div>
    </section>
  );
}
