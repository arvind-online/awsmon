/**
 * Silk-ribbon background: bundles of fine lines that fan out, pinch, twist and keep morphing, with
 * colour flowing slowly along them (blue → soft red → gray → lilac). Pure drawing code shared by the
 * Web Worker (OffscreenCanvas, the normal path) and the main-thread fallback.
 */

export type Theme = 'dark' | 'light';
export type Intensity = 'subtle' | 'medium';
type RGB = [number, number, number];
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const PALETTES: Record<Theme, RGB[]> = {
  dark: [
    [112, 150, 255], // blue
    [250, 150, 165], // soft red
    [176, 184, 200], // gray
    [168, 148, 255], // lilac
  ],
  light: [
    [58, 98, 214],
    [214, 92, 114],
    [112, 120, 138],
    [118, 92, 206],
  ],
};
const WARM: RGB = [255, 168, 96];
const BASE_ALPHA: Record<Theme, number> = { dark: 0.5, light: 0.42 };

interface Ribbon {
  lines: number;
  cy: number; // vertical centre (fraction of height)
  amp: number; // wave amplitude (fraction of height)
  spread: number; // max fan-out between first and last line (fraction of height)
  speed: number;
  seed: number;
  alpha: number;
  width: number;
}

const RIBBONS: Ribbon[] = [
  { lines: 56, cy: 0.52, amp: 0.15, spread: 0.3, speed: 1, seed: 0.3, alpha: 1, width: 0.8 },
  { lines: 28, cy: 0.8, amp: 0.08, spread: 0.16, speed: 0.7, seed: 2.1, alpha: 0.6, width: 0.65 },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Colour at a continuous position along the cyclic palette. */
function paletteAt(p: RGB[], pos: number): RGB {
  const n = p.length;
  const x = ((pos % n) + n) % n;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f); // smoothstep for gentle transitions
  return mix(p[i]!, p[(i + 1) % n]!, s);
}

const css = ([r, g, b]: RGB) => `rgb(${r | 0},${g | 0},${b | 0})`;

export class WaveRenderer {
  private w = 0;
  private h = 0;
  private theme: Theme = 'dark';
  private intensity: Intensity = 'subtle';
  private targetWarm = 0;
  private warm = 0;
  private clock = 40; // seconds of simulated time; start mid-motion rather than at a symmetric phase

  constructor(private readonly ctx: Ctx) {}

  setSize(w: number, h: number, scale: number): void {
    this.w = w;
    this.h = h;
    const c = this.ctx.canvas;
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  setTheme(t: Theme): void {
    this.theme = t;
  }

  setIntensity(i: Intensity): void {
    this.intensity = i;
  }

  /** 0 = healthy, 0.5 = warning, 1 = critical. Only set when status ambience is enabled. */
  setUnhealthy(level: number): void {
    this.targetWarm = level;
  }

  /** Advance time by `dt` seconds and draw one frame. */
  frame(dt: number): void {
    this.warm += (this.targetWarm - this.warm) * Math.min(1, dt / 3);
    this.clock += dt * (1 + 0.3 * this.warm);
    this.draw();
  }

  draw(): void {
    const { ctx, w, h } = this;
    if (w === 0 || h === 0) return;
    ctx.clearRect(0, 0, w, h);
    const t = this.clock;
    const palette = PALETTES[this.theme];
    const strength = (this.intensity === 'medium' ? 1.55 : 1) * BASE_ALPHA[this.theme];
    const step = Math.max(10, w / 150);

    for (const R of RIBBONS) {
      const tt = t * R.speed + R.seed * 20;
      // Colour flows along the ribbon: three stops sampled at offset positions of a slowly moving palette.
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      const base = tt / 28 + R.seed;
      for (const [off, pos] of [
        [0, 0],
        [0.5, 1],
        [1, 2],
      ] as const) {
        let c = paletteAt(palette, base + pos);
        if (this.warm > 0.01) c = mix(c, WARM, 0.45 * this.warm);
        grad.addColorStop(off, css(c));
      }
      ctx.strokeStyle = grad;
      ctx.lineWidth = R.width;

      // Shape parameters drift continuously, so the ribbon never settles into a repeating loop.
      const f1 = 0.72 + 0.16 * Math.sin(tt * 0.013 + R.seed);
      const f2 = 1.35 + 0.25 * Math.sin(tt * 0.009 + 2 + R.seed);
      const f3 = 0.85 + 0.2 * Math.sin(tt * 0.007 + 4 + R.seed);
      // Per-line phase offsets: lines drift apart in shape, which reads as the ribbon folding in 3D.
      const tw1 = 2.4 + 1.0 * Math.sin(tt * 0.021 + R.seed);
      const tw2 = 3.1 + 1.2 * Math.sin(tt * 0.017 + 1 + R.seed);
      const p1 = tt * 0.11;
      const p2 = -tt * 0.075 + R.seed * 3;
      const p3 = tt * 0.05 + R.seed;
      const bulge = 0.55 + 0.22 * Math.sin(tt * 0.031 + R.seed * 2); // where the ribbon swells
      const breathe = 1 + 0.18 * Math.sin(tt * 0.043 + R.seed);
      const cy = h * (R.cy + 0.025 * Math.sin(tt * 0.019 + R.seed));
      const A = h * R.amp * breathe;
      const S = h * R.spread;

      for (let j = 0; j < R.lines; j++) {
        const u = j / (R.lines - 1);
        // Edges of the bundle are fainter, so the ribbon reads as a soft 3D surface.
        ctx.globalAlpha = strength * R.alpha * (0.25 + 0.75 * Math.sin(Math.PI * u));
        ctx.beginPath();
        for (let x = -step; x <= w + step; x += step) {
          const xf = x / w;
          const env = 0.35 + 0.65 * Math.exp(-(((xf - bulge) / 0.34) ** 2));
          const wave = Math.sin(2 * Math.PI * f1 * xf + p1 + u * tw1) * 0.62 + Math.sin(2 * Math.PI * f2 * xf + p2 + u * tw2) * 0.38;
          // The fan width oscillates through zero along x: that is what makes the bundle pinch and twist.
          const fan = (u - 0.5) * S * Math.cos(2 * Math.PI * f3 * xf + p3);
          const y = cy + A * env * wave + fan;
          if (x === -step) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}
