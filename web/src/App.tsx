import GridLayout, { useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout';
import { createScaledStrategy, transformStrategy } from 'react-grid-layout/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DisplayScale, Group, LayoutCell } from '../../shared/types';
import { AdminPage } from './admin/AdminPage';
import { api, setCsrf } from './api';
import { CostChip, Footer, RecentChanges } from './components/Footer';
import { Header } from './components/Header';
import { Activity, Reset, X } from './components/Icons';
import { WaveBackground } from './components/WaveBackground';
import { Widget } from './components/Widget';
import { isKiosk, useCardOpacity, useKioskInput, useNightlyReload, usePixelShift } from './hooks/misc';
import { useMonitor } from './hooks/useMonitor';
import { useTheme } from './hooks/useTheme';
import { BODIES } from './widgets/GroupBodies';
import { GROUP_ICON, Overview } from './widgets/Overview';

const LOCAL_LAYOUT_KEY = 'awsmon.layout.v3';
const MARGIN = 12;
const CHROME_PX = 72 + 46 + 2 * MARGIN; // header + footer + grid padding
const SCALE: Record<DisplayScale, number> = { desk: 1, wall: 1.18, tv: 1.4 };

type Cell = LayoutItem & LayoutCell;

const DEFAULTS: Cell[] = [
  { i: 'overview', x: 0, y: 0, w: 12, h: 3, minW: 4, minH: 2 },
  { i: 'ecs', x: 0, y: 3, w: 5, h: 9, minW: 3, minH: 3 },
  { i: 'aurora', x: 5, y: 3, w: 7, h: 9, minW: 3, minH: 4 },
  { i: 'lambda', x: 0, y: 12, w: 4, h: 8, minW: 3, minH: 3 },
  { i: 'kinesis', x: 4, y: 12, w: 4, h: 8, minW: 3, minH: 5 },
  { i: 'redis', x: 8, y: 12, w: 4, h: 8, minW: 3, minH: 3 },
  { i: 'alarms', x: 0, y: 20, w: 12, h: 3, minW: 3, minH: 2 },
];
const TITLES: Record<string, string> = { overview: 'Overview', ecs: 'ECS services', aurora: 'Aurora PostgreSQL', lambda: 'Lambda', kinesis: 'Kinesis', redis: 'ElastiCache Redis', alarms: 'CloudWatch alarms' };

/** Take positions from a saved layout but min sizes from code; widgets missing from the save go to the bottom. */
function normalize(saved: LayoutCell[] | null | undefined): Cell[] {
  if (!saved?.length) return DEFAULTS;
  const byId = new Map(saved.map((c) => [c.i, c]));
  const bottom = Math.max(0, ...saved.map((c) => c.y + c.h));
  return DEFAULTS.map((d) => {
    const s = byId.get(d.i);
    return s ? { ...d, x: s.x, y: s.y, w: Math.max(s.w, d.minW ?? 1), h: Math.max(s.h, d.minH ?? 1) } : { ...d, y: bottom + d.y };
  });
}

const strip = (cells: readonly LayoutItem[]): LayoutCell[] => cells.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));

function readLocal(): LayoutCell[] | null {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_LAYOUT_KEY) ?? 'null') as LayoutCell[] | null;
  } catch {
    return null;
  }
}

/** Fit the grid's row height so the compacted layout fills the screen exactly. */
function useFitRowHeight(rows: number, scale: number): number {
  const calc = useCallback(() => {
    const avail = window.innerHeight / scale - CHROME_PX;
    // No hard minimum that could force scrolling: widgets adapt to small sizes via container queries.
    return Math.max(8, Math.min(110, Math.floor((avail - (rows - 1) * MARGIN) / Math.max(rows, 1))));
  }, [rows, scale]);
  const [rh, setRh] = useState(calc);
  useEffect(() => {
    setRh(calc());
    let t: number | undefined;
    const on = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setRh(calc()), 120);
    };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [calc]);
  return rh;
}

/** Item count, plus the aggregation window when the group shows summed metrics. */
function metaFor(g: Group): string {
  const per = g.items.flatMap((i) => i.metrics).find((m) => m.per)?.per;
  return per ? `${g.items.length} · per ${per}` : `${g.items.length}`;
}

export function App() {
  if (location.pathname.startsWith('/admin')) return <AdminPage />;
  return <Dashboard />;
}

