import type { Health } from '../../shared/types.js';

const RANK: Record<Health, number> = { OK: 0, UNKNOWN: 1, WARN: 2, CRIT: 3 };

export function worst(hs: Health[]): Health {
  return hs.reduce<Health>((a, b) => (RANK[b] > RANK[a] ? b : a), 'OK');
}

export function levelFor(value: number | null, warn: number | undefined, crit: number | undefined, bad: 'high' | 'low' | 'none'): Health {
  if (value === null) return 'UNKNOWN';
  if (bad === 'none' || warn === undefined || crit === undefined) return 'OK';
  if (bad === 'high') return value >= crit ? 'CRIT' : value >= warn ? 'WARN' : 'OK';
  return value <= crit ? 'CRIT' : value <= warn ? 'WARN' : 'OK';
}
