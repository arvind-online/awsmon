import { useEffect, useRef, useState } from 'react';

/** Re-renders every `ms` and returns the current time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Observed content-box size of an element. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Eases a number toward `target` for smooth count-up/down animations. */
export function useTween(target: number | null, ms = 700): number | null {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (target === null || from.current === null) {
      from.current = target;
      setValue(target);
      return;
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - (1 - p) ** 3;
      const v = a + (target - a) * eased;
      from.current = v;
      setValue(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Subtle anti burn-in drift: nudges the whole UI by a few pixels every couple of minutes. */
export function usePixelShift(enabled: boolean): { x: number; y: number } {
  const [off, setOff] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!enabled) {
      setOff({ x: 0, y: 0 });
      return;
    }
    const id = window.setInterval(() => setOff({ x: Math.round((Math.random() - 0.5) * 8), y: Math.round((Math.random() - 0.5) * 8) }), 120_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return off;
}

/** Reloads the page at ~04:00 local time to clear any long-running browser memory growth. */
export function useNightlyReload(): void {
  useEffect(() => {
    const next = new Date();
    next.setHours(4, Math.floor(Math.random() * 30), 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const id = window.setTimeout(() => location.reload(), next.getTime() - Date.now());
    return () => window.clearTimeout(id);
  }, []);
}

/** Kiosk display mode: `?display=kiosk`. Locks the layout and hides interactive chrome. */
export const isKiosk = () => new URLSearchParams(location.search).get('display') === 'kiosk';

/** Hides the mouse cursor after a few seconds without movement, and blocks the context menu. */
export function useKioskInput(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let t: number | undefined;
    const wake = () => {
      root.classList.remove('cursor-hidden');
      window.clearTimeout(t);
      t = window.setTimeout(() => root.classList.add('cursor-hidden'), 3000);
    };
    const noMenu = (e: Event) => e.preventDefault();
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('contextmenu', noMenu);
    return () => {
      window.clearTimeout(t);
      root.classList.remove('cursor-hidden');
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('contextmenu', noMenu);
    };
  }, [enabled]);
}

/** Applies the admin "Card opacity" percentage to the card background. */
export function useCardOpacity(percent: number | undefined): void {
  useEffect(() => {
    if (percent === undefined) return;
    document.documentElement.style.setProperty('--card-alpha', String(Math.min(100, Math.max(50, percent)) / 100));
  }, [percent]);
}
