import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { SubmitWager } from '../../src/application/submit-wager.js';
import { PostgresWagerStore } from '../../src/infrastructure/database/postgres-wager-store.js';
import { WagerConsumer } from '../../src/infrastructure/sqs/wager-consumer.js';
import { financialTestConfig } from '../integration/financial-test-config.js';

const [schema, mode] = Bun.argv.slice(2);
if (!process.send || !/^financial_test_[a-f0-9]{32}$/.test(schema) || (mode !== 'block-ack' && mode !== 'recover')) {
  throw new Error('This consumer fixture requires test IPC, a private test schema and a valid mode.');
}

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;
const endpoint = process.env.FINANCIAL_TEST_SQS_ENDPOINT;
if (!databaseUrl || !endpoint) throw new Error('Missing financial test configuration.');
const config = financialTestConfig(databaseUrl, schema);
const parsedEndpoint = new URL(endpoint);
if (parsedEndpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsedEndpoint.hostname) ||
    !['127.0.0.1', 'localhost'].includes(config.host)) {
  throw new Error('The consumer fixture requires local PostgreSQL and LocalStack.');
}

const stopOnDisconnect = () => process.exit(1);
process.once('disconnect', stopOnDisconnect);
const sqs = new SQSClient({
  endpoint, region: 'us-east-1', maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  requestHandler: { connectionTimeout: 1000, requestTimeout: 2500, throwOnRequestTimeout: true },
});

if (mode === 'block-ack') {
  sqs.middlewareStack.add((next, context) => async (args) => {
    if (context.commandName === 'DeleteMessageCommand') {
      process.send!({ event: 'before_ack', pid: process.pid });
      // Park before serialization and transport. The parent kills this process without releasing the gate.
      await new Promise<never>(() => {});
    }
    return next(args);
  }, { step: 'initialize' });
}

let orm: MikroORM | undefined;
try {
  orm = await MikroORM.init(config);
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: `crash-wager-${schema.slice('financial_test_'.length)}.fifo` }));
  if (!QueueUrl) throw new Error('Missing isolated test queue.');

  const consumer = new WagerConsumer(sqs, QueueUrl, new SubmitWager(new PostgresWagerStore(orm.em)), (entry) => {
    if (entry.event !== 'sqs_ack') return;
    process.send!({
      event: 'sqs_ack', pid: process.pid, messageId: entry.messageId,
      receiveCount: entry.receiveCount, duplicate: entry.duplicate,
    });
    consumer.stop();
  }, 1);
  await consumer.run();
} finally {
  sqs.destroy();
  await orm?.close();
  process.removeListener('disconnect', stopOnDisconnect);
  process.disconnect?.();
}
