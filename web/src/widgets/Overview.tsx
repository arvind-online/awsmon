import type { Group, Snapshot } from '../../../shared/types';
import { Activity, Alert, Bell, Cache, Check, Container, Cross, Database, Bolt, Stream } from '../components/Icons';
import { Dot } from '../components/StatusBadge';
import { Num } from '../components/charts';
import { HEALTH_LABEL } from '../format';
import type { ReactNode } from 'react';

export const GROUP_ICON: Record<Group['type'], ReactNode> = {
  ecs: <Container />,
  aurora: <Database />,
  lambda: <Bolt />,
  kinesis: <Stream />,
  redis: <Cache />,
  alarms: <Bell />,
};

const SHORT: Record<Group['type'], string> = { ecs: 'ECS', aurora: 'Aurora', lambda: 'Lambda', kinesis: 'Kinesis', redis: 'Redis', alarms: 'Alarms' };

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  const items = snapshot.groups.filter((g) => !g.disabled).flatMap((g) => g.items);
  const count = (h: string) => items.filter((i) => i.health === h).length;
  const bad = count('WARN') + count('CRIT');
  const headline =
    snapshot.overall === 'OK' ? 'All systems operational' : snapshot.overall === 'UNKNOWN' ? 'Status unknown' : `${bad} ${bad === 1 ? 'resource needs' : 'resources need'} attention`;
  const Icon = snapshot.overall === 'OK' ? Check : snapshot.overall === 'CRIT' ? Cross : Alert;
  const p = snapshot.poll;

  return (
    <div className="overview">
      <div className={`hero hero-${snapshot.overall.toLowerCase()}`}>
        <div className="orb">
          <span className="orb-ring" />
          <span className="orb-core">
            <Icon width={34} height={34} strokeWidth={2.2} />
          </span>
        </div>
        <div className="hero-text">
          <strong>{headline}</strong>
          <span>
            {HEALTH_LABEL[snapshot.overall]} · {items.length} resources monitored
          </span>
          <div className="counts">
            <span className="count">
              <b>
                <Num value={count('OK')} unit="count" />
              </b>{' '}
              healthy
            </span>
            <span className={`count${count('WARN') ? ' count-warn' : ' count-zero'}`}>
              <b>
                <Num value={count('WARN')} unit="count" />
              </b>{' '}
              warning
            </span>
            <span className={`count${count('CRIT') ? ' count-crit' : ' count-zero'}`}>
              <b>
                <Num value={count('CRIT')} unit="count" />
              </b>{' '}
              critical
            </span>
          </div>
        </div>
      </div>

      <div className="group-tiles">
        {snapshot.groups.map((g) => (
          <div key={g.type} className={`gtile gtile-${g.disabled ? 'off' : g.health.toLowerCase()}${g.error ? ' gtile-stale' : ''}`} title={g.error ? `${g.title}: ${g.error}` : undefined}>
            <div className="gtile-top">
              <span className="gtile-icon">{GROUP_ICON[g.type]}</span>
              <span className="gtile-title">{SHORT[g.type]}</span>
              {g.error && <span className="gtile-flag">stale</span>}
            </div>
            <div className="gtile-dots">
              {g.items.length === 0 ? <span className="muted">{g.disabled ? 'not set up' : '–'}</span> : g.items.map((i) => (
                <span key={i.id} title={`${i.name}: ${HEALTH_LABEL[i.health]}`}>
                  <Dot health={i.health} pulse />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="pollinfo">
        <div>
          <Activity width={15} height={15} />
          <span>{p.window === 'working' ? 'Working hours' : 'Off hours'}</span>
        </div>
        <dl>
          <dt>Polling every</dt>
          <dd>
            {p.intervalMin} min{p.escalated ? ' (escalated)' : ''}
          </dd>
          <dt>Last poll</dt>
          <dd>{p.error ? 'failed' : `${p.durationMs} ms`}</dd>
          <dt>Metrics / poll</dt>
          <dd>{p.metricsRequested}</dd>
        </dl>
      </div>
    </div>
  );
}
