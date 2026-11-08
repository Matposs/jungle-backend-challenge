import { defineEntity, Type } from '@mikro-orm/core';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { LedgerDirection } from '../../domain/wallet-ledger-entry.js';

class NumericAmountType extends Type<string, string> {
  override getColumnType(): string {
    return 'numeric(20,2)';
  }

  override compareAsType(): string {
    return 'string';
  }

  override convertToDatabaseValue(value: string): string {
    if (value != null && typeof value !== 'string') {
      throw new TypeError('Expected a decimal string to write a numeric amount.');
    }
    return value;
  }

  override convertToJSValue(value: string): string {
    if (typeof value !== 'string') {
      throw new TypeError('Expected PostgreSQL to return a numeric amount as a string.');
    }
    return value;
  }
}

// SQL migrations own the constraints and foreign keys. These records expose their columns.
export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: (p) => ({
    id: p.text().primary(),
    playerId: p.text(),
    currency: p.string().length(3),
    balance: p.type(NumericAmountType),
    version: p.integer().default(1),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  }),
});

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: (p) => ({
    id: p.text().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.text(),
    walletId: p.text(),
    playerId: p.text(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.enum(() => WagerTransactionKind).columnType('text'),
    status: p.enum(() => WagerTransactionStatus).columnType('text'),
    amount: p.type(NumericAmountType),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.text().nullable(),
    failureCode: p.text().nullable(),
    observedBalance: p.type(NumericAmountType).nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
    finalizedAt: p.datetime().columnType('timestamptz').nullable(),
    referenceAttempts: p.integer().default(0),
    referenceNextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
  }),
});

export const WalletLedgerEntryRecord = defineEntity({
  name: 'WalletLedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: (p) => ({
    id: p.text().primary(),
    walletId: p.text(),
    transactionId: p.text(),
    direction: p.enum(() => LedgerDirection).columnType('text'),
    amount: p.type(NumericAmountType),
    currency: p.string().length(3),
    balanceBefore: p.type(NumericAmountType),
    balanceAfter: p.type(NumericAmountType),
    createdAt: p.datetime().columnType('timestamptz'),
  }),
});
