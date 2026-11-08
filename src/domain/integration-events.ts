import type { MoneyProps } from './money.js';
import { WagerTransactionStatus, type WagerTransaction, type WagerTransactionKind } from './wager-transaction.js';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';
import type { Wallet } from './wallet.js';

interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface IntegrationEventEnvelope<T extends object> extends EventContext {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<T>;
}

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly #occurredAt: string;
  readonly #data: Readonly<T>;

  protected constructor(
    context: EventContext,
    public readonly aggregateId: string,
    occurredAt: Date,
    data: Readonly<T>,
  ) {
    this.eventId = context.eventId;
    this.correlationId = context.correlationId;
    this.causationId = context.causationId;
    this.#occurredAt = occurredAt.toISOString();
    this.#data = data;
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      occurredAt: this.#occurredAt,
      version: this.version,
      data: structuredClone(this.#data),
    };
  }
}

interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext) {
    super(context, wallet.id, entry.createdAt, {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    });
    Object.freeze(this);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(wallet, entry, context);
  }
}

interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  balance?: MoneyProps;
}

function wagerEventData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    ...(transaction.observedBalance && { balance: transaction.observedBalance.toJSON() }),
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(transaction: WagerTransaction, processedAt: Date, context: EventContext) {
    super(context, transaction.id, processedAt, wagerEventData(transaction));
    Object.freeze(this);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const processedAt = transaction.processedAt;
    if (!processedAt) throw new Error('A processed event requires a processed transaction.');
    return new WagerTransactionProcessed(transaction, processedAt, context);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData & { failureCode: string }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(transaction: WagerTransaction, at: Date, failureCode: string, context: EventContext) {
    super(context, transaction.id, at, { ...wagerEventData(transaction), failureCode });
    Object.freeze(this);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const { status, finalizedAt, failureCode } = transaction;
    if (status !== WagerTransactionStatus.Rejected || !finalizedAt || !failureCode) {
      throw new Error('A rejected event requires a rejected transaction and failure code.');
    }
    return new WagerTransactionRejected(transaction, finalizedAt, failureCode, context);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData & { referenceExternalTransactionId: string }> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(transaction: WagerTransaction, at: Date, referenceExternalTransactionId: string, context: EventContext) {
    super(context, transaction.id, at, { ...wagerEventData(transaction), referenceExternalTransactionId });
    Object.freeze(this);
  }

  static from(transaction: WagerTransaction, at: Date, context: EventContext): WagerTransactionPendingReference {
    const { status, referenceExternalTransactionId } = transaction;
    if (status !== WagerTransactionStatus.PendingReference || !referenceExternalTransactionId) {
      throw new Error('A pending reference event requires a transaction awaiting an external reference.');
    }
    return new WagerTransactionPendingReference(transaction, at, referenceExternalTransactionId, context);
  }
}
