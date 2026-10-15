import type { Config } from '../config.js';
import { MockCollector } from './mock.js';
import type { Collector } from './types.js';

export function createCollector(cfg: Config): Collector {
  if (cfg.mode === 'mock') return new MockCollector(cfg);
  // Phase 2: real CloudWatch/ECS/RDS/Kinesis/ElastiCache collectors.
  throw new Error('AWS mode is not implemented yet (phase 2). Use mode "mock".');
}
