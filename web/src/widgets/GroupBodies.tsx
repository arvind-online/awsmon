import type { Group, Health, Item, Metric } from '../../../shared/types';
import { AreaChart, Bar, Legend, Num, Ring, Sparkline } from '../components/charts';
import { FitList } from '../components/FitList';
import { Bell, Check } from '../components/Icons';
import { Dot, StatusBadge } from '../components/StatusBadge';

const S1 = 'var(--series-1)';
const S2 = 'var(--series-2)';
const WINDOW = 'Last 3 h · 5-min points';

const find = (it: Item, key: string): Metric | undefined => it.metrics.find((m) => m.key === key);
/** Colour is reserved for problems: OK values stay in neutral ink. */
const ink = (h: Health) => (h === 'OK' ? '' : ` ink-${h.toLowerCase()}`);

/** The aggregation window ("per 5 min") is stated once in the widget header; here it is a hover hint. */
function Label({ m }: { m: Metric }) {
  return (
    <span className="stat-label" title={m.per ? `${m.label} per ${m.per}` : m.label}>
      {m.label}
    </span>
  );
}

function Stat({ m, big }: { m: Metric | undefined; big?: boolean }) {
  if (!m) return null;
  return (
    <div className={`stat stat-${m.health.toLowerCase()}${big ? ' stat-big' : ''}`}>
      <Label m={m} />
      <span className="stat-value">
        <Num value={m.latest} unit={m.unit} />
      </span>
    </div>
  );
}

function Empty({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon ?? <Check width={26} height={26} />}</span>
      <p>{text}</p>
    </div>
  );
}

function MetricBar({ m }: { m: Metric | undefined }) {
  if (!m) return <div />;
  if (m.placeholder) {
    return (
      <div className="mbar mbar-placeholder" title={`${m.label}: ${m.placeholder}`}>
        <Label m={m} />
        <span className="mbar-value mbar-na">n/a</span>
        <div className="bar bar-empty" />
      </div>
    );
  }
  return (
    <div className="mbar">
      <Label m={m} />
      <span className={`mbar-value${ink(m.health)}`}>
        <Num value={m.latest} unit={m.unit} />
      </span>
      <Bar value={m.latest} warn={m.warn} crit={m.crit} health={m.health} />
    </div>
  );
}

function RowId({ it, sub }: { it: Item; sub?: string }) {
  return (
    <div className="row-id">
      <Dot health={it.health} pulse />
      <div>
        <b title={it.name}>{it.name}</b>
        <small className={ink(it.health).trim()}>{sub ?? it.statusText}</small>
      </div>
    </div>
  );
}

function throttleNote(write: Metric | undefined, read: Metric | undefined): string | undefined {
  const fmt = (m: Metric | undefined, label: string) => (!m || m.latest === null ? undefined : `${label} ${m.latest < 10 ? m.latest.toFixed(1) : Math.round(m.latest)}`);
  return [fmt(write, 'Write throttles'), fmt(read, 'Read throttles')].filter(Boolean).join(' · ') || undefined;
}

const listProps = { keyOf: (i: Item) => i.id, healthOf: (i: Item) => i.health };

export function EcsBody({ group }: { group: Group }) {
  if (group.items.length === 0) return <Empty text={group.emptyNote ?? 'No services'} />;
  return (
    <FitList
      {...listProps}
      items={group.items}
      minRow={50}
      render={(it) => {
        const cpu = find(it, 'cpu');
        return (
          <div className="row">
            <RowId it={it} />
            <MetricBar m={cpu} />
            <MetricBar m={find(it, 'mem')} />
            <div className="row-spark">{cpu && <Sparkline points={cpu.series} color={S1} />}</div>
          </div>
        );
      }}
    />
  );
}

