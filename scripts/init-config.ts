import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { hashPassword } from '../server/src/auth.js';

const target = 'config.json';
if (existsSync(target)) {
  console.error(`${target} already exists; not overwriting.`);
  process.exit(1);
}

const password = randomBytes(12).toString('base64url');
const config = {
  mode: 'mock',
  server: { host: '127.0.0.1', port: 8080, allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'] },
  aws: { region: 'ap-south-1' },
  resources: {
    ecs: [{ cluster: 'prod', services: ['api', 'worker', 'web', 'scheduler'] }],
    aurora: [
      {
        clusterId: 'prod-aurora',
        instances: [
          { id: 'prod-aurora-1', role: 'writer', memoryGiB: 16 },
          { id: 'prod-aurora-2', role: 'reader', memoryGiB: 16 },
        ],
      },
    ],
    lambda: [{ name: 'ingest-fn' }, { name: 'transform-fn' }, { name: 'notify-fn' }],
    kinesis: [{ stream: 'events-stream' }, { stream: 'clickstream' }],
    ec2: [{ instanceId: 'i-0123456789abcdef0', name: 'app-server' }],
    redis: [{ replicationGroupId: 'prod-redis', nodes: ['prod-redis-001', 'prod-redis-002'] }],
  },
  collectors: { alarms: { enabled: false, namePrefix: '' } },
  auth: { adminUser: 'admin', adminPasswordHash: await hashPassword(password), sessionSecret: randomBytes(32).toString('hex') },
};
writeFileSync(target, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`Wrote ${target}\nAdmin user: admin\nAdmin password (shown once): ${password}`);
