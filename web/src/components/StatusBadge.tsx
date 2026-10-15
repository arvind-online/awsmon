import type { Health } from '../../../shared/types';
import { HEALTH_LABEL } from '../format';
import { useChangeKey } from '../hooks/anim';
import { Alert, Check, Cross, Question } from './Icons';

const ICON = { OK: Check, WARN: Alert, CRIT: Cross, UNKNOWN: Question } as const;

/** Health is never colour alone: icon + label always accompany the colour. */
export function StatusBadge({ health, label, compact }: { health: Health; label?: string; compact?: boolean }) {
  const Icon = ICON[health];
  return (
    <span className={`badge badge-${health.toLowerCase()}${compact ? ' badge-compact' : ''}`} title={HEALTH_LABEL[health]}>
      <Icon width={compact ? 12 : 14} height={compact ? 12 : 14} strokeWidth={2.4} />
      {!compact && <span>{label ?? HEALTH_LABEL[health]}</span>}
    </span>
  );
}

/** Status dot. Pulses while not OK, and sends out a one-off ripple when the status changes. */
export function Dot({ health, pulse }: { health: Health; pulse?: boolean }) {
  const changed = useChangeKey(health);
  return (
    <span className={`dot dot-${health.toLowerCase()}${pulse && health !== 'OK' ? ' dot-pulse' : ''}`} aria-label={HEALTH_LABEL[health]} role="img">
      {changed > 0 && <i key={changed} className="dot-ripple" />}
    </span>
  );
}
