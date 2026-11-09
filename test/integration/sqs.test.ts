import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient, type Message,
} from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SubmitWager } from '../../src/application/submit-wager.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { InboxRecord } from '../../src/infrastructure/database/inbox-record.js';
import { OutboxRecord } from '../../src/infrastructure/database/outbox-record.js';
import { PostgresWagerStore } from '../../src/infrastructure/database/postgres-wager-store.js';
import { WageringModule } from '../../src/infrastructure/http/wagering.module.js';
import { WalletsModule } from '../../src/infrastructure/http/wallets.module.js';
import { processingMetrics } from '../../src/infrastructure/observability/processing-metrics.js';
import { WagerConsumer, WAGER_CONSUMER_NAME } from '../../src/infrastructure/sqs/wager-consumer.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;
const endpoint = process.env.FINANCIAL_TEST_SQS_ENDPOINT;
// AWS SendMessage applies these Unicode ranges to the serialized MessageBody.
const UNSUPPORTED_SQS_BODY_CHARACTER = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
type Entry = Readonly<Record<string, unknown>>;

function testSqs() {
  return new SQSClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const found = await read();
    if (found !== undefined) return found;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the SQS test condition.');
}

describe.skipIf(!databaseUrl || !endpoint)('Wager consumer on PostgreSQL and LocalStack', () => {
  const id = crypto.randomUUID().replaceAll('-', '');
  const schema = `financial_test_${id}`;
  let app: INestApplication;
  let orm: MikroORM;
  let peer: MikroORM;
  let url: string;
  let sqs: SQSClient;
  let queue: string;
  let dlq: string;

  beforeAll(async () => {
    const parsed = new URL(endpoint!);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      throw new Error('FINANCIAL_TEST_SQS_ENDPOINT must be a local HTTP LocalStack endpoint.');
    }
    const config = financialTestConfig(databaseUrl!, schema);
    @Module({ imports: [MikroOrmModule.forRoot(config), WalletsModule, WageringModule] })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
    orm = app.get(MikroORM);
    expect(await orm.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    const inboxMigration = 'Migration20261107000300_TransactionalInbox';
    await orm.migrator.up({ to: inboxMigration });
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([inboxMigration]);
    expect(await orm.em.execute('SELECT to_regclass(?) AS name', [`${schema}.inbox_messages`])).toEqual([{ name: null }]);
    expect((await orm.migrator.up({ to: inboxMigration })).map(({ name }) => name)).toEqual([inboxMigration]);
    await orm.migrator.up();
    peer = await MikroORM.init(config);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    sqs = testSqs();
    dlq = (await sqs.send(new CreateQueueCommand({
      QueueName: `test-dlq-${id}.fifo`, Attributes: { FifoQueue: 'true' },
    }))).QueueUrl!;
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
    queue = (await sqs.send(new CreateQueueCommand({
      QueueName: `test-wager-${id}.fifo`,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '60', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: 5 }) },
    }))).QueueUrl!;
  }, 15_000);

  afterAll(async () => {
    try {
      if (queue) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      if (dlq) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq }));
      if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      sqs?.destroy();
      await peer?.close();
      await app?.close();
    }
  });

  async function open(playerId: string) {
    const response = await fetch(`${url}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; playerId: string };
  }

  function envelope(wallet: { id: string; playerId: string }, id: string, kind = 'BET', amount = '20.00', reference?: string) {
    return {
      messageId: id, type: 'WagerTransactionRequested', occurredAt: '2026-01-01T00:00:00.000Z',
      data: { providerId: 'sqs-provider', externalTransactionId: id, idempotencyKey: id, playerId: wallet.playerId,
        walletId: wallet.id, roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' },
        ...(reference && { referenceExternalTransactionId: reference }) },
    };
  }

  async function send(body: ReturnType<typeof envelope> | string, group?: string) {
    return sqs.send(new SendMessageCommand({
      QueueUrl: queue, MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group ?? (typeof body === 'string' ? 'invalid' : body.data.walletId),
      MessageDeduplicationId: crypto.randomUUID(),
    }));
  }

  function http(message: ReturnType<typeof envelope>) {
    const { idempotencyKey, ...body } = message.data;
    return fetch(`${url}/wagering/transactions`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) });
  }

  function start(client = sqs, service = app.get(SubmitWager), onLog?: (entry: Entry, stop: () => void) => void) {
    const logs: Entry[] = [];
    const consumer = new WagerConsumer(client, queue, service, (entry) => {
      logs.push(entry);
      onLog?.(entry, () => consumer.stop());
    }, 1);
    const done = consumer.run();
    return {
      logs, done, stop: () => consumer.stop(),
      ack: (messageId: string) => until(() => logs.find((entry) => entry.event === 'sqs_ack' && entry.messageId === messageId)),
      async close() { consumer.stop(); await done; },
    };
  }

  async function snapshot(walletId: string) {
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, walletId);
    const wagers = await em.find(WagerTransactionRecord, { walletId });
    const ledger = await em.find(WalletLedgerEntryRecord, { walletId });
    const events = await em.find(OutboxRecord, { payload: { data: { walletId } } });
    const reconstructed = await em.execute<{ balance: string }[]>(
      `SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2) AS balance
       FROM "${schema}".wallet_ledger_entries WHERE wallet_id = ?`, [walletId],
    );
    expect(reconstructed[0]?.balance).toBe(wallet.balance);
    return { wallet, wagers, ledger, events };
  }

  function inbox(messageId: string) {
    return orm.em.fork().findOne(InboxRecord, { consumerName: WAGER_CONSUMER_NAME, messageId });
  }

  async function readDlq(): Promise<Message> {
    const message = await until(async () => (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1 }))).Messages?.[0]);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: message.ReceiptHandle }));
    return message;
  }

  test('rejects SQS-incompatible identifiers before committing over HTTP or SQS', async () => {
    const wallet = await open('sqs-invalid-identifier');
    const before = await snapshot(wallet.id);
    const message = envelope(wallet, 'invalid-identifier');
    message.data.externalTransactionId = 'external-\uFFFE';

    const response = await http(message);
    // Inspect the body the publisher would send if HTTP regresses and enqueues the event.
    const afterHttp = await snapshot(wallet.id);
    for (const event of afterHttp.events) {
      expect(JSON.stringify(event.payload)).not.toMatch(UNSUPPORTED_SQS_BODY_CHARACTER);
    }
    expect(response.status).toBe(400);
    expect(afterHttp).toEqual(before);

    const invalidPlayer = await fetch(`${url}/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'player-\uFFFF', initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(invalidPlayer.status).toBe(400);
    expect(await orm.em.fork().findOne(WalletRecord, { playerId: 'player-\uFFFF' })).toBeNull();
    expect(await orm.em.fork().count(OutboxRecord, { payload: { data: { playerId: 'player-\uFFFF' } } })).toBe(0);

    // The JSON escape travels through SQS as ASCII and decodes to U+FFFE in the consumer.
    const body = JSON.stringify(message).replaceAll('\uFFFE', '\\ufffe');
    await send(body, wallet.id);
    const worker = start();
    try {
      const delivery = await readDlq();
      expect(delivery.Body).toBe(body);
      expect(worker.logs).toContainEqual(expect.objectContaining({
        event: 'sqs_permanent_failure', reason: 'INVALID_MESSAGE', committed: false,
      }));
      expect(await inbox(message.messageId)).toBeNull();
      expect(await snapshot(wallet.id)).toEqual(before);
    } finally { await worker.close(); }
  }, 15_000);

  test('preserves Unicode identifiers and replay across HTTP and SQS', async () => {
    const wallet = await open('sqs-valid-unicode');
    const message = envelope(wallet, 'valid-unicode');
    const externalTransactionId = '  cafe\u0301-\uFFFD-\u{10000}-\u{10FFFF}-\u0001  ';
    message.data.externalTransactionId = externalTransactionId;

    const response = await http(message);
    expect(response.status).toBe(200);
    const result = await response.json();
    const before = await snapshot(wallet.id);
    const wager = before.wagers.find(({ id }) => id === result.transactionId)!;
    expect(wager.externalTransactionId).toBe(externalTransactionId);
    expect(wager.payloadHash).toBe(createHash('sha256').update(JSON.stringify({
      externalTransactionId,
      gameId: message.data.gameId,
      kind: message.data.kind,
      money: message.data.money,
      playerId: wallet.playerId,
      providerId: message.data.providerId,
      roundId: message.data.roundId,
      walletId: wallet.id,
    })).digest('hex'));
    const event = before.events.find(({ aggregateId }) => aggregateId === wager.id)!;
    expect(event.payload.data).toMatchObject({ externalTransactionId });
    expect(JSON.stringify(event.payload)).not.toMatch(UNSUPPORTED_SQS_BODY_CHARACTER);

    const worker = start();
    try {
      await send(message);
      expect(await worker.ack(message.messageId)).toMatchObject({ duplicate: true, transactionId: wager.id });
      expect(await snapshot(wallet.id)).toEqual(before);
    } finally { await worker.close(); }
  }, 15_000);

  test('bootstraps the official FIFO source and its FIFO redrive policy', async () => {
    const source = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
    const deadLetter = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions-dlq.fifo' }));
    const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: source.QueueUrl, AttributeNames: ['FifoQueue', 'RedrivePolicy'] }));
    const target = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: deadLetter.QueueUrl, AttributeNames: ['FifoQueue', 'QueueArn'] }));
    expect(attributes.Attributes?.FifoQueue).toBe('true');
    expect(target.Attributes?.FifoQueue).toBe('true');
    expect(JSON.parse(attributes.Attributes?.RedrivePolicy ?? '{}')).toEqual({ maxReceiveCount: 5, deadLetterTargetArn: target.Attributes?.QueueArn });
  });

  test('consumes BET, WIN, LOSS, REFUND and ROLLBACK with exact ledger and Outbox', async () => {
    const worker = start();
    try {
      const wallet = await open('sqs-all-kinds');
      const messages = [envelope(wallet, 'all-bet'), envelope(wallet, 'all-win', 'WIN', '5.00', 'all-bet'),
        envelope(wallet, 'all-loss', 'LOSS', '0.00'), envelope(wallet, 'all-refund', 'REFUND', '20.00', 'all-bet'),
        envelope(wallet, 'all-rollback', 'ROLLBACK', '5.00', 'all-win')];
      for (const message of messages) {
        await send(message);
        expect(await worker.ack(message.messageId)).toMatchObject({ status: 'PROCESSED', duplicate: false });
        expect(await inbox(message.messageId)).toMatchObject({ processedAt: expect.any(Date), payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      }
      const result = await snapshot(wallet.id);
      expect(result.wallet).toMatchObject({ balance: '100.00', version: 5 });
      expect(result.wagers).toHaveLength(6);
      expect(result.ledger).toHaveLength(5);
      expect(result.events).toHaveLength(11);
    } finally { await worker.close(); }
  }, 15_000);

  test('deduplicates same message, different messages and both HTTP/SQS orderings', async () => {
    const worker = start();
    try {
      const wallet = await open('sqs-dedup');
      const first = envelope(wallet, 'sqs-first');
      await send(first);
      await worker.ack(first.messageId);
      const httpReplay = await http(first);
      expect(await httpReplay.json()).toMatchObject({ idempotentReplay: true, balance: { amount: '80.00' } });
      await send(first);
      await until(() => worker.logs.find((entry) => entry.event === 'sqs_ack' && entry.messageId === first.messageId && entry.duplicate));
      await send({ ...first, messageId: 'same-operation-new-message' });
      expect(await worker.ack('same-operation-new-message')).toMatchObject({ duplicate: true });
      const second = envelope(wallet, 'http-first', 'BET', '5.00');
      expect((await http(second)).status).toBe(200);
      await send(second);
      expect(await worker.ack(second.messageId)).toMatchObject({ duplicate: true });
      const result = await snapshot(wallet.id);
      expect(result.wallet).toMatchObject({ balance: '75.00', version: 3 });
      expect(result.ledger).toHaveLength(3);
      expect(result.events).toHaveLength(6);
      expect(await orm.em.fork().count(InboxRecord, { messageId: first.messageId })).toBe(1);
    } finally { await worker.close(); }
  }, 15_000);

  test('ACKs committed business rejection and missing-reference pending operations', async () => {
    const worker = start();
    try {
      const wallet = await open('sqs-no-movement');
      const rejected = envelope(wallet, 'sqs-insufficient', 'BET', '100.01');
      const pending = envelope(wallet, 'sqs-pending', 'REFUND', '5.00', 'missing-bet');
      await send(rejected);
      await send(pending);
      expect(await worker.ack(rejected.messageId)).toMatchObject({ status: 'REJECTED' });
      expect(await worker.ack(pending.messageId)).toMatchObject({ status: 'PENDING_REFERENCE' });
      const result = await snapshot(wallet.id);
      expect(result.wallet).toMatchObject({ balance: '100.00', version: 1 });
      expect(result.ledger).toHaveLength(1);
      expect(result.events.map(({ eventType }) => eventType)).toContain('WagerTransactionPendingReference');
      expect(result.events.map(({ eventType }) => eventType)).toContain('WagerTransactionRejected');
      expect(await inbox(pending.messageId)).toMatchObject({ processedAt: expect.any(Date) });
    } finally { await worker.close(); }
  }, 15_000);

  test('recovers a valid REFUND from the legacy DLQ and deduplicates delivery after a failed ACK', async () => {
    const wrongWallet = await open('sqs-wrong-reservation');
    const owner = await open('sqs-reservation-owner');
    const source = envelope(owner, 'sqs-late-reserved-bet');
    const wrong = envelope(wrongWallet, 'sqs-wrong-refund', 'REFUND', '20.00', source.data.externalTransactionId);
    const valid = envelope(owner, 'sqs-valid-refund', 'REFUND', '20.00', source.data.externalTransactionId);
    expect((await http(wrong)).status).toBe(202);
    expect((await http(source)).status).toBe(200);

    const migration = 'Migration20261107000600_WalletScopedReversalReservations';
    expect((await orm.migrator.down({ migrations: [migration] })).map(({ name }) => name)).toEqual([migration]);
    const legacy = start();
    let body: string;
    try {
      await send(valid);
      const dead = await readDlq();
      body = dead.Body!;
      expect(body).toBe(JSON.stringify(valid));
      expect(legacy.logs).toContainEqual(expect.objectContaining({
        event: 'sqs_permanent_failure', reason: 'DUPLICATE_REFUND', committed: false,
      }));
      expect(await inbox(valid.messageId)).toBeNull();
      expect((await snapshot(owner.id)).wallet).toMatchObject({ balance: '80.00', version: 2 });
    } finally {
      await legacy.close();
      expect((await orm.migrator.up({ migrations: [migration] })).map(({ name }) => name)).toEqual([migration]);
    }

    const brokenAck = testSqs();
    brokenAck.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === 'DeleteMessageCommand') throw new Error('Simulated ACK failure');
      return next(args);
    }, { step: 'initialize' });
    const first = start(brokenAck, app.get(SubmitWager), (entry, stop) => {
      if (entry.event === 'sqs_retry') stop();
    });
    let committed: Awaited<ReturnType<typeof snapshot>>;
    try {
      await send(body, owner.id);
      const outcome = await until(() => first.logs.find((entry) => entry.event === 'sqs_retry'));
      expect(outcome).toMatchObject({ messageId: valid.messageId, committed: true });
      await first.done;
      expect(await inbox(valid.messageId)).toMatchObject({ processedAt: expect.any(Date) });
      committed = await snapshot(owner.id);
      expect(committed.wallet).toMatchObject({ balance: '100.00', version: 3 });
      expect(committed.wagers.filter(({ kind }) => kind === 'REFUND')).toEqual([
        expect.objectContaining({ status: 'PROCESSED', externalTransactionId: valid.data.externalTransactionId }),
      ]);
      expect(committed.ledger).toHaveLength(3);
      expect(committed.events).toHaveLength(6);
    } finally { await first.close(); brokenAck.destroy(); }

    const retry = start(sqs, new SubmitWager(new PostgresWagerStore(peer.em)));
    try {
      expect(await retry.ack(valid.messageId)).toMatchObject({ receiveCount: 2, duplicate: true });
      expect(await snapshot(owner.id)).toEqual(committed);
      const other = await snapshot(wrongWallet.id);
      expect(other.wallet).toMatchObject({ balance: '100.00', version: 1 });
      expect(other.wagers).toContainEqual(expect.objectContaining({ kind: 'REFUND', status: 'PENDING_REFERENCE' }));
      expect(other.ledger).toHaveLength(1);
      const dead = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1 }));
      expect(dead.Messages ?? []).toEqual([]);
    } finally { await retry.close(); }
  }, 15_000);

  test('rolls back Inbox and all effects when PostgreSQL fails at commit, then processes on redelivery', async () => {
    const wallet = await open('sqs-before-commit');
    const message = envelope(wallet, 'sqs-commit-error');
    const table = `"${schema}".outbox_messages`;
    const failure = `"${schema}".fail_sqs_commit`;
    await orm.em.execute(`CREATE FUNCTION ${failure}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced commit failure' USING ERRCODE = '40001'; END; $$`);
    await orm.em.execute(`CREATE CONSTRAINT TRIGGER fail_sqs_commit AFTER INSERT ON ${table}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.payload->'data'->>'externalTransactionId' = 'sqs-commit-error') EXECUTE FUNCTION ${failure}()`);
    const failing = start(sqs, app.get(SubmitWager), (entry, stop) => { if (entry.event === 'sqs_retry') stop(); });
    try {
      await send(message);
      await until(() => failing.logs.find((entry) => entry.event === 'sqs_retry' && entry.committed === false));
      await failing.done;
      expect(await inbox(message.messageId)).toBeNull();
      const before = await snapshot(wallet.id);
      expect(before.wallet).toMatchObject({ balance: '100.00', version: 1 });
      expect([before.wagers.length, before.ledger.length, before.events.length]).toEqual([1, 1, 2]);
    } finally {
      await failing.close();
      await orm.em.execute(`DROP TRIGGER fail_sqs_commit ON ${table}`);
      await orm.em.execute(`DROP FUNCTION ${failure}()`);
    }
    const retry = start();
    try {
      expect(await retry.ack(message.messageId)).toMatchObject({ receiveCount: 2, duplicate: false });
      expect((await snapshot(wallet.id)).wallet.balance).toBe('80.00');
    } finally { await retry.close(); }
  }, 15_000);

  test('does not repeat effects on actual redelivery after an ACK failure following commit', async () => {
    const wallet = await open('sqs-after-commit');
    const message = envelope(wallet, 'sqs-ack-error');
    const retries = /processing_retries_total\{component="sqs"\} (\d+)/;
    const duplicates = /wager_duplicates_total\{component="sqs"\} (\d+)/;
    const before = processingMetrics.render();
    const brokenAck = testSqs();
    brokenAck.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === 'DeleteMessageCommand') throw new Error('Simulated ACK failure');
      return next(args);
    }, { step: 'initialize' });
    const failing = start(brokenAck, app.get(SubmitWager), (entry, stop) => { if (entry.event === 'sqs_retry') stop(); });
    try {
      await send(message);
      const failure = await until(() => failing.logs.find((entry) => entry.event === 'sqs_retry' && entry.committed === true));
      expect(failure.correlationId).toBe(failure.transactionId);
      expect(JSON.stringify(failure)).not.toContain('Simulated ACK failure');
      expect(failure).toMatchObject({
        messageId: message.messageId, walletId: wallet.id, providerId: message.data.providerId,
        correlationId: expect.any(String), transactionId: expect.any(String),
      });
      await failing.done;
      expect(await inbox(message.messageId)).toMatchObject({ processedAt: expect.any(Date) });
      expect((await snapshot(wallet.id)).wallet.balance).toBe('80.00');
    } finally { await failing.close(); brokenAck.destroy(); }
    const retry = start();
    try {
      expect(await retry.ack(message.messageId)).toMatchObject({ receiveCount: 2, duplicate: true });
      const after = await snapshot(wallet.id);
      expect(after.wallet).toMatchObject({ balance: '80.00', version: 2 });
      expect([after.wagers.length, after.ledger.length, after.events.length]).toEqual([2, 2, 4]);
    } finally { await retry.close(); }
    const after = processingMetrics.render();
    expect(Number(retries.exec(after)![1])).toBe(Number(retries.exec(before)![1]) + 1);
    expect(Number(duplicates.exec(after)![1])).toBe(Number(duplicates.exec(before)![1]) + 1);
  }, 15_000);

  test('serializes competing BETs from two consumers on independent PostgreSQL connections', async () => {
    const first = start();
    const second = start(sqs, new SubmitWager(new PostgresWagerStore(peer.em)));
    try {
      const wallet = await open('sqs-concurrent');
      await orm.em.fork().transactional(async (tx) => {
        await tx.findOneOrFail(WalletRecord, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
        await send(envelope(wallet, 'sqs-race-a', 'BET', '80.00'), 'race-a');
        await send(envelope(wallet, 'sqs-race-b', 'BET', '80.00'), 'race-b');
        await waitForWalletLocks(tx, 2);
      });
      await until(() => [...first.logs, ...second.logs].filter(({ event }) => event === 'sqs_ack').length === 2 ? true : undefined);
      expect(first.logs.filter(({ event }) => event === 'sqs_ack')).toHaveLength(1);
      expect(second.logs.filter(({ event }) => event === 'sqs_ack')).toHaveLength(1);
      const result = await snapshot(wallet.id);
      expect(result.wallet).toMatchObject({ balance: '20.00', version: 2 });
      expect(result.ledger).toHaveLength(2);
      expect(result.wagers.filter(({ status }) => status === 'REJECTED')).toHaveLength(1);
    } finally { await Promise.all([first.close(), second.close()]); }
  }, 15_000);

  test('redrives invalid messages, envelope conflicts and wager identity conflicts to the DLQ', async () => {
    const worker = start();
    try {
      const wallet = await open('sqs-invalid');
      const original = envelope(wallet, 'sqs-original');
      await send(original);
      await worker.ack(original.messageId);
      for (const [body, reason] of [
        ['{not-json', 'INVALID_MESSAGE'],
        [envelope(wallet, 'sqs-external-opening', 'OPENING'), 'INVALID_MESSAGE'],
        [{ ...original, occurredAt: '2026-01-02T00:00:00.000Z' }, 'INBOX_PAYLOAD_CONFLICT'],
        [{ ...original, messageId: 'sqs-identity-conflict', data: { ...original.data, money: { amount: '21.00', currency: 'BRL' } } },
          'WAGER_IDENTITY_CONFLICT'],
      ] as const) {
        const offset = worker.logs.length;
        await send(body);
        const dead = await readDlq();
        expect(dead.Body).toBe(typeof body === 'string' ? body : JSON.stringify(body));
        expect(worker.logs.slice(offset).filter((entry) => entry.event === 'sqs_permanent_failure' && entry.reason === reason)).toHaveLength(5);
      }
      expect(await inbox('sqs-identity-conflict')).toBeNull();
      const result = await snapshot(wallet.id);
      expect(result.wallet).toMatchObject({ balance: '80.00', version: 2 });
      expect([result.wagers.length, result.ledger.length, result.events.length]).toEqual([2, 2, 4]);
    } finally { await worker.close(); }
  }, 20_000);

  test('stops polling and drains the in-flight transaction and ACK during shutdown', async () => {
    const wallet = await open('sqs-shutdown');
    const first = envelope(wallet, 'sqs-shutdown-inflight');
    const next = envelope(wallet, 'sqs-shutdown-next');
    const worker = start();
    let finished = false;
    void worker.done.then(() => { finished = true; });
    try {
      await orm.em.fork().transactional(async (tx) => {
        await tx.findOneOrFail(WalletRecord, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
        await send(first);
        await waitForWalletLocks(tx, 1);
        worker.stop();
        await send(next);
        expect(finished).toBe(false);
      });
      await worker.done;
      expect(await worker.ack(first.messageId)).toMatchObject({ status: 'PROCESSED' });
      expect(await inbox(next.messageId)).toBeNull();
      expect((await snapshot(wallet.id)).wallet.balance).toBe('80.00');
      const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 1 }));
      expect(received.Messages?.[0]?.Body).toBe(JSON.stringify(next));
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: received.Messages?.[0]?.ReceiptHandle }));
    } finally { await worker.close(); }
  }, 15_000);

  async function waitForWalletLocks(tx: MikroORM['em'], expected: number) {
    await until(async () => {
      await tx.execute('SELECT pg_stat_clear_snapshot()');
      const [row] = await tx.execute<{ waiting: number }[]>(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%${schema}%wallets%for update%'`);
      return row?.waiting === expected ? true : undefined;
    });
  }
});
