import type { EntityManager } from '@mikro-orm/postgresql';
import { FinancialQueriesUnavailableError, type FinancialReadStore } from '../../application/financial-queries.js';
import type { WalletReconciliation, WalletReconciliationStore } from '../../application/reconcile-wallet.js';
import { WagerTransactionKind } from '../../domain/wager-transaction.js';
import { ledgerEntryFromRecord, wagerTransactionFromRecord, walletFromRecord } from './financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';
import { isTransientPostgresConnectionError } from './postgres-errors.js';

export class PostgresFinancialQueries implements FinancialReadStore, WalletReconciliationStore {
  constructor(private readonly em: EntityManager) {}

  findWallet(walletId: string) {
    return this.#read(async (em) => {
      const row = await em.findOne(WalletRecord, walletId);
      return row ? walletFromRecord(row) : null;
    });
  }

  findTransaction(transactionId: string) {
    return this.#read(async (em) => {
      const row = await em.findOne(WagerTransactionRecord, transactionId);
      return row ? wagerTransactionFromRecord(row) : null;
    });
  }

  findProviderTransaction(providerId: string, externalTransactionId: string) {
    if (providerId === 'internal:wallet-opening') return Promise.resolve(null);
    return this.#read(async (em) => {
      const row = await em.findOne(WagerTransactionRecord, {
        providerId, externalTransactionId, kind: { $ne: WagerTransactionKind.Opening },
      });
      return row ? wagerTransactionFromRecord(row) : null;
    });
  }

  listLedger(walletId: string, limit: number, afterId?: string) {
    return this.#read(async (em) => {
      const schema = em.schema ?? em.config.getSchema() ?? 'public';
      const table = em.getPlatform().quoteIdentifier(`${schema}.${em.getMetadata(WalletLedgerEntryRecord).tableName}`);
      if (afterId !== undefined && !await em.findOne(WalletLedgerEntryRecord, { walletId, id: afterId }, { fields: ['id'] })) {
        return null;
      }

      // Resolve the immutable anchor in SQL so sub-millisecond timestamp precision is retained.
      const after = afterId === undefined ? '' : `
        AND (entry.created_at, entry.id) < (
          SELECT anchor.created_at, anchor.id FROM ${table} AS anchor
          WHERE anchor.wallet_id = ? AND anchor.id = ?
        )`;
      const params = afterId === undefined ? [walletId, limit] : [walletId, walletId, afterId, limit];
      const rows = await em.execute<Record<string, unknown>[]>(`
        SELECT entry.* FROM ${table} AS entry
        WHERE entry.wallet_id = ? ${after}
        ORDER BY entry.created_at DESC, entry.id DESC
        LIMIT ?
      `, params);

      return rows.map((row) => ledgerEntryFromRecord(em.map(WalletLedgerEntryRecord, row)));
    });
  }

  readReconciliation(walletId: string): Promise<WalletReconciliation | null> {
    return this.#read(async (em) => {
      const schema = em.schema ?? em.config.getSchema() ?? 'public';
      const platform = em.getPlatform();
      const wallets = platform.quoteIdentifier(`${schema}.${em.getMetadata(WalletRecord).tableName}`);
      const ledger = platform.quoteIdentifier(`${schema}.${em.getMetadata(WalletLedgerEntryRecord).tableName}`);
      const [row] = await em.execute<{
        wallet_id: string;
        currency: string;
        stored_balance: string;
        calculated_balance: string;
        difference: string;
        consistent: boolean;
        checked_entries: string;
      }[]>(`
        SELECT wallet.id AS wallet_id, wallet.currency, wallet.balance::text AS stored_balance,
               ledger.balance::text AS calculated_balance, (wallet.balance - ledger.balance)::text AS difference,
               wallet.balance = ledger.balance AS consistent, ledger.checked_entries::text AS checked_entries
        FROM ${wallets} AS wallet
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(CASE entry.direction WHEN 'CREDIT' THEN entry.amount ELSE -entry.amount END), 0.00) AS balance,
                 COUNT(*) AS checked_entries
          FROM ${ledger} AS entry
          WHERE entry.wallet_id = wallet.id
        ) AS ledger
        WHERE wallet.id = ?
      `, [walletId]);
      if (!row) return null;

      const checkedEntries = Number(row.checked_entries);
      if (!Number.isSafeInteger(checkedEntries) || checkedEntries < 0) {
        throw new RangeError('Ledger entry count exceeds the supported range.');
      }

      return {
        walletId: row.wallet_id,
        storedBalance: { amount: row.stored_balance, currency: row.currency },
        calculatedBalance: { amount: row.calculated_balance, currency: row.currency },
        difference: { amount: row.difference, currency: row.currency },
        consistent: row.consistent,
        checkedEntries,
      };
    });
  }

  async #read<T>(read: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await read(this.em.fork());
    } catch (error) {
      if (isTransientPostgresConnectionError(error)) {
        throw new FinancialQueriesUnavailableError('Financial queries are temporarily unavailable.', { cause: error });
      }
      throw error;
    }
  }
}
