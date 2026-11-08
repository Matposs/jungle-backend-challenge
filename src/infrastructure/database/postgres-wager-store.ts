import { ConnectionException, DeadlockException, IsolationLevel, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuplicateReversalError, InvalidWagerInputError, WagerIdentityConflictError, WagerUnavailableError,
  type ApplyWager, type WagerResult, type WagerStore,
} from '../../application/submit-wager.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, type WagerTransaction } from '../../domain/wager-transaction.js';
import { ledgerEntryToRecord, wagerTransactionFromRecord, wagerTransactionToRecord, walletFromRecord } from './financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';
import { insertOutboxEvents } from './outbox-record.js';

export class PostgresWagerStore implements WagerStore {
  constructor(private readonly em: EntityManager) {}

  async submit(transaction: WagerTransaction, apply: ApplyWager): Promise<WagerResult> {
    try {
      return await this.#submitOrReplay(transaction, apply);
    } catch (error) {
      if (error instanceof ConnectionException || error instanceof DeadlockException ||
          (error instanceof Error && 'code' in error &&
            ['40001', '55P03', '57014', '57P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(error.code)))) {
        throw new WagerUnavailableError('Wager processing is temporarily unavailable.', { cause: error });
      }
      throw error;
    }
  }

  async #submitOrReplay(transaction: WagerTransaction, apply: ApplyWager): Promise<WagerResult> {
    try {
      return await this.em.fork().transactional(async (tx) => {
        const existing = await this.#findReplay(tx, transaction);
        if (existing) return existing;

        const record = await tx.findOne(WalletRecord, transaction.walletId, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!record) throw new InvalidWagerInputError('Wallet was not found.');

        const replay = await this.#findReplay(tx, transaction);
        if (replay) return replay;

        const wallet = walletFromRecord(record);
        const reference = transaction.referenceExternalTransactionId === undefined ? null : await tx.findOne(WagerTransactionRecord, {
          providerId: transaction.providerId,
          externalTransactionId: transaction.referenceExternalTransactionId,
        });
        const { entry, events } = await apply(wallet, reference ? wagerTransactionFromRecord(reference) : undefined,
          () => this.#hasCompetingBetReversal(tx, transaction));
        await tx.insert(WagerTransactionRecord, wagerTransactionToRecord(transaction));
        if (entry) {
          await tx.nativeUpdate(WalletRecord, { id: wallet.id }, {
            balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt,
          });
          await tx.insert(WalletLedgerEntryRecord, ledgerEntryToRecord(entry));
        }
        await insertOutboxEvents(tx, events);
        return { transaction, idempotentReplay: false };
      }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && 'constraint' in error) {
        const { kind } = transaction;
        const duplicateReversal = (kind === Kind.Refund || kind === Kind.Rollback) && error.constraint === 'wager_reversal_reference_unique';
        if (!duplicateReversal && error.constraint !== 'wager_provider_idempotency_unique' &&
            error.constraint !== 'wager_provider_external_unique') throw error;
        // Read the winning identity only after the failed transaction has rolled back.
        const replay = await this.#findReplay(this.em.fork(), transaction);
        if (replay) return replay;
        if (duplicateReversal) throw new DuplicateReversalError(kind);
      }
      throw error;
    }
  }

  async #hasCompetingBetReversal(tx: EntityManager, transaction: WagerTransaction): Promise<boolean> {
    const competing = await tx.findOne(WagerTransactionRecord, {
      providerId: transaction.providerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      kind: transaction.kind === Kind.Refund ? Kind.Rollback : Kind.Refund,
      status: { $in: [Status.Pending, Status.PendingReference, Status.Processed] },
    });
    if (!competing) return false;
    if (competing.kind !== Kind.Refund || competing.status !== Status.Processed) return true;

    // Only a committed debit of the REFUND releases its financial compensation.
    const undone = await tx.findOne(WagerTransactionRecord, {
      referenceTransactionId: competing.id, kind: Kind.Rollback, status: Status.Processed,
    });
    return !undone;
  }

  async #findReplay(em: EntityManager, transaction: WagerTransaction): Promise<WagerResult | undefined> {
    const row = await em.findOne(WagerTransactionRecord, {
      providerId: transaction.providerId,
      $or: [{ idempotencyKey: transaction.idempotencyKey }, { externalTransactionId: transaction.externalTransactionId }],
    });
    if (!row) return undefined;

    const existing = wagerTransactionFromRecord(row);
    if (existing.idempotencyKey !== transaction.idempotencyKey ||
        existing.externalTransactionId !== transaction.externalTransactionId || !existing.matchesPayload(transaction.payloadHash)) {
      throw new WagerIdentityConflictError('The idempotency key or external transaction ID is already bound to another request.');
    }

    return { transaction: existing, idempotentReplay: true };
  }
}
