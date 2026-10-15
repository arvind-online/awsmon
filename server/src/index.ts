import { buildApp } from './app.js';
import { createCollector } from './collectors/index.js';
import { loadConfig } from './config.js';
import { EventLog } from './events.js';
import { Hub } from './hub.js';
import { LayoutStore } from './layout.js';
import { Monitor } from './monitor.js';
import { Scheduler } from './scheduler/scheduler.js';
import { SettingsService } from './settings.js';
import { UsageTracker } from './usage.js';

const config = loadConfig();

const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.server.host);
if (!loopback && process.env.MONITOR_ALLOW_NON_LOOPBACK !== 'true') {
  console.error(`Refusing to listen on ${config.server.host}: only loopback is allowed unless authentication is placed in front and MONITOR_ALLOW_NON_LOOPBACK=true is set.`);
  process.exit(1);
}
if (!config.auth.adminPasswordHash || config.auth.sessionSecret.length < 32) {
  console.warn('Admin UI disabled: set auth.adminPasswordHash and auth.sessionSecret (run `npm run init-config`).');
}

const settings = new SettingsService(config.dataDir, { dataSource: config.mode === 'aws' ? 'live' : 'simulated', ...config.settings });
const usage = new UsageTracker(config.dataDir);
const monitor = new Monitor(createCollector(config), settings, usage, new EventLog(config.dataDir), config.dataDir);
const scheduler = new Scheduler({ getSettings: () => settings.get(), poll: (t) => monitor.poll(t), initialLastPollAt: monitor.lastGoodAt() });
monitor.attach(scheduler);
const hub = new Hub(config.server.maxClients);
const layout = new LayoutStore(config.dataDir);

const app = await buildApp({ config, settings, monitor, scheduler, hub, layout });
hub.start();
await app.listen({ host: config.server.host, port: config.server.port });
if (!scheduler.start()) {
  app.log.info('Cached data is still fresh; skipping startup poll');
  monitor.republish();
}

const shutdown = async () => {
  scheduler.stop();
  hub.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
