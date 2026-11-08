import { ConnectionException, DeadlockException, IsolationLevel, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuplicateReversalError, InboxPayloadConflictError, InvalidWagerInputError, WagerIdentityConflictError, WagerUnavailableError,
  type ApplyWager, type InboxDelivery, type WagerResult, type WagerStore,
} from '../../application/submit-wager.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, type WagerTransaction } from '../../domain/wager-transaction.js';
import { ledgerEntryToRecord, wagerTransactionFromRecord, wagerTransactionToRecord, walletFromRecord } from './financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';
import { insertOutboxEvents } from './outbox-record.js';
import { InboxRecord } from './inbox-record.js';

export class PostgresWagerStore implements WagerStore {
  constructor(private readonly em: EntityManager) {}

  submit(transaction: WagerTransaction, apply: ApplyWager): Promise<WagerResult>;
  submit(transaction: WagerTransaction, apply: ApplyWager, delivery: InboxDelivery): Promise<WagerResult | undefined>;
  async submit(transaction: WagerTransaction, apply: ApplyWager, delivery?: InboxDelivery): Promise<WagerResult | undefined> {
    try {
      return await this.#submitOrReplay(transaction, apply, delivery);
    } catch (error) {
      if (error instanceof ConnectionException || error instanceof DeadlockException ||
          (error instanceof Error && 'code' in error &&
            ['40001', '55P03', '57014', '57P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(error.code)))) {
        throw new WagerUnavailableError('Wager processing is temporarily unavailable.', { cause: error });
      }
      throw error;
    }
  }

  async #submitOrReplay(transaction: WagerTransaction, apply: ApplyWager, delivery?: InboxDelivery): Promise<WagerResult | undefined> {
    try {
      return await this.#transactionWithInbox(delivery, async (tx) => {
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
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && 'constraint' in error) {
        const { kind } = transaction;
        const duplicateReversal = (kind === Kind.Refund || kind === Kind.Rollback) && error.constraint === 'wager_reversal_reference_unique';
        if (!duplicateReversal && error.constraint !== 'wager_provider_idempotency_unique' &&
            error.constraint !== 'wager_provider_external_unique') throw error;
        // Resolve the winning identity only after the failed transaction has rolled back.
        return this.#transactionWithInbox(delivery, async (tx) => {
          const replay = await this.#findReplay(tx, transaction);
          if (replay) return replay;
          if (duplicateReversal) throw new DuplicateReversalError(kind);
          throw error;
        });
      }
      throw error;
    }
  }

  async #transactionWithInbox(
    delivery: InboxDelivery | undefined,
    operation: (tx: EntityManager) => Promise<WagerResult>,
  ): Promise<WagerResult | undefined> {
    return this.em.fork().transactional(async (tx) => {
      if (!delivery) return operation(tx);

      const { consumerName, messageId, payloadHash } = delivery;
      const identity = { consumerName, messageId };
      const inserted = await tx.createQueryBuilder(InboxRecord).insert(delivery)
        .onConflict(['consumerName', 'messageId']).ignore().returning('messageId').execute<{ messageId: string }[]>('all');
      if (inserted.length === 0) {
        const existing = await tx.findOneOrFail(InboxRecord, identity);
        if (existing.payloadHash !== payloadHash) throw new InboxPayloadConflictError('Message identity is bound to a different payload.');
        if (!existing.processedAt) throw new Error('Inbox record has no committed outcome.');
        return undefined;
      }

      const result = await operation(tx);
      await tx.nativeUpdate(InboxRecord, identity, { processedAt: new Date() });
      return result;
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
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
