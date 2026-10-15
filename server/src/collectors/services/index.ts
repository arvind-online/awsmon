import type { Config } from '../../config.js';
import type { ServiceCollector } from '../types.js';
import { KinesisClient } from '@aws-sdk/client-kinesis';
import { awsClientConfig } from '../cloudwatch.js';
import { kinesisCollector } from './kinesis.js';
import { lambdaCollector } from './lambda.js';

/** Real collectors implemented so far. Services not listed here stay simulated in live mode. */
export function serviceCollectors(cfg: Config): ServiceCollector[] {
  return [lambdaCollector(cfg), kinesisCollector(cfg, new KinesisClient(awsClientConfig(cfg)))];
}
