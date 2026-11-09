import 'reflect-metadata';
import { LockMode } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { WalletReconciliation } from '../../src/application/reconcile-wallet.js';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { WageringModule } from '../../src/infrastructure/http/wagering.module.js';
import { WalletsModule } from '../../src/infrastructure/http/wallets.module.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;

interface WalletIdentity {
  id: string;
  playerId: string;
}

describe.skipIf(!databaseUrl)('Wallet reconciliation on PostgreSQL', () => {
  const schema = `financial_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const apps: INestApplication[] = [];
  const urls: string[] = [];
  let orm: MikroORM;

  function createApp(config = financialTestConfig(databaseUrl!, schema)) {
    @Module({ imports: [MikroOrmModule.forRoot(config), WalletsModule, WageringModule] })
    class TestAppModule {}

    return NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  }

  beforeAll(async () => {
    const config = financialTestConfig(databaseUrl!, schema);
    for (let index = 0; index < 2; index++) {
      const app = await createApp(config);
      apps.push(app);
      if (index === 0) {
        orm = app.get(MikroORM);
        expect(await orm.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
        await orm.migrator.up();
      }
      await app.listen(0, '127.0.0.1');
      urls.push(await app.getUrl());
    }
  });

  afterAll(async () => {
    try {
      if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  });

  function post(path: string, body?: object, key?: string, baseUrl = urls[0]) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...(body && { 'content-type': 'application/json' }), ...(key && { 'Idempotency-Key': key }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  }

  function money(amount: string, currency = 'BRL') {
    return { amount, currency };
  }

  async function open(amount = '0.00', currency = 'BRL') {
    const response = await post('/wallets', { playerId: crypto.randomUUID(), initialBalance: money(amount, currency) });
    expect(response.status).toBe(201);
    return await response.json() as WalletIdentity;
  }

  function reconcileRequest(walletId: string, baseUrl?: string) {
    return post(`/wallets/${encodeURIComponent(walletId)}/reconciliation`, undefined, undefined, baseUrl);
  }

  async function reconcile(walletId: string, instance = 0) {
    const response = await reconcileRequest(walletId, urls[instance]);
    expect(response.status).toBe(200);
    return await response.json() as WalletReconciliation;
  }

  async function expectReconciliation(walletId: string, amount: string, checkedEntries: number, currency = 'BRL', instance = 0) {
    expect(await reconcile(walletId, instance)).toEqual({
      walletId, storedBalance: money(amount, currency), calculatedBalance: money(amount, currency),
      difference: money('0.00', currency), consistent: true, checkedEntries,
    });
  }

  async function submit(wallet: WalletIdentity, kind: Kind, id: string, amount: string, reference?: string, status = 200) {
    const response = await post('/wagering/transactions', {
      providerId: 'reconciliation-test', walletId: wallet.id, playerId: wallet.playerId, roundId: 'round', gameId: 'game',
      externalTransactionId: `${wallet.id}:${id}`, kind, money: money(amount),
      ...(reference && { referenceExternalTransactionId: `${wallet.id}:${reference}` }),
    }, `${wallet.id}:${id}`);
    expect(response.status).toBe(status);
  }

  async function metric(instance = 0) {
    const response = await fetch(`${urls[instance]}/metrics`, { signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('# TYPE wallet_reconciliation_divergences_total counter');
    return BigInt(/^wallet_reconciliation_divergences_total (\d+)$/m.exec(body)![1]);
  }

  function snapshot() {
    const tables = ['wallets', 'wallet_ledger_entries', 'wager_transactions', 'inbox_messages', 'outbox_messages'];
    return Promise.all(tables.map((table) =>
      orm.em.execute(`SELECT to_jsonb(row) AS data FROM "${schema}"."${table}" AS row ORDER BY to_jsonb(row)::text`),
    ));
  }

  async function insertEntry(
    tx: EntityManager, wallet: WalletIdentity, direction: LedgerDirection, amount: string,
    balanceBefore: string, balanceAfter: string,
  ) {
    const id = crypto.randomUUID();
    const at = new Date();
    await tx.insert(WagerTransactionRecord, {
      id, providerId: 'fixtures', externalTransactionId: id, idempotencyKey: id, payloadHash: 'fixture',
      walletId: wallet.id, playerId: wallet.playerId, roundId: 'round', gameId: 'game',
      kind: direction === LedgerDirection.Credit ? Kind.Win : Kind.Bet, status: Status.Processed,
      amount, currency: 'BRL', observedBalance: balanceAfter, createdAt: at, finalizedAt: at,
    });
    await tx.insert(WalletLedgerEntryRecord, {
      id: crypto.randomUUID(), walletId: wallet.id, transactionId: id, direction,
      amount, currency: 'BRL', balanceBefore, balanceAfter, createdAt: at,
    });
  }

  test('distinguishes an invalid ID, a missing wallet and an existing empty wallet', async () => {
    const wallet = await open('0.00', 'USD');
    expect((await reconcileRequest(' ')).status).toBe(400);
    expect((await reconcileRequest('invalid\0id')).status).toBe(400);
    const missing = await reconcileRequest('missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ message: 'Wallet not found.' });
    await expectReconciliation(wallet.id, '0.00', 0, 'USD');
  });

  test('includes OPENING, debits, credits and reversals while ignoring operations without a ledger entry', async () => {
    const wallet = await open('100.00');
    const other = await open('999.99');
    await expectReconciliation(wallet.id, '100.00', 1);

    await submit(wallet, Kind.Bet, 'bet', '20.00');
    await expectReconciliation(wallet.id, '80.00', 2);
    await submit(wallet, Kind.Win, 'win', '30.00', 'bet');
    await submit(wallet, Kind.Loss, 'loss', '0.00');
    await submit(wallet, Kind.Refund, 'refund', '20.00', 'bet');
    await expectReconciliation(wallet.id, '130.00', 4);

    await submit(wallet, Kind.Rollback, 'undo-refund', '20.00', 'refund');
    await submit(wallet, Kind.Rollback, 'undo-bet', '20.00', 'bet');
    await submit(wallet, Kind.Rollback, 'undo-win', '30.00', 'win');
    await submit(wallet, Kind.Bet, 'rejected', '101.00', undefined, 422);
    await submit(wallet, Kind.Win, 'pending', '1.00', 'missing', 202);
    await expectReconciliation(wallet.id, '100.00', 7);
    await expectReconciliation(other.id, '999.99', 1);
  });

  test('keeps exact cents above the safe integer range and reports either sign without changing persisted data', async () => {
    const above = await open('9007199254740993.01');
    const below = await open('100.00');
    await expectReconciliation(above.id, '9007199254740993.01', 1);

    const em = orm.em.fork();
    await em.nativeUpdate(WalletRecord, above.id, { balance: '9007199254740993.02' });
    await em.nativeUpdate(WalletRecord, below.id, { balance: '99.99' });
    const before = await snapshot();
    expect(await reconcile(above.id)).toEqual({
      walletId: above.id, storedBalance: money('9007199254740993.02'), calculatedBalance: money('9007199254740993.01'),
      difference: money('0.01'), consistent: false, checkedEntries: 1,
    });
    expect(await reconcile(below.id)).toEqual({
      walletId: below.id, storedBalance: money('99.99'), calculatedBalance: money('100.00'),
      difference: money('-0.01'), consistent: false, checkedEntries: 1,
    });
    expect(await snapshot()).toEqual(before);
  });

  test('reports a sum outside the wallet range and a negative reconstructed balance', async () => {
    const large = await open();
    const negative = await open();
    const maximum = '999999999999999999.99';
    await orm.em.fork().transactional(async (tx) => {
      await insertEntry(tx, large, LedgerDirection.Credit, maximum, '0.00', maximum);
      await insertEntry(tx, large, LedgerDirection.Credit, maximum, '0.00', maximum);
      await insertEntry(tx, negative, LedgerDirection.Debit, maximum, maximum, '0.00');
    });
    expect(await reconcile(large.id)).toEqual({
      walletId: large.id, storedBalance: money('0.00'), calculatedBalance: money('1999999999999999999.98'),
      difference: money('-1999999999999999999.98'), consistent: false, checkedEntries: 2,
    });
    expect(await reconcile(negative.id)).toEqual({
      walletId: negative.id, storedBalance: money('0.00'), calculatedBalance: money(`-${maximum}`),
      difference: money(maximum), consistent: false, checkedEntries: 1,
    });
  });

  test.each(['commit', 'rollback'] as const)('reads one committed balance and ledger snapshot during a concurrent %s', async (outcome) => {
    const wallet = await open('100.00');
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rollback = new Error('Test rollback');
    const writing = orm.em.fork().transactional(async (tx) => {
      await tx.findOneOrFail(WalletRecord, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      await tx.nativeUpdate(WalletRecord, wallet.id, { balance: '70.00', version: 2 });
      await insertEntry(tx, wallet, LedgerDirection.Debit, '30.00', '100.00', '70.00');
      ready.resolve();
      await release.promise;
      if (outcome === 'rollback') throw rollback;
    }).catch((error: unknown) => {
      if (error !== rollback) {
        ready.reject(error);
        throw error;
      }
    });
    try {
      await ready.promise;
      await Promise.all([
        expectReconciliation(wallet.id, '100.00', 1),
        expectReconciliation(wallet.id, '100.00', 1, 'BRL', 1),
      ]);
    } finally {
      release.resolve();
      await writing;
    }
    await expectReconciliation(wallet.id, outcome === 'commit' ? '70.00' : '100.00', outcome === 'commit' ? 2 : 1);
  });

  test('logs and counts each parallel divergent check on its serving instance', async () => {
    const inconsistent = await open();
    const consistent = await open();
    await orm.em.fork().nativeUpdate(WalletRecord, inconsistent.id, { balance: '1.00' });
    const [beforeA, beforeB] = await Promise.all([metric(), metric(1)]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const [a, b, c, d, healthy] = await Promise.all([
        reconcile(inconsistent.id), reconcile(inconsistent.id), reconcile(inconsistent.id, 1),
        reconcile(inconsistent.id, 1), reconcile(consistent.id),
      ]);
      expect([a.consistent, b.consistent, c.consistent, d.consistent, healthy.consistent]).toEqual([false, false, false, false, true]);
      expect(await metric()).toBe(beforeA + 2n);
      expect(await metric(1)).toBe(beforeB + 2n);
      const logs = warn.mock.calls.map(([message]) => JSON.parse(String(message)));
      expect(logs).toHaveLength(4);
      expect(new Set(logs.map(({ correlationId }) => correlationId)).size).toBe(4);
      for (const log of logs) {
        expect(log).toEqual({
          event: 'wallet_reconciliation_divergence', walletId: inconsistent.id, checkedEntries: 0,
          correlationId: expect.any(String),
        });
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('maps transient read failures to 503 and unexpected SQL errors to 500', async () => {
    const config = financialTestConfig(databaseUrl!, schema);
    for (const [override, status] of [
      [{ host: '127.0.0.1', port: 1 }, 503],
      [{ schema: `${schema}_missing` }, 500],
    ] as const) {
      const app = await createApp({ ...config, ...override });
      try {
        await app.listen(0, '127.0.0.1');
        const response = await reconcileRequest('any', await app.getUrl());
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({
          message: status === 503 ? 'Financial queries are temporarily unavailable.' : 'Internal server error',
        });
      } finally {
        await app.close();
      }
    }
  });
});
