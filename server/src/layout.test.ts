import { describe, expect, it } from 'vitest';
import { LayoutSchema } from './layout.js';

describe('LayoutSchema', () => {
  it('accepts grid cells', () => {
    expect(LayoutSchema.safeParse([{ i: 'ecs', x: 0, y: 3, w: 5, h: 9 }]).success).toBe(true);
  });
  it.each([
    ['negative x', { i: 'ecs', x: -1, y: 0, w: 1, h: 1 }],
    ['zero width', { i: 'ecs', x: 0, y: 0, w: 0, h: 1 }],
    ['markup in id', { i: '<img>', x: 0, y: 0, w: 1, h: 1 }],
    ['fractional', { i: 'ecs', x: 0.5, y: 0, w: 1, h: 1 }],
    ['extra keys stripped, not trusted', { i: 'ecs', x: 0, y: 0, w: 1, h: 1, static: true }],
  ])('rejects or sanitises %s', (_n, cell) => {
    const r = LayoutSchema.safeParse([cell]);
    if (r.success) expect(Object.keys(r.data[0]!)).toEqual(['i', 'x', 'y', 'w', 'h']);
    else expect(r.success).toBe(false);
  });
});
