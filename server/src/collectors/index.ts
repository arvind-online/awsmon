import type { GroupType } from '../../../shared/types.js';
import type { Config } from '../config.js';
import { createCloudWatchClient } from './cloudwatch.js';
import { LiveCollector } from './live.js';
import { MockCollector } from './mock.js';
import { serviceCollectors } from './services/index.js';
import type { CollectContext, CollectResult, Collector } from './types.js';

/** Picks simulated or live data on every poll from the admin "data source" setting. */
class SwitchingCollector implements Collector {
  private live?: LiveCollector;

  constructor(
    private readonly cfg: Config,
    private readonly mock: MockCollector,
  ) {}

  private collector(ctx: CollectContext): Collector {
    if (ctx.settings.dataSource !== 'live') return this.mock;
    this.live ??= new LiveCollector(createCloudWatchClient(this.cfg), serviceCollectors(this.cfg), this.mock);
    return this.live;
  }

  collect(ctx: CollectContext): Promise<CollectResult> {
    return this.collector(ctx).collect(ctx);
  }

  collectGroup(type: GroupType, ctx: CollectContext): Promise<CollectResult> {
    return this.collector(ctx).collectGroup(type, ctx);
  }
}

export function createCollector(cfg: Config): Collector {
  return new SwitchingCollector(cfg, new MockCollector(cfg));
}