export function AuroraBody({ group }: { group: Group }) {
  if (group.items.length === 0) return <Empty text={group.emptyNote ?? 'No instances'} />;
  return (
    <div className="cards">
      {group.items.map((it) => {
        const cpu = find(it, 'cpu');
        const mem = find(it, 'mem');
        const disk = find(it, 'storage');
        return (
          <article className={`card card-${it.health.toLowerCase()}`} key={it.id}>
            <div className="card-head">
              <Dot health={it.health} pulse />
              <div className="card-title">
                <b>{it.name}</b>
                <small>{it.subtitle}</small>
              </div>
              <StatusBadge health={it.health} label={it.statusText} />
            </div>
            <div className="card-gauges">
              {cpu && <Ring value={cpu.latest} health={cpu.health} label="CPU" size={78} />}
              {mem && <Ring value={mem.latest} health={mem.health} label="Memory" size={78} />}
              {disk && <Ring value={disk.latest} health={disk.health} label="Storage" size={78} />}
              <div className="card-stats">
                <Stat m={find(it, 'conns')} />
                <Stat m={find(it, 'lag')} />
              </div>
            </div>
            {cpu && mem && (
              <div className="card-chart">
                <AreaChart
                  unit="percent"
                  warn={cpu.warn}
                  crit={cpu.crit}
                  bad="high"
                  series={[
                    { label: 'CPU', points: cpu.series, color: S1 },
                    { label: 'Memory', points: mem.series, color: S2 },
                  ]}
                />
                <Legend items={[{ label: 'CPU', color: S1 }, { label: 'Memory', color: S2 }]} caption={WINDOW} />
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function LambdaBody({ group }: { group: Group }) {
  if (group.items.length === 0) return <Empty text={group.emptyNote ?? 'No functions'} />;
  return (
    <FitList
      {...listProps}
      items={group.items}
      minRow={54}
      render={(it) => {
        const inv = find(it, 'inv');
        return (
          <div className="row row-lambda">
            <RowId it={it} />
            <div className="lam-inv">
              <Stat m={inv} big />
              <div className="row-spark">{inv && <Sparkline points={inv.series} color={S1} />}</div>
            </div>
            <Stat m={find(it, 'err')} />
            <Stat m={find(it, 'thr')} />
            <Stat m={find(it, 'dur')} />
          </div>
        );
      }}
    />
  );
}

/** Kinesis: iterator age (how far consumers are behind) is the headline; throughput is secondary. */
export function KinesisBody({ group }: { group: Group }) {
  if (group.items.length === 0) return <Empty text={group.emptyNote ?? 'No streams'} />;
  return (
    <div className="cards">
      {group.items.map((it) => {
        const inc = find(it, 'in');
        const out = find(it, 'out');
        const age = find(it, 'age');
        return (
          <article className={`card card-${it.health.toLowerCase()}`} key={it.id}>
            <div className="card-head">
              <Dot health={it.health} pulse />
              <div className="card-title">
                <b>{it.name}</b>
                <small>{[it.statusText.toLowerCase(), it.subtitle?.replace('provisioned · ', '')].filter(Boolean).join(' · ')}</small>
              </div>
              {age && (
                <span className={`kin-head-lag${ink(age.health)}`} title="Consumer lag (iterator age)">
                  lag <Num value={age.latest} unit={age.unit} />
                </span>
              )}
              <StatusBadge health={it.health} />
            </div>
            {age && (
              <div className="kin-hero">
                <div className={`stat stat-big stat-${age.health.toLowerCase()}`}>
                  <span className="stat-label">Consumer lag (iterator age)</span>
                  <span className="stat-value">
                    <Num value={age.latest} unit={age.unit} />
                  </span>
                </div>
                <div className="kin-side">
                  <Stat m={inc} />
                  <Stat m={out} />
                </div>
              </div>
            )}
            {age && (
              <div className="card-chart">
                <AreaChart unit="ms" warn={age.warn} crit={age.crit} bad="high" series={[{ label: 'Iterator age', points: age.series, color: S1 }]} />
              </div>
            )}
            {(find(it, 'rbytes') || find(it, 'rcalls')) && (
              <div className="kin-cap">
                <MetricBar m={find(it, 'rbytes')} />
                <MetricBar m={find(it, 'rcalls')} />
              </div>
            )}
            {inc && out && (
              <div className="kin-flow">
                <Sparkline
                  height={26}
                  series={[
                    { points: inc.series, color: S1 },
                    { points: out.series, color: S2 },
                  ]}
                />
                <Legend items={[{ label: 'Incoming', color: S1 }, { label: 'Read', color: S2 }]} caption={throttleNote(find(it, 'thr'), find(it, 'rthr'))} />
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** Sparkline beside a bar; metrics without data yet (agent not installed, instance stopped) get a dashed flat line. */
function Trend({ m, color }: { m: Metric | undefined; color: string }) {
  return <div className="row-spark ec2-spark">{m && m.series.length > 0 ? <Sparkline points={m.series} color={color} /> : <div className="spark-empty" />}</div>;
}

/** EC2: CPU is live; RAM and Storage show placeholders until the CloudWatch Agent publishes them (same keys, so the card needs no change then). */
export function Ec2Body({ group }: { group: Group }) {
  if (group.items.length === 0) return <Empty text={group.emptyNote ?? 'No instances'} />;
  return (
    <FitList
      {...listProps}
      items={group.items}
      minRow={42}
      render={(it) => {
        const cpu = find(it, 'cpu');
        const mem = find(it, 'mem');
        return (
          <div className="row row-ec2">
            <RowId it={it} sub={`${it.statusText}${it.subtitle ? ` · ${it.subtitle}` : ''}`} />
            <MetricBar m={cpu} />
            <Trend m={cpu} color={S1} />
            <MetricBar m={mem} />
            <Trend m={mem} color={S2} />
            <MetricBar m={find(it, 'disk')} />
          </div>
        );
      }}
    />
  );
}

/** Role plus connection count, so narrow widgets can drop the stat columns without losing the number. */
function redisSub(it: Item): string {
  const role = it.subtitle?.split(' · ')[0] ?? '';
  const conns = find(it, 'conns')?.latest;
  return conns == null ? role : `${role} · ${Math.round(conns)} conn`;
}

export function RedisBody({ group }: { group: Group }) {
  if (group.items.length === 0) return <Empty text={group.emptyNote ?? 'No nodes'} />;
  return (
    <FitList
      {...listProps}
      items={group.items}
      minRow={50}
      render={(it) => (
        <div className="row row-redis">
          <RowId it={it} sub={redisSub(it)} />
          <MetricBar m={find(it, 'cpu')} />
          <MetricBar m={find(it, 'mem')} />
          <div className="redis-stats">
            <Stat m={find(it, 'conns')} />
            <Stat m={find(it, 'evict')} />
          </div>
        </div>
      )}
    />
  );
}

export function AlarmsBody({ group }: { group: Group }) {
  if (group.items.length === 0) return <Empty text={group.emptyNote ?? 'No alarms'} icon={<Bell width={26} height={26} />} />;
  return (
    <FitList
      {...listProps}
      items={group.items}
      minRow={44}
      render={(it) => (
        <div className="row row-alarm">
          <RowId it={it} />
        </div>
      )}
    />
  );
}

export const BODIES = { ecs: EcsBody, aurora: AuroraBody, lambda: LambdaBody, kinesis: KinesisBody, redis: RedisBody, ec2: Ec2Body, alarms: AlarmsBody } as const;
