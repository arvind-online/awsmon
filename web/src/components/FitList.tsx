import { type ReactNode, useRef } from 'react';
import type { Health } from '../../../shared/types';
import { useFlip } from '../hooks/anim';
import { useSize } from '../hooks/misc';
import { Dot } from './StatusBadge';

const RANK: Record<Health, number> = { CRIT: 0, WARN: 1, UNKNOWN: 2, OK: 3 };

interface Props<T> {
  items: T[];
  keyOf: (t: T) => string;
  healthOf: (t: T) => Health;
  render: (t: T) => ReactNode;
  /** Row height bounds in px: rows stretch to fill the widget between these. */
  minRow: number;
  maxRow?: number;
  gap?: number;
}

/**
 * A list that never scrolls: rows share the available height, unhealthy items float to the top
 * (with a glide animation), and anything that cannot fit collapses into a "+N more" summary. Because
 * the list is health-sorted, only the healthiest items are ever folded away.
 */
export function FitList<T>({ items, keyOf, healthOf, render, minRow, maxRow = 84, gap = 6 }: Props<T>) {
  const [sizeRef, { h }] = useSize<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement | null>(null);
  useFlip(listRef);

  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => RANK[healthOf(a.it)] - RANK[healthOf(b.it)] || a.i - b.i)
    .map((x) => x.it);

  const capacity = h > 0 ? Math.max(1, Math.floor((h + gap) / (minRow + gap))) : sorted.length;
  const overflow = sorted.length > capacity;
  const shown = overflow ? sorted.slice(0, capacity - 1) : sorted;
  const hidden = overflow ? sorted.slice(capacity - 1) : [];
  const slots = shown.length + (overflow ? 1 : 0);
  const rowH = h > 0 ? Math.min(maxRow, Math.max(minRow, (h - gap * (slots - 1)) / slots)) : undefined;
  const worstHidden = hidden.reduce<Health>((w, it) => (RANK[healthOf(it)] < RANK[w] ? healthOf(it) : w), 'OK');

  return (
    <div className="fit" ref={sizeRef}>
      <div
        className="rows"
        ref={listRef}
        style={{ gap, ...(rowH ? ({ '--row-h': `${rowH}px` } as React.CSSProperties) : {}) }}
      >
        {shown.map((it) => (
          <div key={keyOf(it)} data-flip={keyOf(it)} className="fit-item">
            {render(it)}
          </div>
        ))}
        {overflow && (
          <div className="row row-more fit-item" data-flip="__more">
            <Dot health={worstHidden} />
            <span>
              +{hidden.length} more {worstHidden === 'OK' ? '· all healthy' : ''}
            </span>
            <small>{hidden.map(keyOf).join(', ')}</small>
          </div>
        )}
      </div>
    </div>
  );
}
