import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError, WalletOpeningUnavailableError, type WalletOpeningStore } from '../../application/open-wallet.js';
import type { Wallet } from '../../domain/wallet.js';
import { ledgerEntryToRecord, wagerTransactionToRecord, walletToRecord } from './financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';
import { insertOutboxEvents } from './outbox-record.js';
import { isTransientPostgresWriteError } from './postgres-errors.js';
import { postgresNow } from './postgres-time.js';
import { logEvent } from '../observability/log.js';
import { processingMetrics } from '../observability/processing-metrics.js';

export class PostgresWalletOpeningStore implements WalletOpeningStore {
  constructor(private readonly em: EntityManager) {}

  async save(build: Parameters<WalletOpeningStore['save']>[0]): Promise<Wallet> {
    const startedAt = performance.now();
    try {
      const { wallet, opening } = await this.em.fork().transactional(async (tx) => {
        const { wallet, opening } = build(await postgresNow(tx));
        await tx.insert(WalletRecord, walletToRecord(wallet));
        if (opening) {
          await tx.insert(WagerTransactionRecord, wagerTransactionToRecord(opening.transaction));
          await tx.insert(WalletLedgerEntryRecord, ledgerEntryToRecord(opening.entry));
          await insertOutboxEvents(tx, opening.events);
        }
        return { wallet, opening };
      });
      logEvent({
        event: 'wallet_opened', walletId: wallet.id, correlationId: wallet.id,
        transactionId: opening?.transaction.id, providerId: opening?.transaction.providerId,
      });
      return wallet;
    } catch (error) {
      processingMetrics.recordLockConflict('http', error);
      if (error instanceof UniqueConstraintViolationException &&
          'constraint' in error && error.constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError();
      }
      if (isTransientPostgresWriteError(error)) {
        throw new WalletOpeningUnavailableError('Wallet opening is temporarily unavailable.', { cause: error });
      }
      throw error;
    } finally {
      processingMetrics.observe('http', startedAt);
    }
  }
}
