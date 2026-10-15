import { renameSync, writeFileSync } from 'node:fs';

/** Write JSON via a temp file + rename so a crash never leaves a half-written file. Owner-only permissions. */
export function writeJsonAtomic(file: string, data: unknown, pretty = false): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : undefined), { mode: 0o600 });
  renameSync(tmp, file);
}
