import { ConnectionException, DriverException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { FinancialQueriesUnavailableError, type FinancialReadStore } from '../../application/financial-queries.js';
import { WagerTransactionKind } from '../../domain/wager-transaction.js';
import { ledgerEntryFromRecord, wagerTransactionFromRecord, walletFromRecord } from './financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';

const TRANSIENT_CONNECTION_CODES = new Set([
  '08001', '08003', '08006', '57P01', '57P02', '57P03', '53300',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
]);

// pg and pg-pool report these transport and pool errors without a code.
const UNCODED_CONNECTION_ERRORS = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'timeout expired',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
]);

export class PostgresFinancialQueries implements FinancialReadStore {
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

  async #read<T>(read: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await read(this.em.fork());
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (error instanceof ConnectionException || TRANSIENT_CONNECTION_CODES.has(code) ||
          (error instanceof DriverException && !error.code && UNCODED_CONNECTION_ERRORS.has(error.message))) {
        throw new FinancialQueriesUnavailableError('Financial queries are temporarily unavailable.', { cause: error });
      }
      throw error;
    }
  }
}
