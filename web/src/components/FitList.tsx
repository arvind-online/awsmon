import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Health } from '../../../shared/types';
import { prefersReducedMotion, useFlip } from '../hooks/anim';
import { useSize } from '../hooks/misc';
import { Dot } from './StatusBadge';

const RANK: Record<Health, number> = { CRIT: 0, WARN: 1, UNKNOWN: 2, OK: 3 };
const ROTATE_MS = 10_000;
const HOLD_MS = 30_000; // after a manual page jump, auto-rotation waits this long
const PAGER_H = 22;

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
 * A list that never scrolls: rows share the available height and unhealthy items float to the top
 * (with a glide animation). When everything cannot fit, the healthy items rotate through pages while every
 * unhealthy item stays pinned on all pages, so a problem is never hidden. If the unhealthy items alone fill
 * the widget, the rest collapses into a "+N more" summary instead.
 */
export function FitList<T>({ items, keyOf, healthOf, render, minRow, maxRow = 84, gap = 6 }: Props<T>) {
  const [sizeRef, { h }] = useSize<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement | null>(null);
  useFlip(listRef);
  const [page, setPage] = useState(0);
  const [hover, setHover] = useState(false);
  const holdUntil = useRef(0);

  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => RANK[healthOf(a.it)] - RANK[healthOf(b.it)] || a.i - b.i)
    .map((x) => x.it);

  const capacity = h > 0 ? Math.max(1, Math.floor((h + gap) / (minRow + gap))) : sorted.length;
  const overflow = sorted.length > capacity;
  const pinned = sorted.filter((it) => healthOf(it) !== 'OK');
  const rest = sorted.filter((it) => healthOf(it) === 'OK');
  // One slot's worth of height goes to the page indicator, which is shorter than a row.
  const perPage = capacity - pinned.length - 1;
  const paged = overflow && perPage >= 1;
  const pages = paged ? Math.ceil(rest.length / perPage) : 1;
  // Even pages (3/3/3 rather than 4/4/1), and a constant row count so rows keep their height as pages turn.
  const size = paged ? Math.ceil(rest.length / pages) : 0;
  const current = Math.min(page, pages - 1);

  useEffect(() => {
    if (pages < 2 || hover || prefersReducedMotion()) return;
    const id = setInterval(() => {
      if (Date.now() >= holdUntil.current) setPage((p) => (p + 1) % pages);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [pages, hover]);

  let shown: T[];
  let hidden: T[] = [];
  let folded = false;
  if (paged) {
    shown = [...pinned, ...rest.slice(current * size, (current + 1) * size)];
  } else if (overflow) {
    folded = true;
    shown = sorted.slice(0, capacity - 1);
    hidden = sorted.slice(capacity - 1);
  } else {
    shown = sorted;
  }
  const extraSlots = paged ? 0 : folded ? 1 : 0;
  const rowCount = (paged ? pinned.length + size : shown.length) + extraSlots;
  const reserved = paged ? PAGER_H + gap : 0;
  const rowH = h > 0 && rowCount > 0 ? Math.min(maxRow, Math.max(minRow, (h - reserved - gap * (rowCount - 1)) / rowCount)) : undefined;
  const worstHidden = hidden.reduce<Health>((w, it) => (RANK[healthOf(it)] < RANK[w] ? healthOf(it) : w), 'OK');

  return (
    <div className="fit" ref={sizeRef} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
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
        {folded && (
          <div className="row row-more fit-item" data-flip="__more">
            <Dot health={worstHidden} />
            <span>
              +{hidden.length} more {worstHidden === 'OK' ? '· all healthy' : ''}
            </span>
            <small>{hidden.map(keyOf).join(', ')}</small>
          </div>
        )}
        {paged && pages > 1 && (
          <div className="pager" data-flip="__pager" style={{ height: PAGER_H }}>
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Page ${i + 1} of ${pages}`}
                aria-current={i === current}
                onClick={() => {
                  holdUntil.current = Date.now() + HOLD_MS;
                  setPage(i);
                }}
              />
            ))}
            <small>
              {current + 1}/{pages}
            </small>
          </div>
        )}
      </div>
    </div>
  );
}
