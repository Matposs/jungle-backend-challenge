import { createHash } from 'node:crypto';
import {
  WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected,
  type IntegrationEvent,
} from '../domain/integration-events.js';
import { MoneyError, type Money } from '../domain/money.js';
import { WagerTransaction, WagerTransactionError, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../domain/wager-transaction.js';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { InsufficientFundsError, type Wallet } from '../domain/wallet.js';

export interface SubmitWagerInput {
  readonly kind: Kind.Bet | Kind.Win | Kind.Loss | Kind.Refund | Kind.Rollback;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
}

export interface WagerResult {
  readonly transaction: WagerTransaction;
  readonly idempotentReplay: boolean;
}

export interface WagerEffects {
  readonly entry?: WalletLedgerEntry;
  readonly events: readonly IntegrationEvent<object>[];
}

export type ApplyWager = (
  wallet: Wallet,
  reference: WagerTransaction | undefined,
  hasCompetingBetReversal: () => Promise<boolean>,
) => Promise<WagerEffects>;

export interface WagerStore {
  submit(transaction: WagerTransaction, apply: ApplyWager): Promise<WagerResult>;
  submit(transaction: WagerTransaction, apply: ApplyWager, delivery: InboxDelivery): Promise<WagerResult | undefined>;
}

export interface InboxDelivery {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export class InboxPayloadConflictError extends Error {}
export class WagerIdentityConflictError extends Error {}
export class DuplicateReversalError extends Error {
  readonly failureCode: 'DUPLICATE_REFUND' | 'DUPLICATE_ROLLBACK';

  constructor(kind: Kind.Refund | Kind.Rollback) {
    super(`The referenced transaction already has a pending or processed ${kind}.`);
    this.failureCode = kind === Kind.Refund ? 'DUPLICATE_REFUND' : 'DUPLICATE_ROLLBACK';
  }
}
export class InvalidWagerInputError extends Error {}
export class WagerUnavailableError extends Error {}

export class SubmitWager {
  constructor(private readonly store: WagerStore) {}

  execute(input: SubmitWagerInput): Promise<WagerResult>;
  execute(input: SubmitWagerInput, delivery: InboxDelivery): Promise<WagerResult | undefined>;
  execute(input: SubmitWagerInput, delivery?: InboxDelivery): Promise<WagerResult | undefined> {
    if (input.kind !== Kind.Loss && !input.money.isPositive()) {
      throw new InvalidWagerInputError(`${input.kind} requires a positive amount.`);
    }
    if (input.providerId === 'internal:wallet-opening') throw new InvalidWagerInputError('This provider ID is reserved.');
    if ((input.kind === Kind.Refund || input.kind === Kind.Rollback) && !input.referenceExternalTransactionId?.trim()) {
      throw new InvalidWagerInputError(`${input.kind} requires referenceExternalTransactionId.`);
    }
    if (input.externalTransactionId === input.referenceExternalTransactionId) {
      throw new InvalidWagerInputError('A transaction cannot reference itself.');
    }

    const money = input.money.toJSON();
    // Keep this projection ordered and independent of HTTP field order and headers.
    const payloadHash = createHash('sha256').update(JSON.stringify({
      externalTransactionId: input.externalTransactionId,
      gameId: input.gameId,
      kind: input.kind,
      money: { amount: money.amount, currency: money.currency },
      playerId: input.playerId,
      providerId: input.providerId,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      roundId: input.roundId,
      walletId: input.walletId,
    })).digest('hex');
    const transaction = WagerTransaction.create({
      ...input, id: crypto.randomUUID(), payloadHash,
    });

    const apply: ApplyWager = (wallet, reference, hasCompetingBetReversal) =>
      this.#apply(wallet, transaction, reference, hasCompetingBetReversal);
    return delivery ? this.store.submit(transaction, apply, delivery) : this.store.submit(transaction, apply);
  }

  async #apply(
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    hasCompetingBetReversal: () => Promise<boolean>,
  ): Promise<WagerEffects> {
    if (wallet.playerId !== transaction.playerId || wallet.currency !== transaction.currency) {
      throw new InvalidWagerInputError('Wallet does not match the player and currency.');
    }

    const at = new Date();
    const context = { eventId: crypto.randomUUID(), correlationId: transaction.id };
    const reject = (code: string, referenceTransactionId?: string): WagerEffects => {
      transaction.reject(code, { referenceTransactionId, observedBalance: wallet.balance, at });
      return { events: [WagerTransactionRejected.from(transaction, context)] };
    };

    if (transaction.referenceExternalTransactionId !== undefined) {
      if (reference) {
        try {
          transaction.assertReferenceScope(reference);
        } catch (error) {
          if (!(error instanceof WagerTransactionError)) throw error;
          return reject('INVALID_REFERENCE');
        }
        if (reference.isTerminal() && reference.status !== Status.Processed) {
          return reject('REFERENCE_NOT_PROCESSED', reference.id);
        }
        if (transaction.requiresReference() && !transaction.money.equals(reference.money)) {
          return reject('REFERENCE_AMOUNT_MISMATCH', reference.id);
        }
      }
      if (transaction.requiresReference() && (!reference || reference.kind === Kind.Bet) && await hasCompetingBetReversal()) {
        return reject('BET_COMPENSATION_CONFLICT', reference?.id);
      }
      if (reference?.status !== Status.Processed) {
        transaction.markPendingReference();
        return { events: [WagerTransactionPendingReference.from(transaction, at, context)] };
      }
    }

    if (transaction.kind === Kind.Loss) {
      transaction.markProcessed({ observedBalance: wallet.balance, at });
      return { events: [WagerTransactionProcessed.from(transaction, context)] };
    }

    let change;
    const direction = transaction.ledgerDirectionFor(reference);
    if (!direction) throw new Error('A financial wager must have a ledger direction.');
    const debit = direction === LedgerDirection.Debit;
    try {
      change = debit ? wallet.debit(transaction.money, at) : wallet.credit(transaction.money, at);
    } catch (error) {
      if (debit && error instanceof InsufficientFundsError) {
        return reject(transaction.kind === Kind.Rollback ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS', reference?.id);
      }
      if (!debit && error instanceof MoneyError) return reject('BALANCE_LIMIT_EXCEEDED', reference?.id);
      throw error;
    }

    if (!change) throw new Error('A positive wager movement must change the balance.');
    transaction.markProcessed({ reference, observedBalance: wallet.balance, at });
    const entry = WalletLedgerEntry.create({
      ...change, id: crypto.randomUUID(), walletId: wallet.id, transactionId: transaction.id,
      direction, money: transaction.money, createdAt: at,
    });

    return {
      entry,
      events: [
        WagerTransactionProcessed.from(transaction, context),
        WalletBalanceChanged.from(wallet, entry, {
          eventId: crypto.randomUUID(), correlationId: transaction.id, causationId: transaction.id,
        }),
      ],
    };
  }
}