function Dashboard() {
  const kiosk = useMemo(isKiosk, []);
  const { snapshot, settings, connection, refreshing, denied, refresh, serverLayout } = useMonitor();
  const ui = settings?.ui;
  const { theme, cycle } = useTheme(ui?.defaultTheme, kiosk);
  const shift = usePixelShift(ui?.pixelShift ?? true);
  const scale = SCALE[ui?.displayScale ?? 'desk'];
  useNightlyReload();
  useKioskInput(kiosk);
  useCardOpacity(ui?.cardOpacity);

  // Kiosk browsers run InPrivate, so they always follow the shared server layout. Other browsers
  // may hold a personal override in localStorage until they reset it.
  const [local, setLocal] = useState<LayoutCell[] | null>(() => (kiosk ? null : readLocal()));
  const layout = useMemo(() => normalize(local ?? serverLayout), [local, serverLayout]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set()); // intentionally not persisted: reload restores everything
  const [editing, setEditing] = useState(false);
  const [costShown, setCostShown] = useState<boolean | null>(null);
  const [admin, setAdmin] = useState<{ signedIn: boolean } | null>(null);
  const { width, containerRef, mounted } = useContainerWidth();

  const disabled = useMemo(() => new Set(snapshot?.groups.filter((g) => g.disabled).map((g) => g.type) ?? []), [snapshot]);
  const visible = useMemo(() => layout.filter((l) => !hidden.has(l.i) && !disabled.has(l.i as Group['type'])), [layout, hidden, disabled]);
  const [rows, setRows] = useState(() => Math.max(...DEFAULTS.map((c) => c.y + c.h)));
  const rowHeight = useFitRowHeight(rows, scale);

  // The grid reports its compacted layout; size rows from that so hiding a widget lets the rest grow.
  const onLayoutChange = useCallback((next: Layout) => setRows(Math.max(1, ...next.map((c) => c.y + c.h))), []);
  const commit = useCallback(
    (next: Layout) => {
      const byId = new Map(next.map((n) => [n.i, n]));
      const merged = strip(layout.map((c) => byId.get(c.i) ?? c));
      localStorage.setItem(LOCAL_LAYOUT_KEY, JSON.stringify(merged));
      setLocal(merged);
    },
    [layout],
  );

  useEffect(() => {
    if (!editing) return;
    void api<{ signedIn: boolean; csrfToken?: string }>('/api/admin/me').then((m) => {
      setCsrf(m.csrfToken ?? '');
      setAdmin(m);
    });
  }, [editing]);

  const [toast, setToast] = useState<string | null>(null);
  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4500);
  }, []);
  useEffect(() => {
    if (denied) say(`${denied.reason} · try again in ${Math.max(1, Math.ceil((denied.until - Date.now()) / 1000))}s`);
  }, [denied, say]);

  const resetLocal = () => {
    localStorage.removeItem(LOCAL_LAYOUT_KEY);
    setLocal(null);
  };
  const saveShared = async (cells: LayoutCell[] | null) => {
    try {
      await api('/api/admin/layout', { method: 'PUT', body: { layout: cells } });
      resetLocal();
      say(cells ? 'Saved as the default layout for all displays' : 'Restored the built-in default layout');
    } catch (e) {
      say(`Could not save layout: ${(e as Error).message}`);
    }
  };

  const hide = (id: string) => setHidden((h) => new Set(h).add(id));
  const restore = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.delete(id);
      return n;
    });

  const showCost = costShown ?? ui?.showCostByDefault ?? false;
  const canEdit = editing && !kiosk;
  // createScaledStrategy's calcDragPosition measures from the viewport origin, which is wrong when the grid
  // sits below a header. Without it, the grid falls back to its parent-relative math, which honours `scale`.
  const positionStrategy = useMemo(() => (scale === 1 ? transformStrategy : { ...createScaledStrategy(scale), calcDragPosition: undefined }), [scale]);

  const renderWidget = (id: string, index: number) => {
    const common = { editing: canEdit, canHide: !kiosk, index, onHide: () => hide(id) };
    if (id === 'overview') {
      return (
        <Widget title="Overview" icon={<Activity />} bare {...common}>
          {snapshot ? <Overview snapshot={snapshot} /> : <div className="skeleton" />}
        </Widget>
      );
    }
    const g = snapshot?.groups.find((x) => x.type === id);
    const Body = BODIES[id as keyof typeof BODIES];
    const stale = g?.error ? `Collector failing: ${g.error}. Showing data from ${g.lastSuccessAt ? new Date(g.lastSuccessAt).toLocaleTimeString() : 'earlier'}.` : undefined;
    return (
      <Widget title={TITLES[id] ?? id} icon={GROUP_ICON[id as Group['type']]} health={g?.error ? 'UNKNOWN' : g?.health} stale={stale} meta={g && g.items.length > 0 ? metaFor(g) : undefined} {...common}>
        {g ? <Body group={g} /> : <div className="skeleton" />}
      </Widget>
    );
  };

  return (
    <div className={`app${canEdit ? ' app-editing' : ''}${connection !== 'open' ? ' app-offline' : ''}${kiosk ? ' app-kiosk' : ''}`}>
      <div className="vignette" aria-hidden />
      {ui && <WaveBackground mode={ui.background} intensity={ui.backgroundIntensity} health={ui.statusAmbience ? snapshot?.overall : undefined} />}
      <div className="shell" style={
          {
            // Display scale uses transform (not CSS zoom): the grid's scaled position strategy maps pointer
            // coordinates correctly for transformed containers, so drag/resize stay accurate at any scale.
            transform: `translate(${shift.x}px, ${shift.y}px) scale(${scale})`,
            '--scale': scale,
          } as React.CSSProperties
        }>
        <Header
          snapshot={snapshot}
          connection={connection}
          refreshing={refreshing}
          theme={theme}
          editing={canEdit}
          kiosk={kiosk}
          showRefresh={!kiosk || (ui?.kioskShowRefresh ?? true)}
          onRefresh={refresh}
          onTheme={cycle}
          onToggleEdit={() => setEditing((e) => !e)}
        />

        {canEdit && (
          <div className="edit-bar" role="status">
            <span>
              Drag a header to move · drag an edge or corner to resize. {local ? 'Changes are saved in this browser.' : 'Showing the shared default layout.'}
            </span>
            {local && (
              <button className="chip" onClick={resetLocal} title="Discard this browser's changes">
                <Reset width={13} height={13} /> Reset to default
              </button>
            )}
            {admin?.signedIn ? (
              <>
                {serverLayout && !local && (
                  <button className="chip" onClick={() => void saveShared(null)}>
                    Restore built-in
                  </button>
                )}
                <button className="chip" onClick={() => void saveShared(strip(layout))} title="Every display, including the kiosk, will use this layout">
                  Save as default for all displays
                </button>
              </>
            ) : (
              <a className="chip" href="/admin?next=/" title="Sign in as admin to save this layout for every display">
                Sign in to save for all displays
              </a>
            )}
            <button className="chip chip-primary" onClick={() => setEditing(false)}>
              Done
            </button>
          </div>
        )}

        <main className="grid-wrap" ref={containerRef}>
          {mounted && (
            <GridLayout
              width={width}
              layout={visible}
              gridConfig={{ cols: 12, rowHeight, margin: [MARGIN, MARGIN], containerPadding: [0, 0] }}
              dragConfig={{ enabled: canEdit, handle: '.widget-head', cancel: '.no-drag' }}
              resizeConfig={{ enabled: canEdit, handles: ['se', 'e', 's', 'sw', 'w'] }}
              positionStrategy={positionStrategy}
              onLayoutChange={onLayoutChange}
              onDragStop={commit}
              onResizeStop={commit}
            >
              {visible.map((l, i) => (
                <div key={l.i} className="gi">
                  {renderWidget(l.i, i)}
                </div>
              ))}
            </GridLayout>
          )}
        </main>

        <Footer hidden={[...hidden].map((id) => ({ id, title: TITLES[id] ?? id }))} onRestore={restore} onRestoreAll={() => setHidden(new Set())}>
          <CostChip cost={snapshot?.cost} shown={showCost} onToggle={() => setCostShown(!showCost)} />
          <RecentChanges events={snapshot?.events ?? []} />
        </Footer>
      </div>

      {toast && (
        <div className="toast" role="alert">
          {toast}
          <button className="icon-btn" onClick={() => setToast(null)} aria-label="Dismiss">
            <X width={14} height={14} />
          </button>
        </div>
      )}
    </div>
  );
}
