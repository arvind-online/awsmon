import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/types.js';

/** Tracks connected display sockets, broadcasts messages and drops dead clients via heartbeat. */
export class Hub {
  private readonly clients = new Map<WebSocket, { alive: boolean; lastRefresh: number }>();
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly maxClients = 50,
    /** Minimum gap between refresh requests from one socket; extra requests are dropped. */
    private readonly refreshGapMs = 5_000,
  ) {}

  start(intervalMs = 20_000): void {
    this.heartbeat = setInterval(() => {
      for (const [ws, st] of this.clients) {
        if (!st.alive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        st.alive = false;
        this.send(ws, { type: 'ping' });
      }
    }, intervalMs);
    this.heartbeat.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  /** Returns false (and closes the socket) when the connection cap is reached. */
  add(ws: WebSocket, onMessage: (m: ClientMessage) => void): boolean {
    if (this.clients.size >= this.maxClients) {
      ws.close(1013, 'Too many connections');
      return false;
    }
    this.clients.set(ws, { alive: true, lastRefresh: 0 });
    ws.on('message', (raw: Buffer) => {
      if (raw.length > 1024) return;
      try {
        const m = JSON.parse(raw.toString()) as ClientMessage;
        const st = this.clients.get(ws);
        if (!st) return;
        if (m.type === 'pong') st.alive = true;
        else if (m.type === 'refresh') {
          const now = Date.now();
          if (now - st.lastRefresh < this.refreshGapMs) return;
          st.lastRefresh = now;
          onMessage(m);
        }
      } catch {
        /* ignore malformed */
      }
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    return true;
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  get size(): number {
    return this.clients.size;
  }
}
