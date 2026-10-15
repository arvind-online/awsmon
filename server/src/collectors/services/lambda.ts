import type { Config } from '../../config.js';
import { buildGroup, item, metric } from '../build.js';
import type { ServiceCollector } from '../types.js';

const PER = '5 min';
const NS = 'AWS/Lambda';

/** Lambda is read through CloudWatch only: ListFunctions would expose environment variables, which can hold secrets. */
export function lambdaCollector(cfg: Config): ServiceCollector {
  return {
    type: 'lambda',
    title: 'Lambda',
    iamActions: ['cloudwatch:GetMetricStatistics'],
    async collect({ cw }) {
      const items = await Promise.all(
        cfg.resources.lambda.map(async (fn) => {
          const dimensions = { FunctionName: fn.name };
          const [inv, err, thr, dur] = await Promise.all([
            cw.series({ namespace: NS, metricName: 'Invocations', dimensions, stat: 'Sum', fillZero: true }),
            cw.series({ namespace: NS, metricName: 'Errors', dimensions, stat: 'Sum', fillZero: true }),
            cw.series({ namespace: NS, metricName: 'Throttles', dimensions, stat: 'Sum', fillZero: true }),
            cw.series({ namespace: NS, metricName: 'Duration', dimensions, stat: 'Average' }),
          ]);
          const active = inv.some(([, v]) => v > 0);
          return item(fn.name, fn.name, 'function', active ? 'active' : 'idle (no invocations in 3 h)', 'OK', [
            metric('inv', 'Invocations', 'count', inv, { per: PER }),
            metric('err', 'Errors', 'count', err, { warn: 5, crit: 20, bad: 'high', per: PER }),
            metric('thr', 'Throttles', 'count', thr, { warn: 3, crit: 10, bad: 'high', per: PER }),
            metric('dur', 'Duration', 'ms', dur),
          ]);
        }),
      );
      return buildGroup('lambda', 'Lambda', items);
    },
  };
}
