import type { Config } from '../../config.js';
import type { ServiceCollector } from '../types.js';
import { lambdaCollector } from './lambda.js';

/** Real collectors implemented so far. Services not listed here stay simulated in live mode. */
export function serviceCollectors(cfg: Config): ServiceCollector[] {
  return [lambdaCollector(cfg)];
}
