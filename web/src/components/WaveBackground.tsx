import { useEffect, useRef } from 'react';
import type { BackgroundMode, Health } from '../../../shared/types';
import { prefersReducedMotion } from '../hooks/anim';
import { type Intensity, type Theme, WaveRenderer } from '../waves/render';
import type { WaveMessage } from '../waves/worker';

interface Props {
  mode: BackgroundMode;
  intensity: Intensity;
  /** When set (status ambience on), the ribbon warms slightly and moves a little faster while unhealthy. */
  health?: Health;
}

const FPS = 30;
/** Backing-store scale: the lines are fine and soft, so 75% resolution is visually identical and much cheaper. */
const RENDER_SCALE = 0.75;

const currentTheme = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
const unhealthyLevel = (h?: Health) => (h === 'CRIT' ? 1 : h === 'WARN' ? 0.5 : 0);
const scaleNow = () => Math.min(window.devicePixelRatio || 1, 2) * RENDER_SCALE;

/** Common surface for the worker-backed and main-thread renderers. */
interface Driver {
  post(m: Exclude<WaveMessage, { type: 'init' }>): void;
  dispose(): void;
}

/** Preferred: OffscreenCanvas in a Web Worker, so drawing never blocks the main (UI) thread. */
function workerDriver(canvas: HTMLCanvasElement, init: Omit<Extract<WaveMessage, { type: 'init' }>, 'type' | 'canvas'>): Driver | null {
  if (typeof Worker === 'undefined' || !('transferControlToOffscreen' in canvas)) return null;
  try {
    const worker = new Worker(new URL('../waves/worker.ts', import.meta.url), { type: 'module' });
    const off = canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: off, ...init } satisfies WaveMessage, [off]);
    return { post: (m) => worker.postMessage(m), dispose: () => worker.terminate() };
  } catch {
    return null;
  }
}

/** Fallback: same renderer on the main thread with a rAF loop. */
function mainThreadDriver(canvas: HTMLCanvasElement, init: Omit<Extract<WaveMessage, { type: 'init' }>, 'type' | 'canvas'>): Driver | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const r = new WaveRenderer(ctx);
  r.setSize(init.w, init.h, init.scale);
  r.setTheme(init.theme);
  r.setIntensity(init.intensity);
  let raf = 0;
  let last = performance.now();
  let visible = true;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (!visible || now - last < 1000 / init.fps) return;
    r.frame(Math.min(now - last, 250) / 1000);
    last = now;
  };
  if (init.still) r.draw();
  else raf = requestAnimationFrame(loop);
  return {
    post: (m) => {
      if (m.type === 'resize') {
        r.setSize(m.w, m.h, m.scale);
        r.draw();
      } else if (m.type === 'theme') {
        r.setTheme(m.theme);
        r.draw();
      } else if (m.type === 'intensity') {
        r.setIntensity(m.intensity);
        r.draw();
      } else if (m.type === 'unhealthy') r.setUnhealthy(m.level);
      else if (m.type === 'visible') visible = m.visible;
    },
    dispose: () => cancelAnimationFrame(raf),
  };
}

/**
 * Ambient silk-ribbon background. The canvas is created imperatively because a canvas handed to a
 * worker can never be reused (React StrictMode mounts effects twice in development).
 */
export function WaveBackground({ mode, intensity, health }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const driver = useRef<Driver | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || mode === 'off') return;
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    const init = { w: window.innerWidth, h: window.innerHeight, scale: scaleNow(), theme: currentTheme(), intensity, still: mode === 'static' || prefersReducedMotion(), fps: FPS };
    const d = workerDriver(canvas, init) ?? mainThreadDriver(canvas, init);
    driver.current = d;
    if (!d) return;

    let t: number | undefined;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => d.post({ type: 'resize', w: window.innerWidth, h: window.innerHeight, scale: scaleNow() }), 100);
    };
    const onVis = () => d.post({ type: 'visible', visible: document.visibilityState === 'visible' });
    const mo = new MutationObserver(() => d.post({ type: 'theme', theme: currentTheme() }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearTimeout(t);
      mo.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      d.dispose();
      driver.current = null;
      canvas.remove();
    };
    // Intensity changes are posted below without rebuilding the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => driver.current?.post({ type: 'intensity', intensity }), [intensity]);
  useEffect(() => driver.current?.post({ type: 'unhealthy', level: unhealthyLevel(health) }), [health]);

  if (mode === 'off') return null;
  return <div ref={host} className="waves" aria-hidden />;
}
