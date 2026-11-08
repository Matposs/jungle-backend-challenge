import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient, type Message, type SendMessageCommandInput,
} from '@aws-sdk/client-sqs';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OpenWallet } from '../../src/application/open-wallet.js';
import { SubmitWager } from '../../src/application/submit-wager.js';
import type { IntegrationEventEnvelope } from '../../src/domain/integration-events.js';
import { Money } from '../../src/domain/money.js';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction.js';
import { OutboxRecord } from '../../src/infrastructure/database/outbox-record.js';
import { PostgresWagerStore } from '../../src/infrastructure/database/postgres-wager-store.js';
import { PostgresWalletOpeningStore } from '../../src/infrastructure/database/postgres-wallet-opening-store.js';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;
const endpoint = process.env.FINANCIAL_TEST_SQS_ENDPOINT;
const options = { batchSize: 10, pollIntervalMs: 20, retryBaseMs: 1000, retryMaxMs: 2000 };

function client() {
  return new SQSClient({ endpoint, region: 'us-east-1', maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
}

function captureSends(sqs: SQSClient, observe: (input: SendMessageCommandInput) => void | Promise<void>) {
  sqs.middlewareStack.add((next, context) => async (args) => {
    if (context.commandName === 'SendMessageCommand') await observe(args.input as SendMessageCommandInput);
    return next(args);
  }, { step: 'initialize' });
}

describe.skipIf(!databaseUrl || !endpoint)('Outbox publisher on PostgreSQL and LocalStack', () => {
  const id = crypto.randomUUID().replaceAll('-', '');
  const schema = `financial_test_${id}`;
  const table = `"${schema}".outbox_messages`;
  const publicationMigration = 'Migration20261107000400_OutboxPublication';
  const queues: string[] = [];
  let orm: MikroORM;
  let peer: MikroORM;
  let sqs: SQSClient;
  let queue: string;

  async function createQueue(name: string) {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }));
    if (!QueueUrl) throw new Error('Missing test queue URL.');
    queues.push(QueueUrl);
    return QueueUrl;
  }

  async function seed(em: EntityManager, eventId: string, aggregateId = eventId, version = 1) {
    const payload = {
      eventId, aggregateId, eventType: 'WalletBalanceChanged', correlationId: eventId, occurredAt: '2026-01-01T00:00:00.000Z',
      version: 1, data: { walletVersion: version },
    };
    await em.execute(`INSERT INTO ${table} (id, aggregate_id, event_type, occurred_at, payload) VALUES (?, ?, ?, ?, ?::jsonb)`,
      [eventId, aggregateId, payload.eventType, payload.occurredAt, JSON.stringify(payload)]);
  }

  function row(eventId: string) {
    return orm.em.fork().findOneOrFail(OutboxRecord, eventId);
  }

  function publisher(em = orm.em, transport = sqs, destination = queue, batchSize = options.batchSize) {
    return new OutboxPublisher(em, transport, destination, { ...options, batchSize }, () => {});
  }

  async function receive(count: number, destination = queue): Promise<Message[]> {
    const messages: Message[] = [];
    const deadline = Date.now() + 5000;
    while (messages.length < count && Date.now() < deadline) {
      const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: destination, WaitTimeSeconds: 1,
        MaxNumberOfMessages: 10, MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'] }));
      for (const message of result.Messages ?? []) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: destination, ReceiptHandle: message.ReceiptHandle }));
        messages.push(message);
      }
    }
    expect(messages).toHaveLength(count);
    return messages;
  }

  function body(message: Message): IntegrationEventEnvelope<object> {
    return JSON.parse(message.Body ?? '') as IntegrationEventEnvelope<object>;
  }

  beforeAll(async () => {
    const parsed = new URL(endpoint!);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      throw new Error('FINANCIAL_TEST_SQS_ENDPOINT must be a local HTTP LocalStack endpoint.');
    }
    const config = financialTestConfig(databaseUrl!, schema);
    orm = await MikroORM.init(config);
    expect(await orm.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    await orm.migrator.up({ to: 'Migration20261107000300_TransactionalInbox' });
    // Historical rows have the same timestamp and IDs that sort in the opposite order.
    await seed(orm.em, 'historical-a-v2', 'historical', 2);
    await seed(orm.em, 'historical-z-v1', 'historical', 1);
    expect((await orm.migrator.up()).map(({ name }) => name)).toEqual([publicationMigration]);
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([publicationMigration]);
    expect(await orm.em.execute(`SELECT id FROM ${table} ORDER BY id`)).toEqual([{ id: 'historical-a-v2' }, { id: 'historical-z-v1' }]);
    expect((await orm.migrator.up()).map(({ name }) => name)).toEqual([publicationMigration]);
    peer = await MikroORM.init(config);
    sqs = client();
    queue = await createQueue(`outbox-${id}.fifo`);
  }, 15_000);

  afterAll(async () => {
    try {
      for (const QueueUrl of queues) await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      sqs?.destroy();
      await peer?.close();
      await orm?.close();
    }
  });

  test('provisions the official FIFO and preserves historical wallet version order through migration', async () => {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wagering-events.fifo' }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['FifoQueue'] }));
    expect(Attributes?.FifoQueue).toBe('true');
    await seed(orm.em, 'new-v3', 'historical', 3);
    const worker = publisher();
    for (const _ of [1, 2, 3]) expect(await worker.publishBatch()).toBe(1);
    const messages = await receive(3);
    expect(messages.map((message) => body(message).eventId)).toEqual(['historical-z-v1', 'historical-a-v2', 'new-v3']);
  });

  test('publishes all four financial event types with their unchanged envelopes and records confirmations', async () => {
    const wallet = await new OpenWallet(new PostgresWalletOpeningStore(orm.em)).execute('publisher-wallet', Money.from({ amount: '100.00', currency: 'BRL' }));
    const submit = (em: EntityManager, id: string, kind: Kind.Bet | Kind.Win, referenceExternalTransactionId?: string) =>
      new SubmitWager(new PostgresWagerStore(em)).execute({
        idempotencyKey: id, externalTransactionId: id, kind, providerId: 'publisher-provider', playerId: wallet.playerId,
        walletId: wallet.id, roundId: 'round', gameId: 'game', referenceExternalTransactionId,
        money: Money.from({ amount: '80.00', currency: 'BRL' }),
      });
    await Promise.all([submit(orm.em, 'competing-first', Kind.Bet), submit(peer.em, 'competing-second', Kind.Bet)]);
    await submit(orm.em, 'pending-win', Kind.Win, 'absent-bet');
    const records = await orm.em.fork().find(OutboxRecord, {});
    const events = records.filter(({ payload }) => 'walletId' in payload.data && payload.data.walletId === wallet.id);
    expect(events).toHaveLength(6);
    expect(events.map(({ eventType }) => eventType).sort()).toEqual([
      'WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WagerTransactionProcessed',
      'WagerTransactionRejected', 'WalletBalanceChanged', 'WalletBalanceChanged',
    ]);
    const worker = publisher();
    let published = 0;
    while (published < events.length) {
      const count = await worker.publishBatch();
      if (!count) break;
      published += count;
    }
    expect(published).toBe(events.length);
    const messages = await receive(events.length);
    for (const message of messages) {
      const payload = body(message);
      const stored = events.find(({ id }) => id === payload.eventId);
      if (!stored) throw new Error(`Unexpected published event ${payload.eventId}.`);
      expect(payload).toEqual(stored.payload);
      expect(message.Attributes?.MessageGroupId).toBe(payload.aggregateId);
      expect(message.Attributes?.MessageDeduplicationId).toBe(payload.eventId);
      expect(await row(payload.eventId)).toMatchObject({ attempts: 1, publishedAt: expect.any(Date) });
    }
    expect(messages.map(body).filter(({ eventType }) => eventType === 'WalletBalanceChanged').map(({ data }) => data))
      .toEqual([expect.objectContaining({ walletVersion: 1, balanceAfter: { amount: '100.00', currency: 'BRL' } }),
        expect.objectContaining({ walletVersion: 2, balanceAfter: { amount: '20.00', currency: 'BRL' } })]);
  });

  test('does not select an Outbox row before its financial transaction commits', async () => {
    const worker = publisher(peer.em);
    await orm.em.fork().transactional(async (tx) => {
      await seed(tx, 'uncommitted-event');
      expect(await worker.publishBatch()).toBe(0);
    });
    expect(await worker.publishBatch()).toBe(1);
    expect(body((await receive(1))[0]!).eventId).toBe('uncommitted-event');
  });

  test('skips a locked aggregate head and publishes a different aggregate through another connection', async () => {
    await seed(orm.em, 'first-locked', 'shared-aggregate');
    await seed(orm.em, 'second-locked', 'shared-aggregate');
    await seed(orm.em, 'third-independent');
    const transport = client();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    captureSends(transport, async () => { entered.resolve(); await release.promise; });
    const first = publisher(orm.em, transport, queue, 1).publishBatch();
    try {
      await entered.promise;
      expect(await publisher(peer.em).publishBatch()).toBe(1);
      expect((await row('third-independent')).publishedAt).toBeInstanceOf(Date);
      expect((await row('second-locked')).publishedAt ?? null).toBeNull();
    } finally {
      release.resolve();
      await first;
      transport.destroy();
    }
    expect(await publisher(peer.em).publishBatch()).toBe(1);
    const messages = await receive(3);
    expect(messages.map(body).filter(({ aggregateId }) => aggregateId === 'shared-aggregate').map(({ eventId }) => eventId))
      .toEqual(['first-locked', 'second-locked']);
  }, 10_000);

  test('schedules capped exponential retry after a real SQS failure and recovers when the queue is available', async () => {
    const eventId = 'retry-event';
    await seed(orm.em, eventId);
    const name = `outbox-recovery-${id}.fifo`;
    const missing = new URL(queue);
    missing.pathname = missing.pathname.replace(/[^/]+$/, name);
    const failing = publisher(orm.em, sqs, missing.href);
    let previous = 0;
    for (const [attempts, backoff] of [[1, 1000], [2, 2000], [3, 2000]] as const) {
      const started = Date.now();
      expect(await failing.publishBatch()).toBe(1);
      const record = await row(eventId);
      expect(record).toMatchObject({ attempts, lastErrorCode: expect.any(String) });
      expect(record.publishedAt ?? null).toBeNull();
      expect(record.failedAt ?? null).toBeNull();
      const next = record.nextAttemptAt!.getTime();
      expect(next).toBeGreaterThanOrEqual(Math.max(started + backoff, previous));
      expect(next).toBeLessThanOrEqual(Date.now() + backoff);
      expect(await failing.publishBatch()).toBe(0);
      previous = next;
      await orm.em.execute(`UPDATE ${table} SET next_attempt_at = now() WHERE id = ?`, [eventId]);
    }
    const destination = await createQueue(name);
    expect(await publisher(peer.em, sqs, destination).publishBatch()).toBe(1);
    expect(body((await receive(1, destination))[0]!).eventId).toBe(eventId);
    expect(await row(eventId)).toMatchObject({ attempts: 4, publishedAt: expect.any(Date) });
  }, 12_000);

  test('resends with the same identity after real SQS acceptance followed by PostgreSQL commit failure', async () => {
    const eventId = 'post-send-failure';
    await seed(orm.em, eventId);
    const triggerFunction = `"${schema}".fail_publication_commit`;
    await orm.em.execute(`CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced publication commit failure'; END; $$`);
    await orm.em.execute(`CREATE CONSTRAINT TRIGGER fail_publication_commit AFTER UPDATE ON ${table}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.id = 'post-send-failure' AND NEW.published_at IS NOT NULL) EXECUTE FUNCTION ${triggerFunction}()`);
    const transport = client();
    const requests: SendMessageCommandInput[] = [];
    captureSends(transport, (request) => { requests.push(request); });
    try {
      try {
        await expect(publisher(orm.em, transport).publishBatch()).rejects.toThrow('forced publication commit failure');
        const record = await row(eventId);
        expect(record.attempts).toBe(0);
        expect(record.publishedAt ?? null).toBeNull();
        expect(body((await receive(1))[0]!).eventId).toBe(eventId);
      } finally {
        await orm.em.execute(`DROP TRIGGER fail_publication_commit ON ${table}`);
        await orm.em.execute(`DROP FUNCTION ${triggerFunction}()`);
      }
      expect(await publisher(peer.em, transport).publishBatch()).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[0]?.MessageDeduplicationId).toBe(eventId);
      expect((await row(eventId)).publishedAt).toBeInstanceOf(Date);
      const duplicates = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 1 }));
      expect(duplicates.Messages ?? []).toHaveLength(0);
    } finally { transport.destroy(); }
  }, 12_000);

  test('records a permanent message failure and keeps its aggregate successors blocked', async () => {
    await seed(orm.em, 'permanent-invalid', 'permanent-aggregate');
    await seed(orm.em, 'permanent-successor', 'permanent-aggregate');
    const transport = client();
    captureSends(transport, () => { throw Object.assign(new Error('Invalid test message'), { name: 'InvalidMessageContents' }); });
    try {
      expect(await publisher(orm.em, transport).publishBatch()).toBe(1);
      const failed = await row('permanent-invalid');
      expect(failed).toMatchObject({ attempts: 1, failedAt: expect.any(Date), lastErrorCode: 'InvalidMessageContents' });
      expect(failed.publishedAt ?? null).toBeNull();
      expect(await publisher(peer.em).publishBatch()).toBe(0);
      expect((await row('permanent-successor')).attempts).toBe(0);
    } finally { transport.destroy(); }
  });

  test('drains the active batch on shutdown without starting the next batch', async () => {
    await seed(orm.em, 'shutdown-current', 'shutdown-aggregate');
    await seed(orm.em, 'shutdown-next', 'shutdown-aggregate');
    const transport = client();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    captureSends(transport, async () => { entered.resolve(); await release.promise; });
    const worker = publisher(orm.em, transport, queue, 1);
    const done = worker.run();
    try {
      await entered.promise;
      worker.stop();
      expect((await row('shutdown-current')).publishedAt ?? null).toBeNull();
    } finally {
      worker.stop();
      release.resolve();
      await done;
      transport.destroy();
    }
    expect((await row('shutdown-current')).publishedAt).toBeInstanceOf(Date);
    expect((await row('shutdown-next')).publishedAt ?? null).toBeNull();
    expect(await publisher(peer.em).publishBatch()).toBe(1);
    expect((await receive(2)).map((message) => body(message).eventId)).toEqual(['shutdown-current', 'shutdown-next']);
  }, 10_000);
});
