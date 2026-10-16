import { type ReactNode, useEffect, useState } from 'react';
import type { Group, GroupHistory, Health, Item, Metric } from '../../../shared/types';
import { api } from '../api';
import { formatClock } from '../format';
import { AreaChart, Legend } from './charts';
import { Modal } from './Modal';
import { StatusBadge, Dot } from './StatusBadge';

const S1 = 'var(--series-1)';
const S2 = 'var(--series-2)';
const RANK: Record<Health, number> = { CRIT: 0, WARN: 1, UNKNOWN: 2, OK: 3 };

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: GroupHistory };

const find = (it: Item, key: string): Metric | undefined => it.metrics.find((m) => m.key === key);

function ChartCard({ title, note, legend, children }: { title: string; note?: string; legend?: { label: string; color: string }[]; children: ReactNode }) {
  return (
    <section className="dchart">
      <header>
        <h4>{title}</h4>
        {note && <small>{note}</small>}
      </header>
      <div className="dchart-plot">{children}</div>
      {legend && <Legend items={legend} />}
    </section>
  );
}

/** One chart for a metric on its own: used for every card until it gets a tailored layout. */
function MetricChart({ m }: { m: Metric }) {
  return (
    <ChartCard title={m.label} note={m.per ? `per ${m.per}` : undefined}>
      <AreaChart detailed unit={m.unit} warn={m.warn} crit={m.crit} bad={m.bad} series={[{ label: m.label, points: m.series, color: S1 }]} />
    </ChartCard>
  );
}

function GenericDetail({ item }: { item: Item }) {
  const metrics = item.metrics.filter((m) => !m.placeholder && m.series.length > 0);
  if (metrics.length === 0) return <p className="dempty">No data in the last 24 hours.</p>;
  return (
    <div className="dgrid">
      {metrics.map((m) => (
        <MetricChart key={m.key} m={m} />
      ))}
    </div>
  );
}

/** Kinesis: consumer lag, flow, read load against the provisioned shards, and throttles. */
function KinesisDetail({ item }: { item: Item }) {
  const age = find(item, 'age');
  const inc = find(item, 'in');
  const out = find(item, 'out');
  const rbytes = find(item, 'rbytes');
  const rcalls = find(item, 'rcalls');
  const wthr = find(item, 'thr');
  const rthr = find(item, 'rthr');
  return (
    <div className="dgrid">
      {age && (
        <ChartCard title="Consumer lag (iterator age)" note="max per 5 min">
          <AreaChart detailed unit="ms" warn={age.warn} crit={age.crit} bad="high" series={[{ label: 'Iterator age', points: age.series, color: S1 }]} />
        </ChartCard>
      )}
      {inc && out && (
        <ChartCard title="Records in and out" note="per 5 min" legend={[{ label: 'Incoming', color: S1 }, { label: 'Read (GetRecords)', color: S2 }]}>
          <AreaChart
            detailed
            unit="count"
            series={[
              { label: 'Incoming', points: inc.series, color: S1 },
              { label: 'Read', points: out.series, color: S2 },
            ]}
          />
        </ChartCard>
      )}
      {rbytes && rcalls ? (
        <ChartCard title="Read load vs provisioned shards" note={`${item.subtitle?.split(' · ')[1] ?? 'shards'} · 2 MiB/s and 5 calls/s per shard`} legend={[{ label: 'Read data', color: S1 }, { label: 'GetRecords calls', color: S2 }]}>
          <AreaChart
            detailed
            unit="percent"
            warn={rbytes.warn}
            crit={rbytes.crit}
            bad="high"
            series={[
              { label: 'Read data', points: rbytes.series, color: S1 },
              { label: 'GetRecords calls', points: rcalls.series, color: S2 },
            ]}
          />
        </ChartCard>
      ) : (
        <ChartCard title="Read load vs provisioned shards">
          <p className="dempty">On-demand stream: capacity scales automatically, so there is no fixed shard limit to compare against.</p>
        </ChartCard>
      )}
      {wthr && rthr && (
        <ChartCard title="Throttled requests" note="per 5 min" legend={[{ label: 'Write throttles', color: S1 }, { label: 'Read throttles', color: S2 }]}>
          <AreaChart
            detailed
            unit="count"
            series={[
              { label: 'Write throttles', points: wthr.series, color: S1 },
              { label: 'Read throttles', points: rthr.series, color: S2 },
            ]}
          />
        </ChartCard>
      )}
    </div>
  );
}

interface ChartSpec {
  title: string;
  /** Metric keys drawn together on one chart (they share a unit). Missing keys are skipped. */
  keys: string[];
  note?: string;
}

