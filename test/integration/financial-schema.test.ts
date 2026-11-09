import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money.js';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction.js';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry.js';
import { Wallet } from '../../src/domain/wallet.js';
import {
  ledgerEntryFromRecord, ledgerEntryToRecord, wagerTransactionFromRecord, wagerTransactionToRecord,
  walletFromRecord, walletToRecord,
} from '../../src/infrastructure/database/financial-mappers.js';
import {
  WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord,
} from '../../src/infrastructure/database/financial-records.js';
import { Migration20261107000100_FinancialSchema } from '../../src/infrastructure/database/migrations/Migration20261107000100_FinancialSchema.js';
import { Migration20261107000500_WagerImmutability } from '../../src/infrastructure/database/migrations/Migration20261107000500_WagerImmutability.js';
import { Migration20261107000600_WalletScopedReversalReservations } from '../../src/infrastructure/database/migrations/Migration20261107000600_WalletScopedReversalReservations.js';
import { Migration20261107000700_RoundScopedReversalReservations } from '../../src/infrastructure/database/migrations/Migration20261107000700_RoundScopedReversalReservations.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('financial schema on PostgreSQL', () => {
  const schema = `financial_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const migrationName = 'Migration20261107000100_FinancialSchema';
  const immutabilityMigration = 'Migration20261107000500_WagerImmutability';
  const reservationsMigration = 'Migration20261107000600_WalletScopedReversalReservations';
  const roundReservationsMigration = 'Migration20261107000700_RoundScopedReversalReservations';
  const migrations = [migrationName, immutabilityMigration, reservationsMigration, roundReservationsMigration];
  const financialTables = ['wager_transactions', 'wallet_ledger_entries', 'wallets'];
  const wagers = `"${schema}".wager_transactions`;
  let orm: MikroORM;

  function sql<T extends Record<string, unknown>[] = Record<string, unknown>[]>(
    query: string, params: unknown[] = [],
  ): Promise<T> {
    return orm.em.execute<T>(query, params);
  }

  async function schemaTables(): Promise<string[]> {
    const rows = await sql<{ table_name: string }[]>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [schema],
    );
    return rows.map(({ table_name }) => table_name);
  }

  beforeAll(async () => {
    const config = financialTestConfig(databaseUrl!, schema);
    orm = await MikroORM.init({
      ...config,
      migrations: {
        ...config.migrations,
        migrationsList: [
          Migration20261107000100_FinancialSchema, Migration20261107000500_WagerImmutability,
          Migration20261107000600_WalletScopedReversalReservations, Migration20261107000700_RoundScopedReversalReservations,
        ],
      },
    });
    expect(await sql('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    expect((await orm.migrator.getPending()).map(({ name }) => name)).toEqual(migrations);
    await orm.migrator.up({ to: migrationName });
    expect(await schemaTables()).toEqual(['mikro_orm_migrations', ...financialTables]);
    expect((await orm.migrator.getExecuted()).map(({ name }) => name)).toEqual([migrationName]);
    await orm.migrator.down();
    expect(await schemaTables()).toEqual(['mikro_orm_migrations']);
    expect(await sql('SELECT to_regprocedure(?) AS entry', [`${schema}.reject_wallet_ledger_mutation()`]))
      .toEqual([{ entry: null }]);
    expect((await orm.migrator.getPending()).map(({ name }) => name)).toEqual(migrations);
    await orm.migrator.up();
  });

  afterAll(async () => {
    if (!orm) return;
    try {
      await sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await orm.close();
    }
  });

  // Direct SQL fixtures ensure invalid data reaches PostgreSQL without domain validation.
  function insert(table: string, row: Record<string, unknown>): Promise<unknown> {
    const columns = Object.keys(row);
    return sql(
      `INSERT INTO "${schema}".${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
    );
  }

  function wallet(id: string, overrides: Record<string, unknown> = {}) {
    return insert('wallets', {
      id, player_id: `player-${id}`, currency: 'BRL', balance: '10.00',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...overrides,
    });
  }

  function transaction(id: string, walletId: string, overrides: Record<string, unknown> = {}) {
    return insert('wager_transactions', {
      id, wallet_id: walletId, player_id: `player-${walletId}`, provider_id: 'provider',
      external_transaction_id: `external-${id}`, idempotency_key: `key-${id}`, payload_hash: `hash-${id}`,
      round_id: 'round', game_id: 'game', kind: 'BET', status: 'PENDING', amount: '2.50', currency: 'BRL',
      created_at: '2026-01-01T00:00:00Z', ...overrides,
    });
  }

  function ledger(id: string, walletId: string, transactionId: string, overrides: Record<string, unknown> = {}) {
    return insert('wallet_ledger_entries', {
      id, wallet_id: walletId, transaction_id: transactionId, direction: 'DEBIT', amount: '2.50',
      currency: 'BRL', balance_before: '10.00', balance_after: '7.50', created_at: '2026-01-01T00:00:00Z', ...overrides,
    });
  }

  async function seedDebit(walletId: string) {
    await wallet(walletId);
    const transactionId = `debit-${walletId}`;
    await transaction(transactionId, walletId, {
      status: 'PROCESSED', observed_balance: '7.50', finalized_at: '2026-01-01T00:00:00Z',
    });
    return transactionId;
  }

  test('applies, reverts and reapplies the versioned schema', async () => {
    expect(await schemaTables()).toEqual(['mikro_orm_migrations', ...financialTables]);
    expect(await orm.migrator.getPending()).toHaveLength(0);
    expect((await orm.migrator.getExecuted()).map(({ name }) => name)).toEqual(migrations);
  });

  test('reverts and reapplies the wager protection without rewriting existing data', async () => {
    const walletId = 'immutability-migration';
    await wallet(walletId);
    const id = 'existing-loss';
    await transaction(id, walletId, {
      kind: 'LOSS', status: 'PROCESSED', observed_balance: '10.00', finalized_at: '2026-01-01T00:00:00Z',
    });
    const existing = await sql(`SELECT * FROM ${wagers} WHERE id = ?`, [id]);
    const guard = `${schema}.reject_wager_immutable_changes()`;

    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([roundReservationsMigration]);
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([reservationsMigration]);
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([immutabilityMigration]);
    expect(await sql('SELECT to_regprocedure(?) AS entry', [guard])).toEqual([{ entry: null }]);
    expect(await sql(`SELECT * FROM ${wagers} WHERE id = ?`, [id])).toEqual(existing);
    expect((await orm.migrator.up()).map(({ name }) => name)).toEqual([immutabilityMigration, reservationsMigration, roundReservationsMigration]);
    await expect(sql(`UPDATE ${wagers} SET observed_balance = '9.99' WHERE id = ?`, [id]))
      .rejects.toMatchObject({ code: '55000' });
    expect(await sql(`SELECT * FROM ${wagers} WHERE id = ?`, [id])).toEqual(existing);
  });

  test('protects wager identity and terminal outcomes while allowing pending transitions and scheduling', async () => {
    const walletId = 'wager-immutability';
    await wallet(walletId);
    const pending = 'immutable-pending';
    await transaction(pending, walletId, { kind: 'WIN', reference_external_transaction_id: 'late-bet' });
    for (const change of ["provider_id = 'another-provider'", "external_transaction_id = 'other-external'",
      "idempotency_key = 'other-key'", "payload_hash = 'other-hash'", "reference_external_transaction_id = 'other-bet'",
      "amount = '2.51'"]) {
      await expect(sql(`UPDATE ${wagers} SET ${change} WHERE id = ?`, [pending])).rejects.toMatchObject({ code: '55000' });
    }
    await sql(`UPDATE ${wagers} SET status = 'PENDING_REFERENCE', reference_attempts = 1,
      reference_next_attempt_at = now() WHERE id = ?`, [pending]);
    await sql(`UPDATE ${wagers} SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
      finalized_at = now(), reference_attempts = 2, reference_next_attempt_at = NULL WHERE id = ?`, [pending]);
    expect(await sql(`SELECT status, failure_code, reference_attempts, reference_next_attempt_at FROM ${wagers} WHERE id = ?`, [pending]))
      .toEqual([{ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: 2, reference_next_attempt_at: null }]);

    for (const status of ['PROCESSED', 'REJECTED', 'FAILED']) {
      const id = `immutable-${status}`;
      await transaction(id, walletId, {
        kind: 'LOSS', status, failure_code: status === 'PROCESSED' ? null : 'ORIGINAL_FAILURE',
        observed_balance: '10.00', finalized_at: '2026-01-01T00:00:00Z',
      });
      const original = await sql(`SELECT * FROM ${wagers} WHERE id = ?`, [id]);
      for (const change of ["status = 'PENDING', finalized_at = NULL, failure_code = NULL, observed_balance = NULL",
        "observed_balance = '9.99'", 'finalized_at = now()', "created_at = '2000-01-01T00:00:00Z'",
        ...(status === 'PROCESSED' ? [] : ["failure_code = 'OTHER_FAILURE'"])]) {
        await expect(sql(`UPDATE ${wagers} SET ${change} WHERE id = ?`, [id])).rejects.toMatchObject({ code: '55000' });
      }
      expect(await sql(`SELECT * FROM ${wagers} WHERE id = ?`, [id])).toEqual(original);
    }
  });

  test('rejects duplicate wallets for a player and currency', async () => {
    await wallet('original');
    await expect(wallet('duplicate', { player_id: 'player-original' })).rejects.toMatchObject({
      code: '23505', constraint: 'wallets_player_currency_unique',
    });
    await wallet('other-currency', { player_id: 'player-original', currency: 'USD' });
  });

  test('rejects negative and non-finite wallet balances and invalid versions', async () => {
    for (const balance of ['-0.01', 'NaN']) {
      await expect(wallet('invalid-balance', { balance })).rejects.toMatchObject({
        code: '23514', constraint: 'wallets_balance_check',
      });
    }
    await expect(wallet('invalid-version', { version: 0 })).rejects.toMatchObject({
      code: '23514', constraint: 'wallets_version_check',
    });
  });

  test('enforces ledger direction, amount, balances and arithmetic', async () => {
    const walletId = 'ledger-checks';
    const tx = await seedDebit(walletId);
    await expect(ledger('wrong-arithmetic', walletId, tx, { balance_after: '7.51' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ledger_arithmetic_check' });
    await expect(ledger('wrong-direction', walletId, tx, { direction: 'OTHER' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ledger_direction_check' });
    for (const amount of ['0.00', '-0.01', 'NaN']) {
      await expect(ledger('wrong-amount', walletId, tx, { amount }))
        .rejects.toMatchObject({ code: '23514', constraint: 'ledger_amount_check' });
    }
    await expect(ledger('wrong-balance', walletId, tx, { balance_before: '0.00', balance_after: '-2.50' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ledger_balances_check' });
    await ledger('valid-debit', walletId, tx);
    await expect(ledger('second-debit', walletId, tx))
      .rejects.toMatchObject({ code: '23505', constraint: 'ledger_transaction_wallet_unique' });
  });

  test('blocks UPDATE, DELETE and TRUNCATE of ledger entries', async () => {
    const walletId = 'immutable-ledger';
    const tx = await seedDebit(walletId);
    await ledger('immutable-entry', walletId, tx);

    const table = `"${schema}".wallet_ledger_entries`;
    for (const query of [
      `UPDATE ${table} SET created_at = now() WHERE id = 'immutable-entry'`,
      `DELETE FROM ${table} WHERE id = 'immutable-entry'`,
      `TRUNCATE ${table}`,
    ]) {
      await expect(sql(query)).rejects.toMatchObject({ code: '55000' });
    }
    expect(await sql(`SELECT balance_after FROM ${table} WHERE id = 'immutable-entry'`))
      .toEqual([{ balance_after: '7.50' }]);
  });

  test('scopes the external ID and idempotency key to each provider', async () => {
    const walletId = 'identity';
    await wallet(walletId);
    await transaction('original-tx', walletId);
    await expect(transaction('external-conflict', walletId, { external_transaction_id: 'external-original-tx' }))
      .rejects.toMatchObject({ code: '23505', constraint: 'wager_provider_external_unique' });
    await expect(transaction('key-conflict', walletId, { idempotency_key: 'key-original-tx' }))
      .rejects.toMatchObject({ code: '23505', constraint: 'wager_provider_idempotency_unique' });
    await transaction('other-provider', walletId, {
      provider_id: 'another-provider', external_transaction_id: 'external-original-tx', idempotency_key: 'key-original-tx',
    });
  });

  test('reserves unresolved reversals atomically by provider, wallet, round, reference and kind', async () => {
    const walletId = 'unresolved-reversal';
    await wallet(walletId);
    const pending = { kind: 'REFUND', status: 'PENDING_REFERENCE', reference_external_transaction_id: 'late-bet' };
    const results = await Promise.allSettled([
      transaction('refund-first', walletId, pending), transaction('refund-second', walletId, pending),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: '23505', constraint: 'wager_reversal_reference_unique' },
    });
    await transaction('rollback-same-reference', walletId, { ...pending, kind: 'ROLLBACK' });
    await transaction('rejected-same-reference', walletId, {
      ...pending, status: 'REJECTED', failure_code: 'DUPLICATE_REVERSAL', finalized_at: '2026-01-01T00:00:00Z',
    });
    await sql(
      `UPDATE "${schema}".wager_transactions SET status = 'FAILED', failure_code = 'PERMANENT_FAILURE', finalized_at = now()
        WHERE id IN ('refund-first', 'refund-second')`,
    );
    await transaction('refund-replacement', walletId, pending);
  });

  test('reverts and reapplies wallet-scoped reversal reservations without rewriting wagers', async () => {
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([roundReservationsMigration]);
    const first = 'reservation-migration-first';
    const second = 'reservation-migration-second';
    await wallet(first);
    await wallet(second);
    const pending = { kind: 'REFUND', status: 'PENDING_REFERENCE', reference_external_transaction_id: 'reservation-migration-bet' };
    await transaction(first, first, pending);
    await transaction(second, second, pending);
    const rows = () => sql(`SELECT * FROM ${wagers} WHERE id IN (?, ?) ORDER BY id`, [first, second]);
    const duplicate = { code: '23505', constraint: 'wager_reversal_reference_unique' };
    const before = await rows();

    await expect(orm.migrator.down()).rejects.toMatchObject({ code: '23505' });
    expect((await orm.migrator.getExecuted()).map(({ name }) => name)).toEqual(migrations.slice(0, -1));
    expect(await rows()).toEqual(before);
    await expect(transaction('reservation-migration-duplicate', second, pending)).rejects.toMatchObject(duplicate);

    await sql(`UPDATE ${wagers} SET status = 'REJECTED', failure_code = 'INVALID_REFERENCE', finalized_at = now()
      WHERE id = ?`, [second]);
    const after = await rows();
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([reservationsMigration]);
    await expect(transaction('reservation-migration-replacement', second, pending)).rejects.toMatchObject(duplicate);
    expect((await orm.migrator.up()).map(({ name }) => name)).toEqual([reservationsMigration, roundReservationsMigration]);
    expect(await rows()).toEqual(after);
    await transaction('reservation-migration-replacement', second, pending);
  });

  test('reverts and reapplies round-scoped reversal reservations without rewriting wagers', async () => {
    const walletId = 'round-reservation-migration';
    const first = 'round-reservation-first';
    const second = 'round-reservation-second';
    await wallet(walletId);
    const pending = { kind: 'REFUND', status: 'PENDING_REFERENCE', reference_external_transaction_id: 'round-reservation-bet' };
    const otherRound = { ...pending, round_id: 'other-round' };
    await transaction(first, walletId, pending);
    await transaction(second, walletId, otherRound);
    const rows = () => sql(`SELECT * FROM ${wagers} WHERE id IN (?, ?) ORDER BY id`, [first, second]);
    const duplicate = { code: '23505', constraint: 'wager_reversal_reference_unique' };
    const before = await rows();

    await expect(orm.migrator.down()).rejects.toMatchObject({ code: '23505' });
    expect((await orm.migrator.getExecuted()).map(({ name }) => name)).toEqual(migrations);
    expect(await rows()).toEqual(before);
    await expect(transaction('round-reservation-duplicate', walletId, otherRound)).rejects.toMatchObject(duplicate);

    await sql(`UPDATE ${wagers} SET status = 'REJECTED', failure_code = 'INVALID_REFERENCE', finalized_at = now()
      WHERE id = ?`, [second]);
    const after = await rows();
    expect((await orm.migrator.down()).map(({ name }) => name)).toEqual([roundReservationsMigration]);
    await expect(transaction('round-reservation-replacement', walletId, otherRound)).rejects.toMatchObject(duplicate);
    expect((await orm.migrator.up()).map(({ name }) => name)).toEqual([roundReservationsMigration]);
    expect(await rows()).toEqual(after);
    await transaction('round-reservation-replacement', walletId, otherRound);
  });

  test('checks transaction state shape and reference scheduling fields', async () => {
    const walletId = 'state-checks';
    await wallet(walletId);
    const invalidRows = [
      [{ kind: 'OTHER' }, 'wager_kind_check'],
      [{ status: 'OTHER' }, 'wager_status_check'],
      [{ amount: '-0.01' }, 'wager_amount_check'],
      [{ observed_balance: 'NaN', status: 'PROCESSED', finalized_at: '2026-01-01T00:00:00Z' }, 'wager_observed_balance_check'],
      [{ status: 'REJECTED', finalized_at: '2026-01-01T00:00:00Z' }, 'wager_outcome_check'],
      [{ kind: 'REFUND' }, 'wager_reference_shape_check'],
      [{ reference_attempts: -1 }, 'wager_reference_attempts_check'],
    ] as const;

    for (const [overrides, constraint] of invalidRows) {
      await expect(transaction('invalid-state', walletId, overrides)).rejects.toMatchObject({ code: '23514', constraint });
    }
  });

  test('enforces wallet, resolved reference and ledger foreign keys', async () => {
    const walletId = 'references';
    const tx = await seedDebit(walletId);
    await expect(transaction('missing-wallet-tx', 'missing')).rejects.toMatchObject({ code: '23503', constraint: 'wager_wallet_fk' });
    await expect(transaction('wrong-player-tx', walletId, { player_id: 'other-player' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'wager_wallet_fk' });
    await expect(transaction('wrong-currency-tx', walletId, { currency: 'USD' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'wager_wallet_fk' });

    const resolved = {
      kind: 'REFUND', status: 'PROCESSED', reference_transaction_id: tx,
      reference_external_transaction_id: `external-${tx}`, finalized_at: '2026-01-01T00:00:00Z', observed_balance: '10.00',
    };
    await expect(transaction('wrong-reference', walletId, { ...resolved, reference_external_transaction_id: 'other-external' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'wager_reference_fk' });
    await expect(transaction('wrong-round', walletId, { ...resolved, round_id: 'other-round' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'wager_reference_fk' });
    await transaction('valid-reference', walletId, resolved);
    await expect(transaction('duplicate-resolved', walletId, { ...resolved, status: 'PENDING_REFERENCE',
      reference_transaction_id: null, finalized_at: null, observed_balance: null }))
      .rejects.toMatchObject({ code: '23505', constraint: 'wager_reversal_reference_unique' });

    await expect(ledger('missing-transaction', walletId, 'missing')).rejects.toMatchObject({ code: '23503', constraint: 'ledger_transaction_fk' });
    await expect(ledger('wrong-ledger-currency', walletId, tx, { currency: 'USD' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'ledger_transaction_fk' });
    await expect(ledger('wrong-ledger-amount', walletId, tx, { amount: '2.49', balance_after: '7.51' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'ledger_transaction_fk' });
  });

  test('allows ledger entries only for processed balance-affecting transactions', async () => {
    const walletId = 'ledger-eligibility';
    await wallet(walletId);
    await transaction('pending-ledger-tx', walletId);
    await transaction('loss-ledger-tx', walletId, { kind: 'LOSS', status: 'PROCESSED', finalized_at: '2026-01-01T00:00:00Z' });
    await transaction('rejected-ledger-tx', walletId, {
      status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', finalized_at: '2026-01-01T00:00:00Z',
    });

    for (const tx of ['pending-ledger-tx', 'loss-ledger-tx', 'rejected-ledger-tx']) {
      await expect(ledger(`entry-${tx}`, walletId, tx)).rejects.toMatchObject({ code: '23503', constraint: 'ledger_transaction_fk' });
    }
    const pending = await orm.em.fork().findOneOrFail(WagerTransactionRecord, 'pending-ledger-tx');
    expect(wagerTransactionFromRecord(pending).observedBalance).toBeUndefined();
  });

  test('round trips NUMERIC values, including original observed balance, through ORM and domain', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const max = '999999999999999999.99';
    const balance = Money.from({ amount: max, currency: 'BRL' });
    const aggregate = Wallet.open({ id: 'precision-wallet', playerId: 'precision-player', initialBalance: balance }, at);
    const opening = WagerTransaction.create({
      id: 'precision-opening', providerId: 'internal', externalTransactionId: 'precision-opening',
      idempotencyKey: 'precision-opening-key', payloadHash: 'precision-opening-hash',
      walletId: aggregate.id, playerId: aggregate.playerId, roundId: 'opening', gameId: 'opening',
      kind: WagerTransactionKind.Opening, money: balance, createdAt: at,
    });
    opening.markProcessed({ observedBalance: balance, at });
    const entry = WalletLedgerEntry.create({
      id: 'precision-ledger', walletId: aggregate.id, transactionId: opening.id, direction: LedgerDirection.Credit,
      money: balance, balanceBefore: Money.zero('BRL'), balanceAfter: balance, createdAt: at,
    });

    const em = orm.em.fork();
    await em.transactional(async (tx) => {
      await tx.insert(WalletRecord, walletToRecord(aggregate));
      await tx.insert(WagerTransactionRecord, wagerTransactionToRecord(opening));
      await tx.insert(WalletLedgerEntryRecord, ledgerEntryToRecord(entry));
    });

    const storedWallet = await em.findOneOrFail(WalletRecord, aggregate.id);
    const storedOpening = await em.findOneOrFail(WagerTransactionRecord, opening.id);
    const storedEntry = await em.findOneOrFail(WalletLedgerEntryRecord, entry.id);
    expect(storedWallet.balance).toBe(max);
    expect(storedOpening.amount).toBe(max);
    expect(storedOpening.observedBalance).toBe(max);
    expect(storedOpening.referenceAttempts).toBe(0);
    expect(storedEntry.balanceBefore).toBe('0.00');
    expect(storedEntry.amount).toBe(max);
    expect(storedEntry.balanceAfter).toBe(max);
    expect(walletFromRecord(storedWallet).balance.equals(balance)).toBe(true);
    expect(wagerTransactionFromRecord(storedOpening).observedBalance?.equals(balance)).toBe(true);
    expect(ledgerEntryFromRecord(storedEntry).isBalanced()).toBe(true);
  });
});
