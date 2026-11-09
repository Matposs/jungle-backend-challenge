import 'reflect-metadata';
import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { HealthController } from '../../src/infrastructure/http/health.controller.js';
import { WageringModule } from '../../src/infrastructure/http/wagering.module.js';
import { WalletsModule } from '../../src/infrastructure/http/wallets.module.js';
import { DependencyObservability } from '../../src/infrastructure/observability/dependency-observability.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;
const endpoint = process.env.FINANCIAL_TEST_SQS_ENDPOINT;

describe.skipIf(!databaseUrl || !endpoint)('Health and observability on PostgreSQL and LocalStack', () => {
  const id = crypto.randomUUID().replaceAll('-', '');
  const schema = `financial_test_${id}`;
  const queues = { wager: `observability-wager-${id}.fifo`, dlq: `observability-dlq-${id}.fifo`, outbox: `observability-outbox-${id}.fifo` };
  const queueUrls: string[] = [];
  const sockets = new Set<Socket>();
  let postgresAvailable = false;
  let relay: ReturnType<typeof createServer> | undefined;
  let app: INestApplication;
  let orm: MikroORM;
  let probeOrm: MikroORM;
  let sqs: SQSClient;
  let dlq: string;
  let url: string;

  async function createQueue(name: string) {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }));
    if (!QueueUrl) throw new Error('Missing test queue URL.');
    queueUrls.push(QueueUrl);
    return QueueUrl;
  }

  beforeAll(async () => {
    const parsed = new URL(endpoint!);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      throw new Error('Use a local HTTP LocalStack endpoint.');
    }
    const config = { ...financialTestConfig(databaseUrl!, schema), pool: { min: 0, max: 1 } };
    sqs = new SQSClient({
      endpoint, region: 'us-east-1', maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await createQueue(queues.wager);
    dlq = await createQueue(queues.dlq);

    relay = createServer((client) => {
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      if (!postgresAvailable) {
        client.end();
        return;
      }
      const upstream = createConnection({ host: config.host, port: config.port });
      client.pipe(upstream).pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    probeOrm = await MikroORM.init({ ...config, host: '127.0.0.1', port: (relay.address() as AddressInfo).port });

    @Global()
    @Module({
      providers: [{ provide: DependencyObservability, useValue: new DependencyObservability(probeOrm.em, sqs, queues) }],
      exports: [DependencyObservability],
    })
    class TestObservabilityModule {}

    @Module({
      imports: [MikroOrmModule.forRoot(config), TestObservabilityModule, WalletsModule, WageringModule],
      controllers: [HealthController],
    })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
    orm = app.get(MikroORM);
    expect(await orm.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    await orm.migrator.up();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }, 15_000);

  afterAll(async () => {
    try {
      for (const QueueUrl of queueUrls) await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      try {
        await app?.close();
        await probeOrm?.close();
      } finally {
        sqs?.destroy();
        for (const socket of sockets) socket.destroy();
        if (relay?.listening) await new Promise<void>((resolve) => relay!.close(() => resolve()));
      }
    }
  });

  function request(path: string, body?: object, key?: string) {
    return fetch(`${url}${path}`, {
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
      headers: { ...(body && { 'content-type': 'application/json' }), ...(key && { 'Idempotency-Key': key }) },
      signal: AbortSignal.timeout(4000),
    });
  }

  async function readiness(status: number, postgres: boolean, sqs: boolean) {
    const response = await request('/health/ready');
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ status: status === 200 ? 'ok' : 'unavailable', checks: { postgres, sqs } });
  }

  async function metrics() {
    const response = await request('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    return response.text();
  }

  function sample(text: string, key: string) {
    const line = text.split('\n').find((item) => item.startsWith(`${key} `));
    if (!line) throw new Error(`Missing metric sample ${key}`);
    return Number(line.slice(key.length + 1));
  }

  async function open() {
    const response = await request('/wallets', {
      playerId: `private-player-${crypto.randomUUID()}`, initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; playerId: string };
  }

  function bet(wallet: { id: string; playerId: string }, externalTransactionId: string) {
    return {
      providerId: 'observability-provider', externalTransactionId, walletId: wallet.id, playerId: wallet.playerId,
      roundId: 'private-round', gameId: 'private-game', kind: 'BET', money: { amount: '23.47', currency: 'BRL' },
    };
  }

  test('keeps liveness independent and returns readiness only after PostgreSQL and every queue recover', async () => {
    const live = await request('/health/live');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    await readiness(503, false, false);

    const partial = await metrics();
    expect(sample(partial, 'postgres_metrics_up')).toBe(0);
    expect(sample(partial, 'sqs_metrics_up')).toBe(1);
    expect(partial).not.toContain('wager_transactions{');
    expect(sample(partial, 'wallet_reconciliation_divergences_total')).toBe(0);

    await createQueue(queues.outbox);
    await readiness(503, false, true);
    postgresAvailable = true;
    await readiness(200, true, true);
  });

  test('exposes committed status, DLQ depth, Outbox lag, duplicate and latency metrics with safe HTTP logs', async () => {
    const wallet = await open();
    const before = await metrics();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const body = bet(wallet, 'private-external-id');
      const accepted = await request('/wagering/transactions', body, 'private-idempotency-key');
      expect(accepted.status).toBe(200);
      const { transactionId } = await accepted.json() as { transactionId: string };
      const replay = await request('/wagering/transactions', body, 'private-idempotency-key');
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ transactionId, idempotentReplay: true });
      expect((await request('/wagering/transactions', {
        ...body, externalTransactionId: 'pending', kind: 'WIN', referenceExternalTransactionId: 'missing',
      }, 'pending')).status).toBe(202);
      expect((await request('/wagering/transactions', {
        ...body, externalTransactionId: 'rejected', money: { amount: '101.00', currency: 'BRL' },
      }, 'rejected')).status).toBe(422);

      const lines = log.mock.calls.map(([line]) => String(line));
      const entries = lines.map((line) => JSON.parse(line));
      expect(entries).toContainEqual({
        event: 'wager_committed', component: 'http', transactionId, correlationId: transactionId,
        walletId: wallet.id, providerId: body.providerId, status: 'PROCESSED', duplicate: false,
      });
      expect(entries).toContainEqual(expect.objectContaining({ transactionId, duplicate: true }));
      for (const secret of [wallet.playerId, body.money.amount, body.externalTransactionId, body.roundId, body.gameId, 'private-idempotency-key']) {
        expect(lines.join('\n')).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
    }

    await sqs.send(new SendMessageCommand({
      QueueUrl: dlq, MessageBody: 'private-dlq-body', MessageGroupId: id, MessageDeduplicationId: id,
    }));
    const current = await metrics();
    expect(sample(current, 'postgres_metrics_up')).toBe(1);
    expect(sample(current, 'sqs_metrics_up')).toBe(1);
    expect(sample(current, 'sqs_dlq_messages')).toBe(1);
    expect(sample(current, 'outbox_lag_seconds')).toBeGreaterThan(0);
    expect(sample(current, 'wager_transactions{status="PROCESSED"}')).toBe(2);
    expect(sample(current, 'wager_transactions{status="PENDING_REFERENCE"}')).toBe(1);
    expect(sample(current, 'wager_transactions{status="REJECTED"}')).toBe(1);
    expect(sample(current, 'wager_transactions{status="FAILED"}')).toBe(0);
    expect(sample(current, 'wager_duplicates_total{component="http"}')).toBe(sample(before, 'wager_duplicates_total{component="http"}') + 1);
    expect(sample(current, 'processing_duration_seconds_count{component="http"}'))
      .toBe(sample(before, 'processing_duration_seconds_count{component="http"}') + 4);
    expect(sample(current, 'processing_duration_seconds_sum{component="http"}'))
      .toBeGreaterThan(sample(before, 'processing_duration_seconds_sum{component="http"}'));
    expect(current).not.toContain('private-dlq-body');
  });

  test('counts a real PostgreSQL lock conflict and preserves the retryable HTTP response', async () => {
    const wallet = await open();
    const locker = await MikroORM.init(financialTestConfig(databaseUrl!, schema));
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = locker.em.fork().transactional(async (tx) => {
      await tx.findOneOrFail(WalletRecord, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      ready.resolve();
      await release.promise;
    }).catch((error: unknown) => {
      ready.reject(error);
      throw error;
    });
    const key = 'postgres_lock_conflicts_total{component="http"}';
    try {
      await ready.promise;
      const before = sample(await metrics(), key);
      await orm.em.execute("SET lock_timeout = '75ms'");
      const response = await request('/wagering/transactions', bet(wallet, 'lock-contender'), 'lock-contender');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ message: 'Wager processing is temporarily unavailable.' });
      expect(sample(await metrics(), key)).toBe(before + 1);
    } finally {
      release.resolve();
      try {
        await held;
      } finally {
        await Promise.all([orm.em.execute('RESET lock_timeout'), locker.close()]);
      }
    }
  });
});
