import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { Wallet } from '../domain/wallet.js';

export interface FinancialReadStore {
  findWallet(walletId: string): Promise<Wallet | null>;
  findTransaction(transactionId: string): Promise<WagerTransaction | null>;
  findProviderTransaction(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  listLedger(walletId: string, limit: number, afterId?: string): Promise<WalletLedgerEntry[] | null>;
}

export class FinancialQueriesUnavailableError extends Error {}
export class InvalidLedgerCursorError extends Error {}

export class FinancialQueries {
  constructor(private readonly store: FinancialReadStore) {}

  wallet(walletId: string) {
    return this.store.findWallet(walletId);
  }

  transaction(transactionId: string) {
    return this.store.findTransaction(transactionId);
  }

  providerTransaction(providerId: string, externalTransactionId: string) {
    return this.store.findProviderTransaction(providerId, externalTransactionId);
  }

  async ledger(walletId: string, limit: number, afterId?: string) {
    if (!await this.store.findWallet(walletId)) return null;
    const entries = await this.store.listLedger(walletId, limit + 1, afterId);
    if (!entries) throw new InvalidLedgerCursorError('Invalid ledger cursor.');

    const items = entries.slice(0, limit);
    return { items, nextEntryId: entries.length > limit ? items[limit - 1].id : undefined };
  }
}
