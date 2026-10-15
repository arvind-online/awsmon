import type { Config } from '../../config.js';
import type { ServiceCollector } from '../types.js';
import { RDSClient } from '@aws-sdk/client-rds';
import { ECSClient } from '@aws-sdk/client-ecs';
import { KinesisClient } from '@aws-sdk/client-kinesis';
import { awsClientConfig } from '../cloudwatch.js';
import { auroraCollector } from './aurora.js';
import { ecsCollector } from './ecs.js';
import { kinesisCollector } from './kinesis.js';
import { lambdaCollector } from './lambda.js';

/** Real collectors implemented so far. Services not listed here stay simulated in live mode. */
export function serviceCollectors(cfg: Config): ServiceCollector[] {
  return [auroraCollector(cfg, new RDSClient(awsClientConfig(cfg))), ecsCollector(cfg, new ECSClient(awsClientConfig(cfg))), lambdaCollector(cfg), kinesisCollector(cfg, new KinesisClient(awsClientConfig(cfg)))];
}
