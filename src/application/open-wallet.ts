import { createHash } from 'node:crypto';
import { WalletBalanceChanged, WagerTransactionProcessed, type IntegrationEvent } from '../domain/integration-events.js';
import { Money } from '../domain/money.js';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction.js';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { Wallet } from '../domain/wallet.js';

export interface FinancialOpening {
  readonly transaction: WagerTransaction;
  readonly entry: WalletLedgerEntry;
  readonly events: readonly IntegrationEvent<object>[];
}

export interface WalletOpeningStore {
  save(wallet: Wallet, opening?: FinancialOpening): Promise<void>;
}

export class WalletAlreadyExistsError extends Error {
  override readonly name = 'WalletAlreadyExistsError';

  constructor() {
    super('A wallet already exists for this player and currency.');
  }
}

export class OpenWallet {
  constructor(private readonly store: WalletOpeningStore) {}

  async execute(playerId: string, initialBalance: Money): Promise<Wallet> {
    const at = new Date();
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId, initialBalance }, at);
    if (initialBalance.isZero()) {
      await this.store.save(wallet);
      return wallet;
    }

    const openingKey = `opening:${wallet.id}`;
    const kind = WagerTransactionKind.Opening;
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ walletId: wallet.id, playerId, kind, money: initialBalance.toJSON() }))
      .digest('hex');
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(), providerId: 'internal:wallet-opening', externalTransactionId: openingKey,
      idempotencyKey: openingKey, payloadHash, walletId: wallet.id, playerId,
      roundId: openingKey, gameId: 'wallet-opening', kind, money: initialBalance, createdAt: at,
    });
    transaction.markProcessed({ observedBalance: wallet.balance, at });

    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(), walletId: wallet.id, transactionId: transaction.id,
      direction: LedgerDirection.Credit, money: initialBalance, balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance, createdAt: at,
    });
    const events = [
      WagerTransactionProcessed.from(transaction, { eventId: crypto.randomUUID(), correlationId: wallet.id }),
      WalletBalanceChanged.from(wallet, entry, {
        eventId: crypto.randomUUID(), correlationId: wallet.id, causationId: transaction.id,
      }),
    ];

    await this.store.save(wallet, { transaction, entry, events });
    return wallet;
  }
}
