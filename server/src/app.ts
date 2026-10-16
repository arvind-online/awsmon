import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { ServerMessage } from '../../shared/types.js';
import { AuthState, LoginLimiter, SessionSigner, hashPassword, safeEqual, verifyPassword } from './auth.js';
import type { Config } from './config.js';
import { type HistoryService, isGroupType } from './history.js';
import type { Hub } from './hub.js';
import { type LayoutStore } from './layout.js';
import type { Monitor } from './monitor.js';
import type { Scheduler } from './scheduler/scheduler.js';
import { type SettingsService, toPublic } from './settings.js';

export const SERVER_VERSION = '0.1.0';
const COOKIE = 'mon_session';

export interface AppDeps {
  config: Config;
  settings: SettingsService;
  monitor: Monitor;
  scheduler: Scheduler;
  hub: Hub;
  layout: LayoutStore;
  history: HistoryService;
}

function findWebDist(): string | undefined {
  const candidates = [process.env.MONITOR_WEB_DIST, resolve(import.meta.dirname, '../../web/dist'), resolve(import.meta.dirname, '../../../../web/dist')];
  return candidates.find((c): c is string => !!c && existsSync(resolve(c, 'index.html')));
}

export async function buildApp({ config, settings, monitor, scheduler, hub, layout, history }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    bodyLimit: 16 * 1024,
    trustProxy: config.server.trustProxy,
  });
  const adminConfigured = config.auth.adminPasswordHash !== '' && config.auth.sessionSecret.length >= 32;
  const authState = new AuthState(join(config.dataDir, 'auth-state.json'));
  const signer = adminConfigured ? new SessionSigner(config.auth.sessionSecret, () => authState.epoch()) : undefined;
  const limiter = new LoginLimiter();
  // Used so a wrong username costs the same time as a wrong password.
  const dummyHash = await hashPassword('not-the-password');

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.server.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (_req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  const originOk = (req: FastifyRequest): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients; CSRF needs a browser
    if (config.server.allowedOrigins.includes(origin)) return true;
    const host = req.headers.host;
    return !!host && (origin === `http://${host}` || origin === `https://${host}`);
  };

  const guardOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!originOk(req)) return reply.code(403).send({ error: 'Origin not allowed' });
  };

  const sessionOf = (req: FastifyRequest) => signer?.verify(req.cookies[COOKIE]) ?? null;

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!signer) return reply.code(503).send({ error: 'Admin is not configured' });
    const session = sessionOf(req);
    if (!session) return reply.code(401).send({ error: 'Not signed in' });
    if (req.method !== 'GET') {
      if (!originOk(req)) return reply.code(403).send({ error: 'Origin not allowed' });
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, signer.csrfFor(session))) return reply.code(403).send({ error: 'Bad CSRF token' });
    }
  };

  // ---- Public (display) API ------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, version: SERVER_VERSION, clients: hub.size, hasSnapshot: !!monitor.snapshot() }));
  app.get('/api/snapshot', async (_req, reply) => {
    const snap = monitor.snapshot();
    return snap ?? reply.code(503).send({ error: 'No data yet' });
  });
  app.post('/api/refresh', { preHandler: guardOrigin }, async (_req, reply) => {
    const res = await scheduler.refresh();
    return res.ok ? { ok: true } : reply.code(429).send(res);
  });
  // 24-hour series for one card's detail view. The card name is checked against a fixed list; the resources read are always the configured ones.
  app.get<{ Params: { type: string } }>('/api/history/:type', async (req, reply) => {
    const { type } = req.params;
    if (!isGroupType(type)) return reply.code(404).send({ error: 'Unknown card' });
    try {
      return await history.get(type);
    } catch (e) {
      req.log.warn({ err: (e as Error).message, type }, 'history failed');
      return reply.code(502).send({ error: 'Could not load history' });
    }
  });
  app.get('/api/layout', async () => ({ layout: layout.get() }));

  // ---- WebSocket -----------------------------------------------------------
  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!originOk(req)) {
      socket.close(1008, 'Origin not allowed');
      return;
    }
    const accepted = hub.add(socket, () => {
      void scheduler.refresh().then((res) => {
        if (!res.ok) hub.send(socket, { type: 'refresh-denied', reason: res.reason, retryAfterSec: res.retryAfterSec });
      });
    });
    if (!accepted) return;
    hub.send(socket, { type: 'hello', serverVersion: SERVER_VERSION, settings: toPublic(settings.get()) });
    hub.send(socket, { type: 'layout', layout: layout.get() });
    const snap = monitor.snapshot();
    if (snap) hub.send(socket, { type: 'snapshot', snapshot: snap });
  });

  // ---- Admin API -----------------------------------------------------------
  const LoginBody = z.object({ username: z.string().max(200), password: z.string().max(500) });

  app.post('/api/admin/login', { preHandler: guardOrigin }, async (req, reply) => {
    if (!signer) return reply.code(503).send({ error: 'Admin is not configured' });
    const key = req.ip;
    const wait = limiter.retryAfterSec(key);
    if (wait > 0) return reply.code(429).header('Retry-After', String(wait)).send({ error: `Too many attempts. Try again in ${wait}s` });
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    const userOk = safeEqual(body.data.username, config.auth.adminUser);
    const passOk = await verifyPassword(body.data.password, userOk ? config.auth.adminPasswordHash : dummyHash);
    if (!userOk || !passOk) {
      limiter.fail(key);
      await new Promise((r) => setTimeout(r, 400));
      req.log.warn({ ip: key }, 'admin login failed');
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    limiter.success(key);
    const ttl = config.auth.sessionHours * 3_600_000;
    reply.setCookie(COOKIE, signer.issue(config.auth.adminUser, ttl), { httpOnly: true, sameSite: 'strict', secure: config.server.secureCookies, path: '/api', maxAge: Math.floor(ttl / 1000) });
    req.log.info('admin login ok');
    return { ok: true };
  });

  app.post('/api/admin/logout', { preHandler: guardOrigin }, async (req, reply) => {
    // Single admin account: revoking the epoch invalidates every outstanding session token, not just this cookie.
    if (sessionOf(req)) authState.revokeAll();
    reply.clearCookie(COOKIE, { path: '/api' });
    return { ok: true };
  });

  app.get('/api/admin/me', async (req) => {
    const session = sessionOf(req);
    return { configured: adminConfigured, signedIn: !!session, user: session?.user, csrfToken: session && signer ? signer.csrfFor(session) : undefined };
  });

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => ({
    settings: settings.get(),
    metricsPerPoll: monitor.snapshot()?.poll.metricsRequested ?? 0,
    simulated: monitor.snapshot()?.cost.simulated ?? true,
  }));

  app.put('/api/admin/settings', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const next = settings.update(req.body);
      req.log.info('admin settings updated');
      return { settings: next };
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid settings', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      }
      throw e;
    }
  });

  app.put('/api/admin/layout', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { layout?: unknown } | null;
    try {
      const saved = layout.set(body?.layout ?? null);
      req.log.info({ cells: saved?.length ?? 0 }, 'default layout updated');
      return { layout: saved };
    } catch (e) {
      if (e instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid layout' });
      throw e;
    }
  });

  // ---- Wiring --------------------------------------------------------------
  monitor.on('snapshot', (snapshot) => hub.broadcast({ type: 'snapshot', snapshot }));
  monitor.on('refreshing', (trigger) => hub.broadcast({ type: 'refreshing', trigger } satisfies ServerMessage));
  layout.on('change', (l) => hub.broadcast({ type: 'layout', layout: l }));
  settings.on('change', (s) => {
    hub.broadcast({ type: 'settings', settings: toPublic(s) });
    monitor.republish();
  });

  // ---- Static UI -----------------------------------------------------------
  const webDist = findWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.log.warn('Web UI build not found (web/dist). Run the Vite dev server or `npm run build`.');
  }

  return app;
}
