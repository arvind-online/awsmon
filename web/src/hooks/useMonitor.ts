import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, LayoutCell, PublicSettings, ServerMessage, Snapshot } from '../../../shared/types';

export type Connection = 'connecting' | 'open' | 'closed';

const WATCHDOG_MS = 70_000; // server pings every 20s

export function useMonitor() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [refreshing, setRefreshing] = useState(false);
  const [denied, setDenied] = useState<{ reason: string; until: number } | null>(null);
  /** Shared default layout from the server: undefined until received, null when none is saved. */
  const [serverLayout, setServerLayout] = useState<LayoutCell[] | null | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);
  const version = useRef<string | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    let watchdog: number | undefined;

    const connect = () => {
      setConnection('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      const arm = () => {
        window.clearTimeout(watchdog);
        watchdog = window.setTimeout(() => ws.close(), WATCHDOG_MS);
      };
      ws.onopen = () => {
        retry = 0;
        setConnection('open');
        arm();
      };
      ws.onmessage = (ev) => {
        arm();
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        switch (msg.type) {
          case 'hello':
            // A redeployed server means a new UI build: reload to pick it up.
            if (version.current && version.current !== msg.serverVersion) location.reload();
            version.current = msg.serverVersion;
            setSettings(msg.settings);
            break;
          case 'snapshot':
            setSnapshot(msg.snapshot);
            setRefreshing(false);
            break;
          case 'settings':
            setSettings(msg.settings);
            break;
          case 'layout':
            setServerLayout(msg.layout);
            break;
          case 'refreshing':
            setRefreshing(true);
            break;
          case 'refresh-denied':
            setRefreshing(false);
            setDenied({ reason: msg.reason, until: Date.now() + msg.retryAfterSec * 1000 });
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' } satisfies ClientMessage));
            break;
        }
      };
      ws.onclose = () => {
        window.clearTimeout(watchdog);
        if (closed) return;
        setConnection('closed');
        setRefreshing(false);
        const delay = Math.min(15_000, 500 * 2 ** retry++) + Math.random() * 400;
        timer = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearTimeout(watchdog);
      wsRef.current?.close();
    };
  }, []);

  const refresh = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      setDenied(null);
      ws.send(JSON.stringify({ type: 'refresh' } satisfies ClientMessage));
    }
  }, []);

  return { snapshot, settings, connection, refreshing, denied, refresh, serverLayout };
}
