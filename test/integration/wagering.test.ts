import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MoneyProps } from '../../src/domain/money.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { OutboxRecord } from '../../src/infrastructure/database/outbox-record.js';
import { WageringModule } from '../../src/infrastructure/http/wagering.module.js';
import { WalletsModule } from '../../src/infrastructure/http/wallets.module.js';
import { financialTestConfig } from './financial-test-config.js';

interface BetResponse {
  transactionId: string;
  status: Status;
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Wagering on PostgreSQL', () => {
  const schema = `financial_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const apps: INestApplication[] = [];
  const urls: string[] = [];
  let orm: MikroORM;

  beforeAll(async () => {
    const config = financialTestConfig(databaseUrl!, schema);
    while (apps.length < 3) {
      @Module({ imports: [MikroOrmModule.forRoot(config), WalletsModule, WageringModule] })
      class TestAppModule {}

      const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
      apps.push(app);
      if (apps.length === 1) {
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

  function post(path: string, body: object, app = 0, key?: string) {
    return fetch(`${urls[app]}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key !== undefined && { 'Idempotency-Key': key }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
  }

  async function open(playerId: string, amount = '100.00') {
    const response = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; playerId: string };
  }

  function bet(wallet: { id: string; playerId: string }, externalTransactionId: string, amount: string) {
    return {
      providerId: 'provider-a', externalTransactionId, playerId: wallet.playerId, walletId: wallet.id,
      roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: { amount, currency: 'BRL' },
    };
  }

  function submit(body: ReturnType<typeof bet> & { referenceExternalTransactionId?: string }, key = body.externalTransactionId, app = 0) {
    return post('/wagering/transactions', body, app, key);
  }

  function refund(wallet: { id: string; playerId: string }, id: string, amount: string, referenceExternalTransactionId: string) {
    return { ...bet(wallet, id, amount), kind: Kind.Refund, referenceExternalTransactionId };
  }

  function rollback(wallet: { id: string; playerId: string }, id: string, amount: string, referenceExternalTransactionId: string) {
    return { ...bet(wallet, id, amount), kind: Kind.Rollback, referenceExternalTransactionId };
  }

  async function seedPendingBet(wallet: { id: string; playerId: string }, id: string, amount: string) {
    const { money, ...fields } = bet(wallet, id, amount);
    await orm.em.fork().insert(WagerTransactionRecord, {
      ...fields, kind: Kind.Bet, amount: money.amount, currency: money.currency,
      id: crypto.randomUUID(), idempotencyKey: id, payloadHash: 'fixture', status: Status.Pending, createdAt: new Date(),
    });
  }

  async function state(walletId: string, kind = Kind.Bet) {
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, walletId);
    const transactions = await em.find(WagerTransactionRecord, { walletId, kind });
    const ids = transactions.map(({ id }) => id);
    const entries = await em.find(WalletLedgerEntryRecord, { walletId });
    const events = await em.find(OutboxRecord, { payload: { data: { walletId } } });
    const wagerEvents = events.filter((event) => ids.includes(event.aggregateId) ||
      ('transactionId' in event.payload.data && ids.includes(String(event.payload.data.transactionId))));
    const reconstructed = await em.execute<{ balance: string }[]>(
      `SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2) AS balance
       FROM "${schema}".wallet_ledger_entries WHERE wallet_id = ?`, [walletId],
    );
    expect(reconstructed[0]?.balance).toBe(wallet.balance);
    return { wallet, transactions, entries, wagerEvents, events };
  }

  test('returns the original result for 50 simultaneous submissions across three app instances', async () => {
    const wallet = await open('parallel-replays');
    const request = bet(wallet, 'parallel-replay', '25.00');
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(request, 'parallel-key', index % 3)));
    expect(responses.map(({ status }) => status)).toEqual(Array(50).fill(200));
    const results = await Promise.all(responses.map(async (response) => await response.json() as BetResponse));
    const original = results.filter(({ idempotentReplay }) => !idempotentReplay);
    expect(original).toHaveLength(1);
    for (const result of results) {
      expect(result).toEqual({
        transactionId: original[0]!.transactionId, status: Status.Processed, balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: result.idempotentReplay,
      });
    }
    const stored = await state(wallet.id);
    expect(stored.wallet).toMatchObject({ balance: '75.00', version: 2 });
    expect(stored.transactions).toHaveLength(1);
    const legacyBetHash = createHash('sha256').update(JSON.stringify({
      externalTransactionId: request.externalTransactionId, gameId: request.gameId, kind: request.kind, money: request.money,
      playerId: request.playerId, providerId: request.providerId, roundId: request.roundId, walletId: request.walletId,
    })).digest('hex');
    expect(stored.transactions[0]?.payloadHash).toBe(legacyBetHash);
    expect(stored.entries.filter(({ direction }) => direction === 'DEBIT')).toHaveLength(1);
    expect(stored.wagerEvents.map(({ eventType }) => eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(stored.wagerEvents.find(({ eventType }) => eventType === 'WalletBalanceChanged')?.payload.data).toMatchObject({
      direction: 'DEBIT', balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });

    expect((await submit(bet(wallet, 'later-debit', '5.00'), 'later-key', 1)).status).toBe(200);
    const { money, ...rest } = request;
    const replay = await submit({ money: { currency: money.currency, amount: money.amount }, ...rest }, 'parallel-key', 2);
    expect(await replay.json()).toEqual({ ...original[0], idempotentReplay: true });
    expect((await state(wallet.id)).wallet.balance).toBe('70.00');
  });

  test('serializes two 80.00 debits against 100.00 and persists the rejected result', async () => {
    const wallet = await open('competing-debits');
    const requests = [bet(wallet, 'competing-a', '80.00'), bet(wallet, 'competing-b', '80.00')];
    const responses = await Promise.all(requests.map((request, index) => submit(request, request.externalTransactionId, index)));
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 422]);
    const rejectedIndex = responses.findIndex(({ status }) => status === 422);
    const rejection = await responses[rejectedIndex]!.json() as BetResponse;
    expect(rejection).toMatchObject({
      status: Status.Rejected, failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00', currency: 'BRL' }, idempotentReplay: false,
    });
    const replay = await submit(requests[rejectedIndex]!);
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual({ ...rejection, idempotentReplay: true });

    const stored = await state(wallet.id);
    expect(stored.wallet).toMatchObject({ balance: '20.00', version: 2 });
    expect(stored.transactions.map(({ status }) => status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(stored.entries.filter(({ direction }) => direction === 'DEBIT')).toHaveLength(1);
    expect(stored.wagerEvents.map(({ eventType }) => eventType).sort())
      .toEqual(['WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged']);
    expect(stored.wagerEvents.find(({ eventType }) => eventType === 'WagerTransactionRejected')?.payload.data)
      .toMatchObject({ transactionId: rejection.transactionId, failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('rejects divergent payloads and conflicting external IDs, including races across wallets', async () => {
    const first = await open('identity-a');
    const second = await open('identity-b');
    const a = bet(first, 'identity-external-a', '10.00');
    const b = bet(second, 'identity-external-b', '10.00');
    const responses = await Promise.all([submit(a, 'shared-key', 0), submit(b, 'shared-key', 1)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = responses[0]!.status === 200 ? a : b;
    expect((await submit({ ...winner, money: { amount: '11.00', currency: 'BRL' } }, 'shared-key')).status).toBe(409);
    expect((await submit(winner, 'different-key')).status).toBe(409);
    const snapshots = await Promise.all([state(first.id), state(second.id)]);
    expect(snapshots.map(({ wallet }) => wallet.balance).sort()).toEqual(['100.00', '90.00']);
    expect(snapshots.flatMap(({ transactions }) => transactions)).toHaveLength(1);
    expect(snapshots.flatMap(({ wagerEvents }) => wagerEvents)).toHaveLength(2);
  });

  test('allows another wallet to complete while PostgreSQL holds a row lock on the first', async () => {
    const first = await open('locked-wallet');
    const second = await open('independent-wallet');
    const em = orm.em.fork();
    let blocked: Promise<Response> | undefined;
    await em.transactional(async (tx) => {
      await tx.findOneOrFail(WalletRecord, first.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      blocked = submit(bet(first, 'locked-bet', '5.00'), 'locked-key', 1);

      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        await tx.execute('SELECT pg_stat_clear_snapshot()');
        const [row] = await tx.execute<{ waiting: boolean }[]>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
             AND wait_event_type = 'Lock' AND query ILIKE '%${schema}%wallets%for update%') AS waiting`,
        );
        waiting = row?.waiting === true;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      expect((await submit(bet(second, 'independent-bet', '10.00'), 'independent-key', 2)).status).toBe(200);
      expect((await submit({ ...bet(second, 'independent-win', '5.00'), kind: 'WIN' }, 'independent-win', 2)).status).toBe(200);
      expect((await submit(refund(second, 'independent-refund', '10.00', 'independent-bet'), 'independent-refund', 2)).status).toBe(200);
    });
    expect((await blocked!)!.status).toBe(200);
    expect((await state(first.id)).wallet.balance).toBe('95.00');
    expect((await state(second.id, Kind.Refund)).wallet.balance).toBe('105.00');
  });

  test.each([[Kind.Bet, '80.00'], [Kind.Win, '120.00'], [Kind.Refund, '100.00'], [Kind.Rollback, '100.00']] as const)(
    'rolls back %s, identity, ledger and Outbox on a failure at commit and permits retry', async (kind, finalBalance) => {
    const wallet = await open(`failed-${kind}`);
    const id = `fail-at-commit-${kind}`;
    const referenceId = `original-bet-for-commit-${kind}`;
    if (kind === Kind.Refund || kind === Kind.Rollback) {
      expect((await submit(bet(wallet, referenceId, '20.00'))).status).toBe(200);
    }
    const body = {
      ...bet(wallet, id, '20.00'), kind,
      ...((kind === Kind.Refund || kind === Kind.Rollback) && { referenceExternalTransactionId: referenceId }),
    };
    const before = await state(wallet.id, kind);
    const table = `"${schema}".outbox_messages`;
    const failure = `"${schema}".fail_bet_commit`;
    await orm.em.execute(`CREATE FUNCTION ${failure}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced bet commit failure' USING ERRCODE = '40001'; END; $$`);
    await orm.em.execute(`CREATE CONSTRAINT TRIGGER fail_bet_commit AFTER INSERT ON ${table}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.payload->'data'->>'externalTransactionId' = 'fail-at-commit-${kind}') EXECUTE FUNCTION ${failure}()`);
    try {
      expect((await submit(body)).status).toBe(503);
      const stored = await state(wallet.id, kind);
      expect(stored.wallet).toMatchObject({ balance: before.wallet.balance, version: before.wallet.version });
      expect(stored.transactions).toHaveLength(0);
      expect(stored.entries).toHaveLength(before.entries.length);
      expect(stored.events).toHaveLength(before.events.length);
    } finally {
      await orm.em.execute(`DROP TRIGGER fail_bet_commit ON ${table}`);
      await orm.em.execute(`DROP FUNCTION ${failure}()`);
    }
    const retry = await submit(body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ idempotentReplay: false });
    expect((await state(wallet.id, kind)).wallet.balance).toBe(finalBalance);
  });

  test('rejects invalid transport data and wallets without persisting effects', async () => {
    const wallet = await open('invalid-bet');
    const body = bet(wallet, 'invalid-bet', '10.00');
    expect((await post('/wagering/transactions', body)).status).toBe(400);
    for (const invalid of [
      { ...body, kind: 'OPENING' }, { ...body, providerId: 'internal:wallet-opening' },
      { ...body, money: { amount: '0.00', currency: 'BRL' } },
      { ...body, money: { amount: '1.00', currency: 'USD' } }, { ...body, playerId: 'other-player' },
      { ...body, walletId: 'unknown-wallet' },
    ]) {
      expect((await submit(invalid)).status).toBe(400);
    }
    expect((await state(wallet.id)).transactions).toHaveLength(0);
  });

  test('credits unreferenced WINs exactly once across three instances and replays the original balance', async () => {
    const wallet = await open('win-race');
    const win = { ...bet(wallet, 'win-race-first', '25.01'), kind: 'WIN' };
    const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => submit(win, win.externalTransactionId, index % 3)));
    expect(responses.map(({ status }) => status)).toEqual(Array(30).fill(200));
    const results = await Promise.all(responses.map(async (response) => await response.json() as BetResponse));
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    const original = results.find((result) => !result.idempotentReplay)!;
    expect(original.balance?.amount).toBe('125.01');
    expect(results.every((result) => result.transactionId === original.transactionId && result.balance?.amount === '125.01')).toBe(true);

    const later = ['win-race-second', 'win-race-third'].map((id) => ({ ...bet(wallet, id, '1.00'), kind: 'WIN' }));
    expect((await Promise.all(later.map((body, index) => submit(body, body.externalTransactionId, index))))
      .map(({ status }) => status)).toEqual([200, 200]);
    const replay = await submit(win, win.externalTransactionId, 2);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    const stored = await state(wallet.id, Kind.Win);
    expect(stored.wallet).toMatchObject({ balance: '127.01', version: 4 });
    expect(stored.transactions).toHaveLength(3);
    expect(stored.entries.filter(({ transactionId }) => transactionId === original.transactionId)).toEqual([
      expect.objectContaining({ direction: 'CREDIT', amount: '25.01', balanceBefore: '100.00', balanceAfter: '125.01' }),
    ]);
    expect(stored.wagerEvents.map(({ eventType }) => eventType).sort())
      .toEqual([...Array(3).fill('WagerTransactionProcessed'), ...Array(3).fill('WalletBalanceChanged')]);
  });

  test('credits a WIN referencing a BET of a different amount and rejects incompatible or unsuccessful references', async () => {
    const wallet = await open('reference-win');
    const other = await open('reference-other-wallet');
    const wager = await submit(bet(wallet, 'reference-bet', '10.00'));
    const { transactionId } = await wager.json() as BetResponse;
    const win = { ...bet(wallet, 'valid-reference-win', '25.00'), kind: 'WIN', referenceExternalTransactionId: 'reference-bet' };
    const response = await submit(win);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: Status.Processed, balance: { amount: '115.00', currency: 'BRL' } });
    expect((await state(wallet.id, Kind.Win)).transactions[0]?.referenceTransactionId).toBe(transactionId);

    const invalidReferences = [
      { ...win, externalTransactionId: 'wrong-round-win', roundId: 'other-round' },
      { ...win, externalTransactionId: 'wrong-kind-win', referenceExternalTransactionId: win.externalTransactionId },
      { ...win, externalTransactionId: 'wrong-wallet-win', walletId: other.id, playerId: other.playerId },
    ];
    for (const body of invalidReferences) {
      const rejected = await submit(body);
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ status: Status.Rejected, failureCode: 'INVALID_REFERENCE' });
    }
    const rejectedBet = await submit(bet(wallet, 'rejected-reference-bet', '999.00'));
    expect(rejectedBet.status).toBe(422);
    const rejectedBetBody = await rejectedBet.json() as BetResponse;
    const failedReference = await submit({ ...win, externalTransactionId: 'rejected-reference-win', referenceExternalTransactionId: 'rejected-reference-bet' });
    expect(failedReference.status).toBe(422);
    expect(await failedReference.json()).toMatchObject({ failureCode: 'REFERENCE_NOT_PROCESSED' });
    const stored = await state(wallet.id, Kind.Win);
    expect(stored.wallet).toMatchObject({ balance: '115.00', version: 3 });
    expect(stored.transactions.find(({ failureCode }) => failureCode === 'REFERENCE_NOT_PROCESSED')?.referenceTransactionId)
      .toBe(rejectedBetBody.transactionId);
    expect((await state(other.id, Kind.Win)).wallet).toMatchObject({ balance: '100.00', version: 1 });
  });

  test('persists a missing or still pending BET reference and keeps replay pending after the BET arrives', async () => {
    const wallet = await open('pending-win');
    const first = { ...bet(wallet, 'pending-win-first', '25.00'), kind: 'WIN', referenceExternalTransactionId: 'late-bet' };
    const pending = await submit(first);
    const original = await pending.json() as BetResponse;
    expect(pending.status).toBe(202);
    expect(original).toEqual({ transactionId: expect.any(String), status: Status.PendingReference, idempotentReplay: false });
    await seedPendingBet(wallet, 'still-pending-bet', '10.00');
    const second = { ...first, externalTransactionId: 'pending-win-second', referenceExternalTransactionId: 'still-pending-bet' };
    expect((await submit(second)).status).toBe(202);
    const snapshot = await state(wallet.id, Kind.Win);
    expect(snapshot.wallet).toMatchObject({ balance: '100.00', version: 1 });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.transactions).toHaveLength(2);
    for (const transaction of snapshot.transactions) {
      expect(transaction.status).toBe(Status.PendingReference);
      expect(transaction.referenceTransactionId ?? null).toBeNull();
      expect(transaction.referenceAttempts).toBe(0);
    }
    expect(snapshot.wagerEvents.map(({ eventType }) => eventType)).toEqual(Array(2).fill('WagerTransactionPendingReference'));
    expect(snapshot.wagerEvents.find(({ aggregateId }) => aggregateId === original.transactionId)?.payload.data)
      .toMatchObject({ referenceExternalTransactionId: 'late-bet' });

    expect((await submit(bet(wallet, 'late-bet', '5.00'))).status).toBe(200);
    const replay = await submit(first, first.externalTransactionId, 2);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect((await submit({ ...first, referenceExternalTransactionId: 'other-bet' })).status).toBe(409);
    expect((await state(wallet.id, Kind.Win)).wallet.balance).toBe('95.00');
    expect((await state(wallet.id, Kind.Win)).wagerEvents).toHaveLength(2);
  });

  test('processes zero and positive LOSS without a balance change and replays its observed balance', async () => {
    const wallet = await open('loss-wallet');
    const zero = { ...bet(wallet, 'loss-zero', '0.00'), kind: 'LOSS' };
    const processed = await submit(zero);
    const original = await processed.json() as BetResponse;
    expect(processed.status).toBe(200);
    expect(original).toMatchObject({ status: Status.Processed, balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: false });
    expect((await submit({ ...bet(wallet, 'loss-positive', '3.00'), kind: 'LOSS' })).status).toBe(200);
    const snapshot = await state(wallet.id, Kind.Loss);
    expect(snapshot.wallet).toMatchObject({ balance: '100.00', version: 1 });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.transactions.map(({ amount }) => amount).sort()).toEqual(['0.00', '3.00']);
    expect(snapshot.wagerEvents.map(({ eventType }) => eventType)).toEqual(Array(2).fill('WagerTransactionProcessed'));

    expect((await submit(bet(wallet, 'after-loss-bet', '5.00'))).status).toBe(200);
    const replay = await submit(zero, zero.externalTransactionId, 1);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect((await submit({ ...zero, kind: 'WIN', money: { ...zero.money, amount: '1.00' } })).status).toBe(409);
    expect((await submit(zero, 'another-key')).status).toBe(409);
    expect((await state(wallet.id, Kind.Loss)).wallet.balance).toBe('95.00');
  });

  test('rejects WIN above the monetary limit and preserves the exact wallet balance', async () => {
    const max = '999999999999999999.99';
    const wallet = await open('win-limit', max);
    const response = await submit({ ...bet(wallet, 'win-limit', '0.01'), kind: 'WIN' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: Status.Rejected, failureCode: 'BALANCE_LIMIT_EXCEEDED' });
    const stored = await state(wallet.id, Kind.Win);
    expect(stored.wallet).toMatchObject({ balance: max, version: 1 });
    expect(stored.entries).toHaveLength(1);
    expect(stored.wagerEvents.map(({ eventType }) => eventType)).toEqual(['WagerTransactionRejected']);
  });

  test('refunds the full BET, preserves its debit and replays the original balance after later debits', async () => {
    const wallet = await open('refund-full');
    expect((await submit(bet(wallet, 'refund-full-bet', '30.01'))).status).toBe(200);
    const before = await state(wallet.id);
    const originalBet = before.transactions[0]!;
    const originalDebit = before.entries.find(({ transactionId }) => transactionId === originalBet.id)!;
    const body = refund(wallet, 'refund-full-command', '30.01', originalBet.externalTransactionId);

    const response = await submit(body, 'refund-full-key', 1);
    const original = await response.json() as BetResponse;
    expect(response.status).toBe(200);
    expect(original).toEqual({ transactionId: expect.any(String), status: Status.Processed,
      balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: false });
    const after = await state(wallet.id, Kind.Refund);
    expect(after.wallet).toMatchObject({ balance: '100.00', version: 3 });
    expect(after.transactions[0]).toMatchObject({ referenceTransactionId: originalBet.id, amount: '30.01' });
    expect(after.entries.find(({ id }) => id === originalDebit.id)).toEqual(originalDebit);
    expect(after.entries.filter(({ transactionId }) => transactionId === original.transactionId)).toEqual([
      expect.objectContaining({ direction: 'CREDIT', amount: '30.01', balanceBefore: '69.99', balanceAfter: '100.00' }),
    ]);
    expect(after.wagerEvents.map(({ eventType }) => eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    expect((await submit(bet(wallet, 'after-full-refund-bet', '5.00'))).status).toBe(200);
    const replay = await submit(body, 'refund-full-key', 2);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect((await submit({ ...body, money: { amount: '30.00', currency: 'BRL' } }, 'refund-full-key')).status).toBe(409);
    expect((await submit(body, 'different-refund-key')).status).toBe(409);
    expect((await state(wallet.id, Kind.Refund)).wallet.balance).toBe('95.00');
  });

  test('reserves a missing or pending BET reference and keeps its REFUND pending after the BET arrives', async () => {
    const wallet = await open('refund-pending');
    const missing = refund(wallet, 'refund-missing-bet', '20.00', 'late-refund-bet');
    const pending = await submit(missing);
    const original = await pending.json() as BetResponse;
    expect(pending.status).toBe(202);
    expect(original).toEqual({ transactionId: expect.any(String), status: Status.PendingReference, idempotentReplay: false });
    await seedPendingBet(wallet, 'existing-pending-refund-bet', '15.00');
    expect((await submit(refund(wallet, 'refund-existing-pending-bet', '15.00', 'existing-pending-refund-bet'))).status).toBe(202);

    const assertConflict = async (id: string) => {
      const response = await submit({ ...missing, externalTransactionId: id }, id, 1);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ failureCode: 'DUPLICATE_REFUND' });
    };
    await assertConflict('refund-duplicate-missing');
    const before = await state(wallet.id, Kind.Refund);
    expect(before.wallet).toMatchObject({ balance: '100.00', version: 1 });
    expect(before.entries).toHaveLength(1);
    expect(before.transactions).toHaveLength(2);
    for (const transaction of before.transactions) {
      expect(transaction.status).toBe(Status.PendingReference);
      expect(transaction.referenceTransactionId ?? null).toBeNull();
      expect(transaction.referenceAttempts).toBe(0);
    }
    expect(before.wagerEvents.map(({ eventType }) => eventType)).toEqual(Array(2).fill('WagerTransactionPendingReference'));
    expect(before.wagerEvents.find(({ aggregateId }) => aggregateId === original.transactionId)?.payload.data)
      .toMatchObject({ referenceExternalTransactionId: 'late-refund-bet' });

    expect((await submit(bet(wallet, 'late-refund-bet', '20.00'))).status).toBe(200);
    await assertConflict('refund-duplicate-after-reference');
    const replay = await submit(missing, missing.externalTransactionId, 2);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    const after = await state(wallet.id, Kind.Refund);
    expect(after.wallet).toMatchObject({ balance: '80.00', version: 2 });
    expect(after.wagerEvents).toHaveLength(2);
  });

  test('rejects incompatible, nonprocessed terminal and unequal-value REFUND references without reserving the BET', async () => {
    const wallet = await open('refund-invalid');
    const other = await open('refund-invalid-other');
    const source = 'refund-invalid-source-bet';
    expect((await submit(bet(wallet, source, '20.00'))).status).toBe(200);
    expect((await submit(bet(wallet, 'refund-rejected-source-bet', '100.00'))).status).toBe(422);
    expect((await submit({ ...bet(wallet, 'refund-invalid-source-loss', '20.00'), kind: Kind.Loss })).status).toBe(200);
    const mismatch = refund(wallet, 'refund-partial', '19.99', source);
    const invalid = [
      [mismatch, 'REFERENCE_AMOUNT_MISMATCH'],
      [refund(wallet, 'refund-excess', '20.01', source), 'REFERENCE_AMOUNT_MISMATCH'],
      [{ ...refund(wallet, 'refund-wrong-round', '20.00', source), roundId: 'another-round' }, 'INVALID_REFERENCE'],
      [refund(other, 'refund-wrong-wallet', '20.00', source), 'INVALID_REFERENCE'],
      [refund(wallet, 'refund-wrong-kind', '20.00', 'refund-invalid-source-loss'), 'INVALID_REFERENCE'],
      [refund(wallet, 'refund-rejected-bet', '100.00', 'refund-rejected-source-bet'), 'REFERENCE_NOT_PROCESSED'],
    ] as const;
    for (const [body, failureCode] of invalid) {
      const response = await submit(body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ status: Status.Rejected, failureCode });
    }
    expect((await submit({ ...bet(wallet, 'refund-no-reference', '20.00'), kind: Kind.Refund })).status).toBe(400);
    const before = await state(wallet.id, Kind.Refund);
    expect(before.wallet).toMatchObject({ balance: '80.00', version: 2 });
    expect(before.entries).toHaveLength(2);
    expect(before.wagerEvents.map(({ eventType }) => eventType)).toEqual(Array(5).fill('WagerTransactionRejected'));
    expect((await submit(refund(wallet, 'refund-valid-after-rejections', '20.00', source))).status).toBe(200);
    expect((await state(wallet.id, Kind.Refund)).wallet).toMatchObject({ balance: '100.00', version: 3 });
    expect((await state(other.id, Kind.Refund)).wallet).toMatchObject({ balance: '100.00', version: 1 });
  });

  test('allows exactly one REFUND when independent identities race to reverse the same BET', async () => {
    const wallet = await open('refund-race');
    const source = 'refund-race-bet';
    expect((await submit(bet(wallet, source, '20.00'))).status).toBe(200);
    const commands = ['refund-race-a', 'refund-race-b'].map((id) => refund(wallet, id, '20.00', source));
    const responses = await Promise.all(commands.map((body, index) => submit(body, `key-${index}`, index)));
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const rejected = responses.find(({ status }) => status === 409)!;
    expect(await rejected.json()).toMatchObject({ failureCode: 'DUPLICATE_REFUND' });
    const winningIndex = responses.findIndex(({ status }) => status === 200);
    const winner = await responses[winningIndex]!.json() as BetResponse;
    const replay = await submit(commands[winningIndex]!, `key-${winningIndex}`, 2);
    expect(await replay.json()).toEqual({ ...winner, idempotentReplay: true });
    const stored = await state(wallet.id, Kind.Refund);
    expect(stored.wallet).toMatchObject({ balance: '100.00', version: 3 });
    expect(stored.transactions).toHaveLength(1);
    expect(stored.entries.filter(({ transactionId }) => transactionId === winner.transactionId)).toHaveLength(1);
    expect(stored.wagerEvents).toHaveLength(2);
  });

  test.each([
    [Kind.Bet, 'CREDIT', '80.00', '100.00', 3],
    [Kind.Win, 'DEBIT', '120.00', '100.00', 3],
    [Kind.Refund, 'DEBIT', '100.00', '80.00', 4],
  ] as const)('reverses %s with %s and replays the original result', async (kind, direction, balanceBefore, balanceAfter, version) => {
    const wallet = await open(`rollback-of-${kind}`);
    const sourceId = `rollback-original-${kind}`;
    const originalBetId = `rollback-target-refund-bet-${kind}`;
    if (kind === Kind.Refund) expect((await submit(bet(wallet, originalBetId, '20.00'))).status).toBe(200);
    const target = kind === Kind.Refund
      ? refund(wallet, sourceId, '20.00', originalBetId)
      : { ...bet(wallet, sourceId, '20.00'), kind };
    expect((await submit(target)).status).toBe(200);
    const before = await state(wallet.id, kind);
    const body = rollback(wallet, `rollback-${kind}-command`, '20.00', sourceId);
    const response = await submit(body, body.externalTransactionId, 1);
    const result = await response.json() as BetResponse;
    expect(response.status).toBe(200);
    expect(result).toEqual({ transactionId: expect.any(String), status: Status.Processed,
      balance: { amount: balanceAfter, currency: 'BRL' }, idempotentReplay: false });
    const stored = await state(wallet.id, Kind.Rollback);
    expect(stored.wallet).toMatchObject({ balance: balanceAfter, version });
    expect(stored.transactions[0]).toMatchObject({ referenceTransactionId: before.transactions[0]!.id, amount: '20.00' });
    expect(stored.entries).toHaveLength(before.entries.length + 1);
    expect(stored.entries).toEqual(expect.arrayContaining(before.entries));
    expect(stored.entries.find(({ transactionId }) => transactionId === result.transactionId))
      .toMatchObject({ direction, balanceBefore, balanceAfter, amount: '20.00' });
    expect(stored.wagerEvents.map(({ eventType }) => eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(stored.wagerEvents.find(({ eventType }) => eventType === 'WalletBalanceChanged')?.payload.data)
      .toMatchObject({ direction, walletVersion: version, balanceAfter: result.balance });

    expect((await submit(bet(wallet, `after-rollback-${kind}`, '1.00'))).status).toBe(200);
    const replay = await submit(body, body.externalTransactionId, 2);
    expect(await replay.json()).toEqual({ ...result, idempotentReplay: true });
    expect((await submit(body, `different-key-${kind}`)).status).toBe(409);
    expect((await submit({ ...body, money: { amount: '19.00', currency: 'BRL' } })).status).toBe(409);
    const afterReplay = await state(wallet.id, Kind.Rollback);
    expect(afterReplay.transactions).toHaveLength(1);
    expect(afterReplay.wagerEvents).toHaveLength(2);
  });

  test.each([Kind.Win, Kind.Refund] as const)('rejects ROLLBACK of %s without enough balance', async (kind) => {
    const wallet = await open(`insufficient-reversal-${kind}`, '20.00');
    const originalBetId = `insufficient-reversal-bet-${kind}`;
    if (kind === Kind.Refund) expect((await submit(bet(wallet, originalBetId, '20.00'))).status).toBe(200);
    const targetId = `insufficient-reversal-target-${kind}`;
    const target = kind === Kind.Refund
      ? refund(wallet, targetId, '20.00', originalBetId)
      : { ...bet(wallet, targetId, '20.00'), kind };
    expect((await submit(target)).status).toBe(200);
    expect((await submit(bet(wallet, `spend-before-reversal-${kind}`, kind === Kind.Win ? '30.00' : '10.00'))).status).toBe(200);
    const before = await state(wallet.id, kind);
    const response = await submit(rollback(wallet, `reversal-insufficient-${kind}`, '20.00', targetId));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: Status.Rejected, failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' } });
    const stored = await state(wallet.id, Kind.Rollback);
    expect(stored.wallet).toMatchObject({ balance: '10.00', version: before.wallet.version });
    expect(stored.entries).toEqual(before.entries);
    expect(stored.wagerEvents.map(({ eventType }) => eventType)).toEqual(['WagerTransactionRejected']);
    if (kind === Kind.Refund) {
      const second = await submit(rollback(wallet, 'after-failed-rollback-of-refund', '20.00', originalBetId));
      expect(second.status).toBe(422);
      expect(await second.json()).toMatchObject({ failureCode: 'BET_COMPENSATION_CONFLICT' });
    }
  });

  test('rejects invalid ROLLBACK targets, amounts and terminally rejected references', async () => {
    const wallet = await open('rollback-invalid');
    const other = await open('rollback-invalid-other');
    const sourceId = 'invalid-rollback-source-bet';
    expect((await submit(bet(wallet, sourceId, '20.00'))).status).toBe(200);
    expect((await submit({ ...bet(wallet, 'invalid-rollback-loss', '0.00'), kind: Kind.Loss })).status).toBe(200);
    expect((await submit(bet(wallet, 'invalid-rollback-rejected-bet', '200.00'))).status).toBe(422);
    const { money, ...opening } = bet(wallet, 'invalid-rollback-opening', '20.00');
    await orm.em.fork().insert(WagerTransactionRecord, {
      ...opening, id: crypto.randomUUID(), kind: Kind.Opening, status: Status.Processed, amount: money.amount, currency: money.currency,
      idempotencyKey: 'fixture-opening', payloadHash: 'fixture', createdAt: new Date(), finalizedAt: new Date(), observedBalance: '80.00',
    });
    const initialRollback = 'invalid-rollback-source-rollback';
    expect((await submit(rollback(wallet, initialRollback, '20.00', sourceId))).status).toBe(200);
    const invalid = [
      [rollback(wallet, 'rollback-loss', '1.00', 'invalid-rollback-loss'), 'INVALID_REFERENCE'],
      [rollback(wallet, 'rollback-opening', '20.00', opening.externalTransactionId), 'INVALID_REFERENCE'],
      [rollback(wallet, 'rollback-rollback', '20.00', initialRollback), 'INVALID_REFERENCE'],
      [rollback(other, 'rollback-wrong-wallet', '20.00', sourceId), 'INVALID_REFERENCE'],
      [{ ...rollback(wallet, 'rollback-wrong-round', '20.00', sourceId), roundId: 'other-round' }, 'INVALID_REFERENCE'],
      [rollback(wallet, 'rollback-amount', '19.99', sourceId), 'REFERENCE_AMOUNT_MISMATCH'],
      [rollback(wallet, 'rollback-rejected', '200.00', 'invalid-rollback-rejected-bet'), 'REFERENCE_NOT_PROCESSED'],
    ] as const;
    for (const [body, failureCode] of invalid) {
      const response = await submit(body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ status: Status.Rejected, failureCode });
    }
    expect((await submit({ ...bet(wallet, 'rollback-no-reference', '20.00'), kind: Kind.Rollback })).status).toBe(400);
    expect((await state(wallet.id, Kind.Rollback)).wallet).toMatchObject({ balance: '100.00', version: 3 });
    expect((await state(other.id, Kind.Rollback)).wallet).toMatchObject({ balance: '100.00', version: 1 });
  });

  test.each([Kind.Refund, Kind.Rollback] as const)('reserves a missing BET for pending %s against both reversal types', async (kind) => {
    const wallet = await open(`pending-compensation-${kind}`);
    const sourceId = `pending-compensation-bet-${kind}`;
    const pendingId = `pending-compensation-request-${kind}`;
    const opposite = kind === Kind.Refund ? Kind.Rollback : Kind.Refund;
    const first = { ...refund(wallet, pendingId, '20.00', sourceId), kind };
    const response = await submit(first);
    const original = await response.json() as BetResponse;
    expect(response.status).toBe(202);
    expect(original).toMatchObject({ status: Status.PendingReference });
    const sameKind = await submit({ ...first, externalTransactionId: `duplicate-${pendingId}` });
    expect(sameKind.status).toBe(409);
    const second = { ...first, externalTransactionId: `opposite-${pendingId}`, kind: opposite };
    const competing = await submit(second, second.externalTransactionId, 1);
    expect(competing.status).toBe(422);
    expect(await competing.json()).toMatchObject({ failureCode: 'BET_COMPENSATION_CONFLICT' });

    if (kind === Kind.Rollback) {
      const pendingBetId = 'already-pending-for-rollback';
      await seedPendingBet(wallet, pendingBetId, '20.00');
      expect((await submit(rollback(wallet, 'rollback-existing-pending-bet', '20.00', pendingBetId))).status).toBe(202);
    }
    const before = await state(wallet.id, kind);
    expect(before.wallet).toMatchObject({ balance: '100.00', version: 1 });
    expect(before.entries).toHaveLength(1);
    expect(before.transactions.every(({ status, referenceAttempts }) => status === Status.PendingReference && referenceAttempts === 0)).toBe(true);
    expect(before.wagerEvents.find(({ aggregateId }) => aggregateId === original.transactionId)?.payload)
      .toMatchObject({ eventType: 'WagerTransactionPendingReference', data: { referenceExternalTransactionId: sourceId } });
    expect((await submit(bet(wallet, sourceId, '20.00'))).status).toBe(200);
    const retryOpposite = await submit({ ...second, externalTransactionId: `late-${pendingId}` });
    expect(retryOpposite.status).toBe(422);
    const replay = await submit(first, pendingId, 2);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect((await state(wallet.id, kind)).wallet.balance).toBe('80.00');
  });

  test('blocks ROLLBACK of a refunded BET until the REFUND credit is undone', async () => {
    const wallet = await open('rollback-after-refund');
    const betId = 'bet-with-active-refund';
    const refundId = 'refund-to-undo';
    expect((await submit(bet(wallet, betId, '20.00'))).status).toBe(200);
    expect((await submit(refund(wallet, refundId, '20.00', betId))).status).toBe(200);
    const direct = rollback(wallet, 'rollback-blocked-by-refund', '20.00', betId);
    const blocked = await submit(direct);
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ failureCode: 'BET_COMPENSATION_CONFLICT' });
    expect((await state(wallet.id, Kind.Rollback)).wallet).toMatchObject({ balance: '100.00', version: 3 });

    expect((await submit(rollback(wallet, 'undo-active-refund', '20.00', refundId))).status).toBe(200);
    expect((await state(wallet.id, Kind.Rollback)).wallet).toMatchObject({ balance: '80.00', version: 4 });
    expect((await submit(refund(wallet, 'refund-after-undo', '20.00', betId))).status).toBe(409);
    expect((await submit({ ...direct, externalTransactionId: 'rollback-after-undo' })).status).toBe(200);
    expect((await state(wallet.id, Kind.Rollback)).wallet).toMatchObject({ balance: '100.00', version: 5 });
  });

  test('blocks a REFUND after ROLLBACK of the same BET', async () => {
    const wallet = await open('refund-after-direct-rollback');
    const sourceId = 'bet-with-active-rollback';
    expect((await submit(bet(wallet, sourceId, '20.00'))).status).toBe(200);
    expect((await submit(rollback(wallet, 'rollback-active-bet', '20.00', sourceId))).status).toBe(200);
    const response = await submit(refund(wallet, 'refund-blocked-by-rollback', '20.00', sourceId));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ failureCode: 'BET_COMPENSATION_CONFLICT' });
    expect((await state(wallet.id, Kind.Refund)).wallet).toMatchObject({ balance: '100.00', version: 3 });
  });

  test.each([[Kind.Rollback, 409], [Kind.Refund, 422]] as const)(
    'allows one compensation when ROLLBACK races against %s on an independent connection', async (otherKind, conflictStatus) => {
      const wallet = await open(`rollback-race-${otherKind}`);
      const sourceId = `rollback-race-bet-${otherKind}`;
      expect((await submit(bet(wallet, sourceId, '20.00'))).status).toBe(200);
      const first = rollback(wallet, `rollback-race-first-${otherKind}`, '20.00', sourceId);
      const second = { ...first, kind: otherKind, externalTransactionId: `rollback-race-second-${otherKind}` };
      const responses = await Promise.all([submit(first, first.externalTransactionId, 1), submit(second, second.externalTransactionId, 2)]);
      expect(responses.map(({ status }) => status).sort()).toEqual([200, conflictStatus]);
      const rejected = responses.find(({ status }) => status === conflictStatus)!;
      expect(await rejected.json()).toMatchObject({ failureCode: otherKind === Kind.Refund ? 'BET_COMPENSATION_CONFLICT' : 'DUPLICATE_ROLLBACK' });
      const stored = await state(wallet.id, Kind.Rollback);
      expect(stored.wallet).toMatchObject({ balance: '100.00', version: 3 });
      expect(stored.entries).toHaveLength(3);
      const winnerIndex = responses.findIndex(({ status }) => status === 200);
      const winner = winnerIndex === 0 ? first : second;
      const result = await responses[winnerIndex]!.json() as BetResponse;
      const replay = await submit(winner);
      expect(await replay.json()).toEqual({ ...result, idempotentReplay: true });
    },
  );
});
