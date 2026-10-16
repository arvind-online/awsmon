import { EC2Client } from '@aws-sdk/client-ec2';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { KinesisClient } from '@aws-sdk/client-kinesis';
import { RDSClient } from '@aws-sdk/client-rds';
import type { Config } from '../../config.js';
import { awsClientConfig } from '../cloudwatch.js';
import type { ServiceCollector } from '../types.js';
import { auroraCollector } from './aurora.js';
import { ec2Collector } from './ec2.js';
import { ecsCollector } from './ecs.js';
import { kinesisCollector } from './kinesis.js';
import { lambdaCollector } from './lambda.js';
import { redisCollector } from './redis.js';

/** Real collectors implemented so far. Services not listed here stay simulated in live mode. */
export function serviceCollectors(cfg: Config): ServiceCollector[] {
  const aws = awsClientConfig(cfg);
  return [
    ecsCollector(cfg, new ECSClient(aws)),
    auroraCollector(cfg, new RDSClient(aws)),
    lambdaCollector(cfg),
    kinesisCollector(cfg, new KinesisClient(aws)),
    redisCollector(cfg, new ElastiCacheClient(aws)),
    ec2Collector(cfg, new EC2Client(aws)),
  ];
}
