import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { postgresConfig } from '../database/mikro-orm.config.js';
import { OutboxPublisher } from './outbox-publisher.js';

function positiveInteger(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}.`);
  return value;
}

const options = {
  batchSize: positiveInteger('OUTBOX_BATCH_SIZE', 10, 100),
  pollIntervalMs: positiveInteger('OUTBOX_POLL_INTERVAL_MS', 1000, 3_600_000),
  retryBaseMs: positiveInteger('OUTBOX_RETRY_BASE_MS', 1000, 3_600_000),
  retryMaxMs: positiveInteger('OUTBOX_RETRY_MAX_MS', 60_000, 86_400_000),
};
if (options.retryMaxMs < options.retryBaseMs) throw new Error('OUTBOX_RETRY_MAX_MS must be at least OUTBOX_RETRY_BASE_MS.');

const orm = await MikroORM.init(postgresConfig);
const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT,
  region: process.env.AWS_REGION ?? 'us-east-1',
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 3000, requestTimeout: 5000, throwOnRequestTimeout: true },
});
try {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.OUTBOX_QUEUE_NAME ?? 'wagering-events.fifo' }));
  if (!QueueUrl) throw new Error('SQS did not return the Outbox destination URL.');
  const publisher = new OutboxPublisher(orm.em, sqs, QueueUrl, options);
  const stop = () => publisher.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await publisher.run();
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
} finally {
  sqs.destroy();
  await orm.close();
}
