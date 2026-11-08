import type { InferEntity } from '@mikro-orm/core';
import { Money } from '../../domain/money.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { Wallet } from '../../domain/wallet.js';
import type { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';

type WalletRow = InferEntity<typeof WalletRecord>;
type TransactionRow = InferEntity<typeof WagerTransactionRecord>;
type LedgerEntryRow = InferEntity<typeof WalletLedgerEntryRecord>;

export function walletToRecord(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRecord(row: WalletRow): Wallet {
  return Wallet.rehydrate({ ...row, balance: Money.rehydrate({ amount: row.balance, currency: row.currency }) });
}

export function wagerTransactionToRecord(transaction: WagerTransaction): Omit<TransactionRow, 'referenceAttempts' | 'referenceNextAttemptAt'> {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    observedBalance: transaction.observedBalance?.toJSON().amount ?? null,
    createdAt: transaction.createdAt,
    finalizedAt: transaction.finalizedAt ?? null,
  };
}

export function wagerTransactionFromRecord(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    ...row,
    money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode ?? undefined,
    observedBalance: row.observedBalance == null
      ? undefined
      : Money.rehydrate({ amount: row.observedBalance, currency: row.currency }),
    finalizedAt: row.finalizedAt ?? undefined,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    currency: entry.money.currency,
    amount: entry.money.toJSON().amount,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function ledgerEntryFromRecord(row: LedgerEntryRow): WalletLedgerEntry {
  const { currency } = row;
  return WalletLedgerEntry.rehydrate({
    ...row,
    money: Money.rehydrate({ amount: row.amount, currency }),
    balanceBefore: Money.rehydrate({ amount: row.balanceBefore, currency }),
    balanceAfter: Money.rehydrate({ amount: row.balanceAfter, currency }),
  });
}