/** Cards that plot related metrics together. Anything not listed gets one chart per metric. */
const SPECS: Partial<Record<Group['type'], ChartSpec[]>> = {
  ecs: [{ title: 'CPU and memory', keys: ['cpu', 'mem'], note: 'average per 5 min' }],
  aurora: [
    { title: 'CPU, memory and storage', keys: ['cpu', 'mem', 'storage'], note: '% used' },
    { title: 'Connections', keys: ['conns'] },
    { title: 'Replica lag', keys: ['lag'] },
  ],
  lambda: [
    { title: 'Invocations', keys: ['inv'], note: 'per 5 min' },
    { title: 'Errors and throttles', keys: ['err', 'thr'], note: 'per 5 min' },
    { title: 'Duration', keys: ['dur'], note: 'average' },
  ],
  redis: [
    { title: 'Engine CPU and memory', keys: ['cpu', 'mem'], note: '% used' },
    { title: 'Connections', keys: ['conns'] },
    { title: 'Evictions', keys: ['evict'], note: 'per 5 min' },
  ],
  ec2: [
    { title: 'CPU', keys: ['cpu'], note: 'average per 5 min' },
    { title: 'RAM', keys: ['mem'] },
    { title: 'Storage', keys: ['disk'] },
  ],
};

const SERIES_COLORS = [S1, S2, 'var(--series-3, #8b7cf6)'];

/** Plots the listed metrics of an item together. Metrics without a source yet (no CloudWatch Agent) are collapsed into one short note. */
function SpecDetail({ item, specs }: { item: Item; specs: ChartSpec[] }) {
  const charts: ReactNode[] = [];
  const waiting: string[] = [];
  for (const spec of specs) {
    const ms = spec.keys.map((k) => find(item, k)).filter((m): m is Metric => !!m);
    if (ms.length === 0) continue;
    if (ms.some((m) => m.placeholder)) {
      waiting.push(spec.title);
      continue;
    }
    const first = ms[0]!;
    // Threshold lines only when every plotted metric shares them; otherwise they would mislead.
    const shared = ms.every((m) => m.warn === first.warn && m.crit === first.crit);
    charts.push(
      <ChartCard key={spec.title} title={spec.title} note={spec.note} legend={ms.length > 1 ? ms.map((m, i) => ({ label: m.label, color: SERIES_COLORS[i] ?? S1 })) : undefined}>
        <AreaChart
          detailed
          unit={first.unit}
          warn={shared ? first.warn : undefined}
          crit={shared ? first.crit : undefined}
          bad={shared ? first.bad : 'none'}
          series={ms.map((m, i) => ({ label: m.label, points: m.series, color: SERIES_COLORS[i] ?? S1 }))}
        />
      </ChartCard>,
    );
  }
  return (
    <>
      {charts.length > 0 && <div className={`dgrid${charts.length === 1 ? ' dgrid-one' : ''}`}>{charts}</div>}
      {waiting.length > 0 && <p className="dnote">{waiting.join(' and ')} not reported yet. Install the CloudWatch Agent on this instance and {waiting.length > 1 ? 'these charts fill' : 'this chart fills'} in automatically.</p>}
    </>
  );
}

const DETAILS: Partial<Record<Group['type'], (p: { item: Item }) => ReactNode>> = {
  kinesis: KinesisDetail,
  ...Object.fromEntries(Object.entries(SPECS).map(([type, specs]) => [type, ({ item }: { item: Item }) => <SpecDetail item={item} specs={specs} />])),
};

export function DetailModal({ type, title, icon, onClose }: { type: Group['type']; title: string; icon: ReactNode; onClose: () => void }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    api<GroupHistory>(`/api/history/${type}`)
      .then((data) => live && setState({ status: 'ready', data }))
      .catch((e: Error) => live && setState({ status: 'error', message: e.message }));
    return () => {
      live = false;
    };
  }, [type]);

  const group = state.status === 'ready' ? state.data.group : undefined;
  const Body = DETAILS[type] ?? GenericDetail;
  const items = group ? [...group.items].sort((a, b) => RANK[a.health] - RANK[b.health]) : [];

  return (
    <Modal title={title} icon={icon} badge={group && <StatusBadge health={group.health} />} onClose={onClose}>
      {state.status === 'loading' && (
        <div className="dloading" role="status">
          <div className="skeleton" />
          <span>Loading the last 24 hours…</span>
        </div>
      )}
      {state.status === 'error' && <p className="dempty">Could not load history ({state.message}). Close and try again in a moment.</p>}
      {state.status === 'ready' && group && (
        <>
          <p className="dmeta">
            Last {state.data.hours} h · 5-minute points· fetched {formatClock(state.data.generatedAt)}
          </p>
          {items.length === 0 && <p className="dempty">{group.emptyNote ?? 'Nothing to show.'}</p>}
          {items.map((it) => (
            <article className="ditem" key={it.id}>
              <header>
                <Dot health={it.health} />
                <b>{it.name}</b>
                <small>{[it.statusText.toLowerCase(), it.subtitle].filter(Boolean).join(' · ')}</small>
                <StatusBadge health={it.health} />
              </header>
              <Body item={it} />
            </article>
          ))}
        </>
      )}
    </Modal>
  );
}
