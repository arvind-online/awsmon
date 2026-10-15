import { ConfigSchema } from '../server/src/config.js';
import { serviceCollectors } from '../server/src/collectors/services/index.js';

// Least-privilege read-only policy for the collectors implemented so far.
const actions = [...new Set(serviceCollectors(ConfigSchema.parse({})).flatMap((s) => s.iamActions))].sort();
console.log(JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'AwsMonitorReadOnly', Effect: 'Allow', Action: actions, Resource: '*' }] }, null, 2));
