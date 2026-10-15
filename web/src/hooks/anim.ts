import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Point } from '../../../shared/types';

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (p: number) => 1 - (1 - p) ** 3;

export type Domain = [number, number];

function domainOf(series: Point[][]): Domain {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of series) {
    if (s.length === 0) continue;
    t0 = Math.min(t0, s[0]![0]);
    t1 = Math.max(t1, s.at(-1)![0]);
  }
  return Number.isFinite(t0) ? [t0, t1] : [0, 1];
}

/**
 * Morphs time series from the previous snapshot to the next one. Points are matched by timestamp:
 * shared points ease to their new value, new points grow from the last known value, and points that
 * fell out of the window slide off to the left as the time domain moves. Charts clip to the plot area.
 */
export function useMorph(series: Point[][], ms = 800): { frame: Point[][]; domain: Domain } {
  const [state, setState] = useState(() => ({ frame: series, domain: domainOf(series) }));
  const shown = useRef(state);

  useEffect(() => {
    const target = { frame: series, domain: domainOf(series) };
    const from = shown.current;
    const hasPrev = from.frame.some((s) => s.length > 0);
    if (!hasPrev || prefersReducedMotion()) {
      shown.current = target;
      setState(target);
      return;
    }
    const plans = series.map((next, si) => {
      const prev = from.frame[si] ?? [];
      const prevByTs = new Map(prev.map((p) => [p[0], p[1]]));
      const fallback = prev.at(-1)?.[1] ?? next[0]?.[1] ?? 0;
      const firstNext = next[0]?.[0] ?? Infinity;
      const leaving = prev.filter((p) => p[0] < firstNext).map((p) => ({ t: p[0], a: p[1], b: p[1] }));
      return [...leaving, ...next.map((p) => ({ t: p[0], a: prevByTs.get(p[0]) ?? fallback, b: p[1] }))];
    });
    const [a0, a1] = from.domain;
    const [b0, b1] = target.domain;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      if (p >= 1) {
        shown.current = target;
        setState(target);
        return;
      }
      const e = ease(p);
      const next = {
        frame: plans.map((pts) => pts.map((q): Point => [q.t, q.a + (q.b - q.a) * e])),
        domain: [a0 + (b0 - a0) * e, a1 + (b1 - a1) * e] as Domain,
      };
      shown.current = next;
      setState(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [series, ms]);

  return state;
}

/** Returns a counter that increments whenever `value` changes after mount (use as a React key to replay a CSS animation). */
export function useChangeKey<T>(value: T, isChange: (a: T, b: T) => boolean = (a, b) => a !== b): number {
  const prev = useRef(value);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (isChange(prev.current, value)) setKey((k) => k + 1);
    prev.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return key;
}

/**
 * FLIP reorder animation: children marked with data-flip="<key>" glide from their previous position
 * to the new one when the list order changes (e.g. an item turning unhealthy moves to the top).
 */
export function useFlip(ref: RefObject<HTMLElement | null>): void {
  const prev = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = new Map<string, number>();
    for (const child of el.querySelectorAll<HTMLElement>(':scope > [data-flip]')) {
      const key = child.dataset.flip!;
      const top = child.offsetTop;
      next.set(key, top);
      const before = prev.current.get(key);
      if (before !== undefined && before !== top && !prefersReducedMotion()) {
        child.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    }
    prev.current = next;
  });
}
