// Draws the ribbon background on an OffscreenCanvas, so animation never competes with the
// main thread that renders charts, numbers and interactions.
import { type Intensity, type Theme, WaveRenderer } from './render';

export type WaveMessage =
  | { type: 'init'; canvas: OffscreenCanvas; w: number; h: number; scale: number; theme: Theme; intensity: Intensity; still: boolean; fps: number }
  | { type: 'resize'; w: number; h: number; scale: number }
  | { type: 'theme'; theme: Theme }
  | { type: 'intensity'; intensity: Intensity }
  | { type: 'unhealthy'; level: number }
  | { type: 'visible'; visible: boolean };

interface WorkerScope {
  onmessage: ((e: MessageEvent<WaveMessage>) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
}
const scope = self as unknown as WorkerScope;
const raf = scope.requestAnimationFrame?.bind(scope) ?? ((cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number);

let renderer: WaveRenderer | null = null;
let still = false;
let visible = true;
let frameMs = 1000 / 30;
let last = 0;
let looping = false;

function loop(now: number): void {
  if (!visible || still || !renderer) {
    looping = false;
    return;
  }
  raf(loop);
  const elapsed = now - last;
  if (elapsed < frameMs) return;
  last = now;
  renderer.frame(Math.min(elapsed, 250) / 1000);
}

function start(): void {
  if (looping || still) return;
  looping = true;
  last = performance.now();
  raf(loop);
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const ctx = m.canvas.getContext('2d');
    if (!ctx) return;
    renderer = new WaveRenderer(ctx);
    renderer.setSize(m.w, m.h, m.scale);
    renderer.setTheme(m.theme);
    renderer.setIntensity(m.intensity);
    still = m.still;
    frameMs = 1000 / m.fps;
    if (still) renderer.draw();
    else start();
    return;
  }
  if (!renderer) return;
  switch (m.type) {
    case 'resize':
      renderer.setSize(m.w, m.h, m.scale);
      renderer.draw();
      break;
    case 'theme':
      renderer.setTheme(m.theme);
      renderer.draw();
      break;
    case 'intensity':
      renderer.setIntensity(m.intensity);
      renderer.draw();
      break;
    case 'unhealthy':
      renderer.setUnhealthy(m.level);
      break;
    case 'visible':
      visible = m.visible;
      if (visible) start();
      break;
  }
};
