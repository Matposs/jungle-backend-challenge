import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { OutboxRecord } from '../../src/infrastructure/database/outbox-record.js';
import { WalletsModule } from '../../src/infrastructure/http/wallets.module.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

describe.skipIf(!databaseUrl)('POST /wallets on PostgreSQL', () => {
  const schema = `financial_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const outboxTable = `"${schema}".outbox_messages`;
  const financialMigration = 'Migration20261107000100_FinancialSchema';
  const outboxMigration = 'Migration20261107000200_TransactionalOutbox';
  const sentinelId = 'pre-existing-wallet';
  let app: INestApplication;
  let orm: MikroORM;
  let url: string;

  beforeAll(async () => {
    const config = financialTestConfig(databaseUrl!, schema);
    @Module({ imports: [MikroOrmModule.forRoot(config), WalletsModule] })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
    orm = app.get(MikroORM);
    expect(await orm.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    await orm.migrator.up({ to: financialMigration });
    const at = new Date('2026-01-01T00:00:00.000Z');
    await orm.em.fork().insert(WalletRecord, {
      id: sentinelId, playerId: sentinelId, balance: '0.00', currency: 'BRL', createdAt: at, updatedAt: at,
    });
    await orm.migrator.up({ to: outboxMigration });
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([outboxMigration]);
    expect(await orm.em.execute('SELECT to_regclass(?) AS name', [`${schema}.outbox_messages`])).toEqual([{ name: null }]);
    expect(await orm.em.fork().count(WalletRecord, { id: sentinelId })).toBe(1);
    expect((await orm.migrator.getExecuted()).map(({ name }) => name)).toEqual([financialMigration]);
    expect((await orm.migrator.up({ to: outboxMigration })).map(({ name }) => name)).toEqual([outboxMigration]);
    await orm.migrator.up();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    try {
      if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await app?.close();
    }
  });

  function post(body: unknown): Promise<Response> {
    return fetch(`${url}/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  function open(playerId: string, amount: string, currency = 'BRL'): Promise<Response> {
    return post({ playerId, initialBalance: { amount, currency } });
  }

  async function counts() {
    const em = orm.em.fork();
    return Promise.all([
      em.count(WalletRecord), em.count(WagerTransactionRecord), em.count(WalletLedgerEntryRecord), em.count(OutboxRecord),
    ]);
  }

  test('reapplies the Outbox migration without removing the financial schema or its data', async () => {
    expect(await orm.migrator.getPending()).toHaveLength(0);
    expect((await orm.migrator.getExecuted()).map(({ name }) => name).slice(0, 2)).toEqual([financialMigration, outboxMigration]);
    expect(await orm.em.fork().count(WalletRecord, { id: sentinelId })).toBe(1);
    expect(await orm.em.execute(
      'SELECT indexname FROM pg_indexes WHERE schemaname = ? AND indexname = ?', [schema, 'outbox_pending_due_idx'],
    )).toEqual([{ indexname: 'outbox_pending_due_idx' }]);
  });

  test('returns the official response for a zero balance and records only the wallet', async () => {
    const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
    const [wallets, transactions, entries, events] = await counts();
    const response = await open(playerId, '0.00');
    const body = await response.json() as WalletResponse;

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: expect.any(String), playerId, balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
    const stored = await orm.em.fork().findOneOrFail(WalletRecord, body.id);
    expect(stored).toMatchObject({ playerId, balance: '0.00', currency: 'BRL', version: 1 });
    expect(await counts()).toEqual([wallets + 1, transactions, entries, events]);
  });

  test('persists OPENING, CREDIT and both versioned events with exact balances', async () => {
    const playerId = 'positive-player';
    const money = { amount: '9007199254740993.01', currency: 'BRL' };
    const databaseTime = async () => new Date((await orm.em.execute<{ at: string }[]>('SELECT clock_timestamp() AS at'))[0]!.at).getTime();
    const before = await databaseTime();
    setSystemTime(before - 2 * 86_400_000);
    const response = await post({ playerId, initialBalance: money }).finally(() => setSystemTime());
    const after = await databaseTime();
    const body = await response.json() as WalletResponse;
    const em = orm.em.fork();

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: expect.any(String), playerId, balance: money, version: 1 });
    const wallet = await em.findOneOrFail(WalletRecord, body.id);
    const transaction = await em.findOneOrFail(WagerTransactionRecord, { walletId: wallet.id });
    const entry = await em.findOneOrFail(WalletLedgerEntryRecord, { transactionId: transaction.id });
    expect(wallet).toMatchObject({ balance: money.amount, version: 1 });
    expect(wallet.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(wallet.createdAt.getTime()).toBeLessThanOrEqual(after);
    expect(wallet.updatedAt).toEqual(wallet.createdAt);
    expect(transaction.createdAt).toEqual(wallet.createdAt);
    expect(entry.createdAt).toEqual(wallet.createdAt);
    expect(transaction).toMatchObject({
      providerId: 'internal:wallet-opening', externalTransactionId: `opening:${wallet.id}`, idempotencyKey: `opening:${wallet.id}`,
      kind: WagerTransactionKind.Opening, status: WagerTransactionStatus.Processed, amount: money.amount,
      observedBalance: wallet.balance, finalizedAt: wallet.createdAt,
    });
    expect(transaction.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry).toMatchObject({
      walletId: wallet.id, direction: LedgerDirection.Credit, amount: money.amount,
      currency: money.currency, balanceBefore: '0.00', balanceAfter: wallet.balance,
    });
    expect(await em.execute(
      `SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS balance
       FROM "${schema}".wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id],
    )).toEqual([{ balance: wallet.balance }]);

    const events = await em.find(OutboxRecord, { aggregateId: { $in: [wallet.id, transaction.id] } });
    expect(events).toHaveLength(2);
    const byType = Object.fromEntries(events.map((event) => [event.eventType, event]));
    const processed = byType.WagerTransactionProcessed!;
    const changed = byType.WalletBalanceChanged!;
    for (const event of events) {
      expect(event.attempts).toBe(0);
      expect(event.publishedAt ?? null).toBeNull();
      expect(event.nextAttemptAt ?? null).toBeNull();
      expect(event.payload).toMatchObject({
        eventId: event.id, aggregateId: event.aggregateId, eventType: event.eventType, correlationId: wallet.id,
        occurredAt: wallet.createdAt.toISOString(), version: 1,
      });
    }
    expect(processed.aggregateId).toBe(transaction.id);
    expect(processed.payload.data).toMatchObject({
      transactionId: transaction.id, walletId: wallet.id, kind: 'OPENING', status: 'PROCESSED', money, balance: money,
    });
    expect(changed.aggregateId).toBe(wallet.id);
    expect(changed.payload.causationId).toBe(transaction.id);
    expect(changed.payload.data).toEqual({
      walletId: wallet.id, transactionId: transaction.id, direction: 'CREDIT', money,
      balanceBefore: { amount: '0.00', currency: 'BRL' }, balanceAfter: money, walletVersion: 1,
    });
  });

  test('returns 409 for a duplicate without duplicating events and allows another currency', async () => {
    const playerId = 'duplicate-player';
    expect((await open(playerId, '10.00')).status).toBe(201);
    const before = await counts();
    expect((await open(playerId, '20.00')).status).toBe(409);
    expect(await counts()).toEqual(before);
    expect((await open(playerId, '0.00', 'USD')).status).toBe(201);
    expect(await orm.em.fork().count(WalletRecord, { playerId })).toBe(2);
  });

  test('rejects malformed identifiers, money and currency with no database effects', async () => {
    const before = await counts();
    for (const body of [{}, { playerId: 123 }, { playerId: '  ' }, { playerId: 'invalid\0id' },
      { playerId: 'invalid-player', initialBalance: null },
      ...[1, '-1.00', 'NaN', '1e2', '1.000', '1000000000000000000.00'].map((amount) => ({
        playerId: 'invalid-player', initialBalance: { amount, currency: 'BRL' },
      })), { playerId: 'invalid-player', initialBalance: { amount: '1.00', currency: 'ZZZ' } }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  });

  test('commits only one wallet and pair of events when openings race', async () => {
    const playerId = 'race-player';
    const [wallets, transactions, entries, events] = await counts();
    const responses = await Promise.all([open(playerId, '10.00'), open(playerId, '20.00')]);
    const statuses = responses.map(({ status }) => status).sort();

    expect(statuses).toEqual([201, 409]);
    const winner = await responses.find(({ status }) => status === 201)!.json() as WalletResponse;
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { playerId });
    expect(wallet.id).toBe(winner.id);
    expect(wallet.balance).toBe(winner.balance.amount);
    expect(await counts()).toEqual([wallets + 1, transactions + 1, entries + 1, events + 2]);
  });

  test('rolls back wallet, transaction, ledger and Outbox on a deferred database failure', async () => {
    const playerId = 'commit-failure-player';
    const before = await counts();
    const failure = `"${schema}".fail_outbox_commit`;
    await orm.em.execute(`CREATE FUNCTION ${failure}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced outbox commit failure'; END; $$`);
    await orm.em.execute(`CREATE CONSTRAINT TRIGGER fail_outbox_commit AFTER INSERT ON ${outboxTable}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.payload->'data'->>'playerId' = 'commit-failure-player') EXECUTE FUNCTION ${failure}()`);

    try {
      expect((await open(playerId, '25.00')).status).toBe(500);
      expect(await counts()).toEqual(before);
      expect(await orm.em.fork().count(WalletRecord, { playerId })).toBe(0);
    } finally {
      await orm.em.execute(`DROP TRIGGER fail_outbox_commit ON ${outboxTable}`);
      await orm.em.execute(`DROP FUNCTION ${failure}()`);
    }
    expect((await open(playerId, '25.00')).status).toBe(201);
  });

  test('returns 503 after PostgreSQL disconnects during commit and recovers without duplicate opening', async () => {
    const playerId = 'disconnect-opening-player';
    const before = await counts();
    const failure = `"${schema}".disconnect_opening`;
    await orm.em.execute(`CREATE FUNCTION ${failure}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NULL; END; $$`);
    await orm.em.execute(`CREATE CONSTRAINT TRIGGER disconnect_opening AFTER INSERT ON ${outboxTable}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.payload->'data'->>'playerId' = 'disconnect-opening-player') EXECUTE FUNCTION ${failure}()`);
    try {
      const interrupted = await open(playerId, '25.00');
      expect(await counts()).toEqual(before);
      expect(interrupted.status).toBe(503);
      expect(await interrupted.json()).toMatchObject({ message: 'Wallet opening is temporarily unavailable.' });
    } finally {
      await orm.em.execute(`DROP TRIGGER disconnect_opening ON ${outboxTable}`);
      await orm.em.execute(`DROP FUNCTION ${failure}()`);
    }

    const responses = await Promise.all([open(playerId, '25.00'), open(playerId, '25.00')]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const [wallets, transactions, entries, events] = before;
    expect(await counts()).toEqual([wallets + 1, transactions + 1, entries + 1, events + 2]);
  });

  test('allows concurrent database transactions to skip locked pending events', async () => {
    expect((await open('pending-events-player', '1.00')).status).toBe(201);
    const claim = `SELECT id FROM ${outboxTable} WHERE published_at IS NULL
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY next_attempt_at NULLS FIRST, occurred_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;

    await orm.em.fork().transactional(async (first) => {
      const firstRows = await first.execute<{ id: string }[]>(claim);
      const secondRows = await orm.em.fork().transactional((second) => second.execute<{ id: string }[]>(claim));
      expect(firstRows).toHaveLength(1);
      expect(secondRows).toHaveLength(1);
      expect(secondRows[0]!.id).not.toBe(firstRows[0]!.id);
    });
  });
});
