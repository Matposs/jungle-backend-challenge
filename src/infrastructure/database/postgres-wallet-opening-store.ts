import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError, type FinancialOpening, type WalletOpeningStore } from '../../application/open-wallet.js';
import type { Wallet } from '../../domain/wallet.js';
import { ledgerEntryToRecord, wagerTransactionToRecord, walletToRecord } from './financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';
import { insertOutboxEvents } from './outbox-record.js';

export class PostgresWalletOpeningStore implements WalletOpeningStore {
  constructor(private readonly em: EntityManager) {}

  async save(wallet: Wallet, opening?: FinancialOpening): Promise<void> {
    try {
      await this.em.fork().transactional(async (tx) => {
        await tx.insert(WalletRecord, walletToRecord(wallet));
        if (!opening) return;

        await tx.insert(WagerTransactionRecord, wagerTransactionToRecord(opening.transaction));
        await tx.insert(WalletLedgerEntryRecord, ledgerEntryToRecord(opening.entry));
        await insertOutboxEvents(tx, opening.events);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException &&
          'constraint' in error && error.constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }
}
