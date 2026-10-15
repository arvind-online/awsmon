import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const stringList = z.array(z.string().min(1).max(256)).max(100);

export const ConfigSchema = z.object({
  /** "mock" generates simulated data (phase 1). "aws" will use real collectors. */
  mode: z.enum(['mock', 'aws']).default('mock'),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8080),
      /** Extra browser origins allowed for WebSocket/API (e.g. the Vite dev server). */
      allowedOrigins: z.array(z.string()).default([]),
      /** Set true when served over HTTPS so cookies get the Secure flag. */
      secureCookies: z.boolean().default(false),
      /** Trust X-Forwarded-For from a proxy/ALB so per-client limits see real client IPs. Only behind a proxy. */
      trustProxy: z.boolean().default(false),
      /** Cap on concurrent WebSocket display clients. */
      maxClients: z.number().int().min(1).max(1000).default(50),
    })
    .prefault({}),
  aws: z
    .object({
      region: z.string().default('ap-south-1'),
      profile: z.string().optional(),
      /** "statistics" = GetMetricStatistics (free tier eligible); "data" = batched GetMetricData (always billed). Only "statistics" is implemented. */
      metricsApi: z.enum(['statistics', 'data']).default('statistics'),
    })
    .prefault({}),
  resources: z
    .object({
      ecs: z.array(z.object({ cluster: z.string(), services: stringList })).default([]),
      aurora: z
        .array(
          z.object({
            /** Aurora cluster the instances belong to. Leave out for standalone RDS instances. */
            clusterId: z.string().optional(),
            instances: z.array(z.object({ id: z.string(), role: z.enum(['writer', 'reader', 'standalone']).default('standalone'), memoryGiB: z.number().positive().optional() })),
          }),
        )
        .default([]),
      lambda: z.array(z.object({ name: z.string() })).default([]),
      kinesis: z.array(z.object({ stream: z.string() })).default([]),
      redis: z.array(z.object({ replicationGroupId: z.string(), nodes: stringList })).default([]),
    })
    .prefault({}),
  collectors: z.object({ alarms: z.object({ enabled: z.boolean().default(false), namePrefix: z.string().default('') }).prefault({}) }).prefault({}),
  auth: z
    .object({
      adminUser: z.string().min(1).default('admin'),
      /** scrypt hash; generate with `npm run hash-password`. */
      adminPasswordHash: z.string().default(''),
      sessionSecret: z.string().default(''),
      sessionHours: z.number().positive().default(12),
    })
    .prefault({}),
  /** Seed values for runtime-editable settings. Validated by the settings schema. */
  settings: z.record(z.string(), z.unknown()).default({}),
  dataDir: z.string().default('./data'),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Layering: defaults < config.json < environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // npm workspaces run with cwd = server/, so also look one level up for the repo-root config.
  const path = env.MONITOR_CONFIG
    ? resolve(env.MONITOR_CONFIG)
    : [resolve('./config.json'), resolve('../config.json')].find((p) => existsSync(p)) ?? resolve('./config.json');
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  }
  const cfg = ConfigSchema.parse(raw);
  if (env.MONITOR_MODE) cfg.mode = z.enum(['mock', 'aws']).parse(env.MONITOR_MODE);
  if (env.MONITOR_HOST) cfg.server.host = env.MONITOR_HOST;
  if (env.MONITOR_PORT) cfg.server.port = z.coerce.number().int().min(1).max(65535).parse(env.MONITOR_PORT);
  if (env.MONITOR_REGION) cfg.aws.region = env.MONITOR_REGION;
  if (env.MONITOR_ADMIN_USER) cfg.auth.adminUser = env.MONITOR_ADMIN_USER;
  if (env.MONITOR_ADMIN_PASSWORD_HASH) cfg.auth.adminPasswordHash = env.MONITOR_ADMIN_PASSWORD_HASH;
  if (env.MONITOR_SESSION_SECRET) cfg.auth.sessionSecret = env.MONITOR_SESSION_SECRET;
  if (env.MONITOR_DATA_DIR) cfg.dataDir = env.MONITOR_DATA_DIR;
  if (env.MONITOR_TRUST_PROXY) cfg.server.trustProxy = env.MONITOR_TRUST_PROXY === 'true';
  // Relative data dirs are relative to the config file, not the process cwd.
  cfg.dataDir = resolve(dirname(path), cfg.dataDir);
  return cfg;
}
