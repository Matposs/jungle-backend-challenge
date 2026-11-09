import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { OpenWallet } from '../../src/application/open-wallet.js';
import { applyWager, SubmitWager } from '../../src/application/submit-wager.js';
import { Money } from '../../src/domain/money.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import { wagerTransactionFromRecord, walletFromRecord } from '../../src/infrastructure/database/financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { PendingReferenceWorker } from '../../src/infrastructure/database/pending-reference-worker.js';
import { PostgresWagerStore } from '../../src/infrastructure/database/postgres-wager-store.js';
import { PostgresWalletOpeningStore } from '../../src/infrastructure/database/postgres-wallet-opening-store.js';
import { processingMetrics } from '../../src/infrastructure/observability/processing-metrics.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;
const dayMs = 24 * 60 * 60 * 1000;

describe.skipIf(!databaseUrl)('Pending reference worker on PostgreSQL', () => {
  const schema = `financial_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const wagers = `"${schema}".wager_transactions`;
  const wallets = `"${schema}".wallets`;
  const outbox = `"${schema}".outbox_messages`;
  let orm: MikroORM;
  let peer: MikroORM;

  beforeAll(async () => {
    const config = financialTestConfig(databaseUrl!, schema);
    orm = await MikroORM.init(config);
    expect(await orm.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    await orm.migrator.up();
    peer = await MikroORM.init(config);
  });

  afterAll(async () => {
    try {
      if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await peer?.close();
      await orm?.close();
    }
  });

  function worker(connection = orm) {
    return new PendingReferenceWorker(new PostgresWagerStore(connection.em));
  }

  function brl(amount: string) {
    return Money.from({ amount, currency: 'BRL' });
  }

  async function scenario() {
    const wallet = await new OpenWallet(new PostgresWalletOpeningStore(orm.em)).execute(crypto.randomUUID(), brl('100.00'));
    const submit = new SubmitWager(new PostgresWagerStore(peer.em));
    function input(kind: Kind.Bet | Kind.Win | Kind.Refund | Kind.Rollback, id: string, reference?: string) {
      const externalTransactionId = `${wallet.id}:${id}`;
      return {
        kind, externalTransactionId, idempotencyKey: externalTransactionId, providerId: 'provider-a',
        playerId: wallet.playerId, walletId: wallet.id, roundId: 'round', gameId: 'game', money: brl('20.00'),
        referenceExternalTransactionId: reference && `${wallet.id}:${reference}`,
      };
    }
    return { wallet, submit, input };
  }

  function row(id: string) {
    return orm.em.fork().findOneOrFail(WagerTransactionRecord, id);
  }

  async function databaseTime() {
    const [{ at }] = await orm.em.execute<{ at: string }[]>('SELECT clock_timestamp() AS at');
    return new Date(at).getTime();
  }

  function makeDue(id: string) {
    return orm.em.fork().nativeUpdate(WagerTransactionRecord, { id }, { referenceNextAttemptAt: null });
  }

  async function expectEvents(id: string, types: string[]) {
    const events = await orm.em.execute<{ event_type: string }[]>(
      `SELECT event_type FROM ${outbox} WHERE aggregate_id = ? ORDER BY publication_order`, [id],
    );
    expect(events.map(({ event_type }) => event_type)).toEqual(['WagerTransactionPendingReference', ...types]);
  }

  async function expectBalance(walletId: string, balance: string, version: number) {
    const em = orm.em.fork();
    expect(await em.findOneOrFail(WalletRecord, walletId)).toMatchObject({ balance, version });
    expect(await em.execute(
      `SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::numeric(20,2) AS balance
       FROM "${schema}".wallet_ledger_entries WHERE wallet_id = ?`, [walletId],
    )).toEqual([{ balance }]);
  }

  test.each([Kind.Win, Kind.Refund, Kind.Rollback] as const)('resolves a late BET for %s once and replays the original result', async (kind) => {
    const { wallet, submit, input } = await scenario();
    const dependent = input(kind, 'dependent', 'bet');
    const { transaction: pending } = await submit.execute(dependent);
    expect(pending.status).toBe(Status.PendingReference);
    const { transaction: bet } = await submit.execute(input(Kind.Bet, 'bet'));

    await Promise.all([worker().processBatch(), worker(peer).processBatch()]);
    expect(await row(pending.id)).toMatchObject({
      status: Status.Processed, referenceTransactionId: bet.id, referenceAttempts: 1,
      referenceNextAttemptAt: null, observedBalance: '100.00',
      payloadHash: pending.payloadHash, externalTransactionId: dependent.externalTransactionId,
    });
    expect(await orm.em.fork().count(WalletLedgerEntryRecord, { transactionId: pending.id })).toBe(1);
    expect(await orm.em.execute(
      `SELECT event_type FROM ${outbox} WHERE aggregate_id = ? AND payload #>> '{data,transactionId}' = ?`,
      [wallet.id, pending.id],
    )).toEqual([{ event_type: 'WalletBalanceChanged' }]);
    await expectBalance(wallet.id, '100.00', 3);
    await expectEvents(pending.id, ['WagerTransactionProcessed']);

    await submit.execute(input(Kind.Bet, 'another-debit'));
    const replay = await submit.execute(dependent);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction).toMatchObject({ id: pending.id, status: Status.Processed });
    expect(replay.transaction.observedBalance?.toJSON().amount).toBe('100.00');
    await expectBalance(wallet.id, '80.00', 4);
  });

  test('keeps the pending reference TTL on PostgreSQL time across instances with divergent clocks', async () => {
    const { wallet, submit, input } = await scenario();
    const before = await databaseTime();
    setSystemTime(before - 2 * dayMs);
    try {
      const { transaction: pending } = await submit.execute(input(Kind.Refund, 'skewed-refund', 'skewed-bet'));
      const stored = await row(pending.id);
      expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(stored.createdAt.getTime()).toBeLessThanOrEqual(await databaseTime());
      expect(pending.createdAt).toEqual(stored.createdAt);
      const [event] = await orm.em.execute<{ occurred_at: string; payload: { occurredAt: string } }[]>(
        `SELECT occurred_at, payload FROM ${outbox} WHERE aggregate_id = ?`, [pending.id],
      );
      expect(new Date(event!.occurred_at)).toEqual(stored.createdAt);
      expect(event!.payload.occurredAt).toBe(stored.createdAt.toISOString());

      setSystemTime(before + 2 * dayMs);
      await worker(orm).processBatch();
      const rescheduled = await row(pending.id);
      expect(rescheduled).toMatchObject({ status: Status.PendingReference, referenceAttempts: 1 });
      expect(rescheduled.referenceNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(stored.createdAt.getTime() + 5000);
      expect(rescheduled.referenceNextAttemptAt!.getTime()).toBeLessThanOrEqual(await databaseTime() + 5000);

      await submit.execute(input(Kind.Bet, 'skewed-bet'));
      await makeDue(pending.id);
      await worker(orm).processBatch();
      const processed = await row(pending.id);
      expect(processed).toMatchObject({ status: Status.Processed, referenceAttempts: 2 });
      expect(processed.finalizedAt!.getTime()).toBeLessThanOrEqual(await databaseTime());
      await expectBalance(wallet.id, '100.00', 3);
    } finally { setSystemTime(); }
  });

  test('reschedules a ROLLBACK of a pending WIN and resolves the chain after worker restart', async () => {
    const { wallet, submit, input } = await scenario();
    const { transaction: rollback } = await submit.execute(input(Kind.Rollback, 'rollback', 'win'));
    const { transaction: win } = await submit.execute(input(Kind.Win, 'win', 'bet'));
    const first = worker();
    const retries = /processing_retries_total\{component="references"\} (\d+)/;
    const before = Number(retries.exec(processingMetrics.render())![1]);
    await first.processBatch();
    first.stop();
    expect(Number(retries.exec(processingMetrics.render())![1])).toBe(before + 2);
    expect(await row(rollback.id)).toMatchObject({
      status: Status.PendingReference, referenceAttempts: 1, referenceNextAttemptAt: expect.any(Date),
    });
    await expectEvents(rollback.id, []);

    await submit.execute(input(Kind.Bet, 'bet'));
    const restarted = worker(peer);
    await makeDue(win.id);
    await restarted.processBatch();
    expect((await row(rollback.id)).referenceAttempts).toBe(1);
    await makeDue(rollback.id);
    await restarted.processBatch();
    expect(await row(rollback.id)).toMatchObject({
      status: Status.Processed, referenceAttempts: 2, referenceTransactionId: win.id, observedBalance: '80.00',
    });
    await expectBalance(wallet.id, '80.00', 4);
    await expectEvents(win.id, ['WagerTransactionProcessed']);
    await expectEvents(rollback.id, ['WagerTransactionProcessed']);
  });

  test('processes an older due retry before a batch of new references', async () => {
    const { wallet, submit, input } = await scenario();
    const { transaction: retry } = await submit.execute(input(Kind.Win, 'retry', 'bet'));
    await orm.em.execute(
      `UPDATE ${wagers} SET reference_attempts = 1, reference_next_attempt_at = clock_timestamp() - interval '1 minute' WHERE id = ?`,
      [retry.id],
    );
    const newIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      const { transaction } = await submit.execute(input(Kind.Win, `new-${index}`, 'bet'));
      newIds.push(transaction.id);
    }
    await submit.execute(input(Kind.Bet, 'bet'));

    const runner = worker();
    await runner.processBatch();
    expect(await row(retry.id)).toMatchObject({ status: Status.Processed, referenceAttempts: 2 });
    const firstBatch = await orm.em.fork().count(WagerTransactionRecord, { id: { $in: newIds }, status: Status.Processed });
    expect(firstBatch).toBe(9);
    await runner.processBatch();
    await expectBalance(wallet.id, '300.00', 13);
  });

  test('persists exponential backoff, caps delay and expires a missing reference with a single rejection', async () => {
    const { wallet, submit, input } = await scenario();
    const dependent = input(Kind.Refund, 'refund', 'missing');
    const { transaction: pending } = await submit.execute(dependent);
    const runner = worker();
    for (const [previousAttempts, delay] of [[0, 5000], [1, 10000], [6, 300000]] as const) {
      await orm.em.fork().nativeUpdate(WagerTransactionRecord, { id: pending.id }, {
        referenceAttempts: previousAttempts, referenceNextAttemptAt: null,
      });
      const before = await databaseTime();
      await runner.processBatch();
      const after = await databaseTime();
      const stored = await row(pending.id);
      expect(stored.referenceAttempts).toBe(previousAttempts + 1);
      expect(stored.referenceNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + delay);
      expect(stored.referenceNextAttemptAt!.getTime()).toBeLessThanOrEqual(after + delay);
      await runner.processBatch();
      expect((await row(pending.id)).referenceAttempts).toBe(previousAttempts + 1);
    }

    await expectEvents(pending.id, []);
    const nearDeadline = new Date(await databaseTime() - dayMs + 60_000);
    await orm.em.fork().nativeUpdate(WagerTransactionRecord, { id: pending.id }, {
      createdAt: nearDeadline, referenceNextAttemptAt: null,
    });
    await runner.processBatch();
    expect((await row(pending.id)).referenceNextAttemptAt).toEqual(new Date(nearDeadline.getTime() + dayMs));

    await orm.em.execute(`UPDATE ${wagers} SET created_at = now() - interval '25 hours', reference_next_attempt_at = now() WHERE id = ?`, [pending.id]);
    await Promise.all([runner.processBatch(), worker(peer).processBatch()]);
    const replay = await submit.execute(dependent);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction).toMatchObject({ id: pending.id, status: Status.Rejected, failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await row(pending.id)).toMatchObject({ referenceAttempts: 9, referenceNextAttemptAt: null });
    await expectBalance(wallet.id, '100.00', 1);
    await expectEvents(pending.id, ['WagerTransactionRejected']);

    await submit.execute(input(Kind.Bet, 'missing'));
    await runner.processBatch();
    expect((await row(pending.id)).status).toBe(Status.Rejected);
    expect((await submit.execute(input(Kind.Refund, 'new-refund', 'missing'))).transaction.status).toBe(Status.Processed);
    await expectBalance(wallet.id, '100.00', 3);
  });

  test('expires an existing but nonterminal reference with its own code', async () => {
    const { wallet, submit, input } = await scenario();
    const { transaction: win } = await submit.execute(input(Kind.Win, 'win', 'missing'));
    const { transaction: rollback } = await submit.execute(input(Kind.Rollback, 'rollback', 'win'));
    await orm.em.fork().nativeUpdate(WagerTransactionRecord, { id: win.id }, {
      referenceNextAttemptAt: new Date(await databaseTime() + 3_600_000),
    });
    await orm.em.execute(`UPDATE ${wagers} SET created_at = now() - interval '25 hours' WHERE id = ?`, [rollback.id]);
    await worker().processBatch();
    expect(await row(rollback.id)).toMatchObject({
      status: Status.Rejected, failureCode: 'REFERENCE_NOT_READY', referenceTransactionId: win.id,
    });
    await expectBalance(wallet.id, '100.00', 1);
    await expectEvents(rollback.id, ['WagerTransactionRejected']);
  });

  test.each([
    ['before the deadline', 23, Status.Processed],
    ['after the deadline', 25, Status.Rejected],
  ] as const)('evaluates a reference arriving %s using the PostgreSQL clock', async (_label, ageHours, status) => {
    const { wallet, submit, input } = await scenario();
    const { transaction: pending } = await submit.execute(input(Kind.Win, 'win', 'bet'));
    await orm.em.fork().nativeUpdate(WagerTransactionRecord, { id: pending.id }, {
      createdAt: new Date(await databaseTime() - ageHours * 3_600_000),
    });
    const { transaction: bet } = await submit.execute(input(Kind.Bet, 'bet'));
    const runner = worker();
    const running = runner.run();
    try {
      const timeout = performance.now() + 3000;
      let result = await row(pending.id);
      while (result.status === Status.PendingReference && performance.now() < timeout) {
        await Bun.sleep(20);
        result = await row(pending.id);
      }
      expect(result).toMatchObject({ status, referenceTransactionId: bet.id, referenceAttempts: 1 });
    } finally {
      runner.stop();
      await running;
    }
    if (status === Status.Rejected) {
      expect((await row(pending.id)).failureCode).toBe('REFERENCE_WINDOW_EXPIRED');
      await expectBalance(wallet.id, '80.00', 2);
      await expectEvents(pending.id, ['WagerTransactionRejected']);
    } else {
      await expectBalance(wallet.id, '100.00', 3);
      await expectEvents(pending.id, ['WagerTransactionProcessed']);
    }
  });

  test('rejects a valid reference at the exact evaluation deadline', async () => {
    const { wallet, submit, input } = await scenario();
    const { transaction: pending } = await submit.execute(input(Kind.Win, 'win', 'bet'));
    const { transaction: bet } = await submit.execute(input(Kind.Bet, 'bet'));
    const cutoff = await databaseTime();
    await orm.em.fork().nativeUpdate(WagerTransactionRecord, { id: pending.id }, { createdAt: new Date(cutoff - dayMs) });
    const stored = await row(pending.id);
    const candidate = wagerTransactionFromRecord(stored);
    const walletRecord = await orm.em.fork().findOneOrFail(WalletRecord, wallet.id);
    // Feed the same database instant to the decision as its deadline for deterministic equality.
    const effects = await applyWager(walletFromRecord(walletRecord), candidate, bet,
      async () => false, new Date(cutoff), stored.createdAt.getTime() + dayMs);
    expect(candidate).toMatchObject({ status: Status.Rejected, failureCode: 'REFERENCE_WINDOW_EXPIRED' });
    expect(effects.entry).toBeUndefined();
    expect(effects.events.map(({ eventType }) => eventType)).toEqual(['WagerTransactionRejected']);

    await worker().processBatch();
    await expectBalance(wallet.id, '80.00', 2);
    await expectEvents(pending.id, ['WagerTransactionRejected']);
  });

  test('skips a wallet locked by a concurrent submission and preserves reversal exclusivity', async () => {
    const hot = await scenario();
    const free = await scenario();
    const { transaction: refund } = await hot.submit.execute(hot.input(Kind.Refund, 'refund', 'bet'));
    const { transaction: win } = await free.submit.execute(free.input(Kind.Win, 'win', 'bet'));
    await hot.submit.execute(hot.input(Kind.Bet, 'bet'));
    await free.submit.execute(free.input(Kind.Bet, 'bet'));

    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = orm.em.fork().transactional(async (tx) => {
      await tx.execute(`SELECT id FROM ${wallets} WHERE id = ? FOR UPDATE`, [hot.wallet.id]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const competing = hot.submit.execute(hot.input(Kind.Rollback, 'rollback', 'bet'));
    try {
      await worker(peer).processBatch();
      expect((await row(win.id)).status).toBe(Status.Processed);
      expect((await row(refund.id)).status).toBe(Status.PendingReference);
    } finally {
      release.resolve();
      await holding;
    }

    const [result] = await Promise.all([competing, worker().processBatch()]);
    expect(result.transaction).toMatchObject({ status: Status.Rejected, failureCode: 'BET_COMPENSATION_CONFLICT' });
    await worker().processBatch();
    expect((await row(refund.id)).status).toBe(Status.Processed);
    await expectBalance(hot.wallet.id, '100.00', 3);
    await expectBalance(free.wallet.id, '100.00', 3);
  });

  test('rolls back finalization, retry count, wallet, ledger and Outbox on commit failure', async () => {
    const { wallet, submit, input } = await scenario();
    const { transaction: pending } = await submit.execute(input(Kind.Win, 'win', 'bet'));
    await submit.execute(input(Kind.Bet, 'bet'));
    await orm.em.execute(`
      CREATE FUNCTION "${schema}".fail_pending_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PROCESSED' THEN
          RAISE EXCEPTION 'pending commit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE CONSTRAINT TRIGGER fail_pending_commit AFTER UPDATE ON ${wagers}
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_pending_commit();
    `);
    try {
      await expect(new PostgresWagerStore(orm.em).processNextPendingReference()).rejects.toMatchObject({
        transactionId: pending.id, cause: expect.objectContaining({ message: expect.stringContaining('pending commit failure') }),
      });
      expect(await row(pending.id)).toMatchObject({ status: Status.PendingReference, referenceAttempts: 0 });
      await expectBalance(wallet.id, '80.00', 2);
      await expectEvents(pending.id, []);
      expect(await orm.em.fork().count(WalletLedgerEntryRecord, { transactionId: pending.id })).toBe(0);
    } finally {
      await orm.em.execute(`DROP TRIGGER fail_pending_commit ON ${wagers}`);
    }

    await worker(peer).processBatch();
    expect(await row(pending.id)).toMatchObject({ status: Status.Processed, referenceAttempts: 1 });
    await expectEvents(pending.id, ['WagerTransactionProcessed']);
    await expectBalance(wallet.id, '100.00', 3);
  });

  test('keeps other wallets moving across cycles when one pending reference repeatedly fails', async () => {
    const broken = await scenario();
    const healthy = await scenario();
    const { transaction: failing } = await broken.submit.execute(broken.input(Kind.Win, 'win', 'bet'));
    await broken.submit.execute(broken.input(Kind.Bet, 'bet'));
    const { transaction: first } = await healthy.submit.execute(healthy.input(Kind.Win, 'first', 'bet'));
    await healthy.submit.execute(healthy.input(Kind.Bet, 'bet'));

    // Sequence increments survive rollback, so they count actual attempts by the worker.
    const sequence = `"${schema}".persistent_pending_attempts`;
    await orm.em.execute(`
      CREATE SEQUENCE ${sequence};
      CREATE FUNCTION "${schema}".fail_one_pending_reference() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = TG_ARGV[0] AND OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PROCESSED' THEN
          PERFORM nextval('${sequence}');
          RAISE EXCEPTION 'persistent pending reference failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE CONSTRAINT TRIGGER fail_one_pending_reference AFTER UPDATE ON ${wagers}
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION "${schema}".fail_one_pending_reference('${failing.id}');
    `);
    const runner = worker();
    try {
      await runner.processBatch();
      expect((await row(first.id)).status).toBe(Status.Processed);
      expect(await orm.em.execute(`SELECT last_value::integer, is_called FROM ${sequence}`))
        .toEqual([{ last_value: 1, is_called: true }]);

      const { transaction: second } = await healthy.submit.execute(healthy.input(Kind.Win, 'second', 'next-bet'));
      await healthy.submit.execute(healthy.input(Kind.Bet, 'next-bet'));
      await runner.processBatch();
      expect((await row(second.id)).status).toBe(Status.Processed);
      expect(await orm.em.execute(`SELECT last_value::integer FROM ${sequence}`)).toEqual([{ last_value: 1 }]);

      // The operational pause belongs to the worker instance. Another instance may retry.
      await worker(peer).processBatch();
      expect(await orm.em.execute(`SELECT last_value::integer FROM ${sequence}`)).toEqual([{ last_value: 2 }]);
      expect(await row(failing.id)).toMatchObject({ status: Status.PendingReference, referenceAttempts: 0, referenceNextAttemptAt: null });
      await expectEvents(failing.id, []);
      await expectBalance(broken.wallet.id, '80.00', 2);
      await expectBalance(healthy.wallet.id, '100.00', 5);
    } finally {
      await orm.em.execute(`DROP TRIGGER fail_one_pending_reference ON ${wagers}`);
    }
    await worker(peer).processBatch();
    expect(await row(failing.id)).toMatchObject({ status: Status.Processed, referenceAttempts: 1 });
    await expectEvents(failing.id, ['WagerTransactionProcessed']);
  });
});
