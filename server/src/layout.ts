import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { LayoutCell } from '../../shared/types.js';
import { writeJsonAtomic } from './fsutil.js';

const cell = z.object({
  i: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  x: z.number().int().min(0).max(48),
  y: z.number().int().min(0).max(500),
  w: z.number().int().min(1).max(48),
  h: z.number().int().min(1).max(200),
});
export const LayoutSchema = z.array(cell).max(100);

/**
 * The shared default dashboard layout. Stored server-side because Edge kiosk mode browses InPrivate,
 * so anything kept in the kiosk browser is wiped on every session.
 */
export class LayoutStore extends EventEmitter<{ change: [LayoutCell[] | null] }> {
  private layout: LayoutCell[] | null = null;
  private readonly file: string;

  constructor(dataDir: string) {
    super();
    this.file = join(dataDir, 'layout.json');
    if (existsSync(this.file)) {
      const parsed = LayoutSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) this.layout = parsed.data;
    }
  }

  get(): LayoutCell[] | null {
    return this.layout;
  }

  /** Validates and stores; `null` clears back to the built-in default. Throws ZodError on bad input. */
  set(input: unknown): LayoutCell[] | null {
    this.layout = input === null ? null : LayoutSchema.parse(input);
    writeJsonAtomic(this.file, this.layout, true);
    this.emit('change', this.layout);
    return this.layout;
  }
}
