import { ConnectionException, DeadlockException, IsolationLevel, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuplicateReversalError, InboxPayloadConflictError, InvalidWagerInputError, WagerIdentityConflictError, WagerUnavailableError,
  applyWager, type ApplyWager, type InboxDelivery, type WagerEffects, type WagerResult, type WagerStore,
} from '../../application/submit-wager.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, type WagerTransaction } from '../../domain/wager-transaction.js';
import type { Wallet } from '../../domain/wallet.js';
import { ledgerEntryToRecord, wagerOutcomeToRecord, wagerTransactionFromRecord, wagerTransactionToRecord, walletFromRecord } from './financial-mappers.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './financial-records.js';
import { insertOutboxEvents } from './outbox-record.js';
import { InboxRecord } from './inbox-record.js';

const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_RETRY_BASE_MS = 5000;
const REFERENCE_RETRY_MAX_MS = 300_000;

function isDatabaseConnectionError(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = String(error.code);
  return /^08[0-9A-Z]{3}$/.test(code) ||
    ['57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code);
}

export class PendingReferenceAttemptError extends Error {
  constructor(readonly transactionId: string, cause: unknown) {
    super('Pending reference attempt failed.', { cause });
  }
}

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
        const reference = await this.#findReference(tx, transaction);
        const effects = await apply(wallet, transaction, reference,
          () => this.#hasCompetingBetReversal(tx, transaction));
        await tx.insert(WagerTransactionRecord, wagerTransactionToRecord(transaction));
        await this.#persistEffects(tx, wallet, effects);
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

  async processNextPendingReference(excludedIds: readonly string[] = []): Promise<boolean> {
    let candidateId: string | undefined;
    try {
      return await this.em.fork().transactional(async (tx) => {
        const schema = tx.schema ?? tx.config.getSchema() ?? 'public';
        const platform = tx.getPlatform();
        const wagers = platform.quoteIdentifier(`${schema}.${tx.getMetadata(WagerTransactionRecord).tableName}`);
        const wallets = platform.quoteIdentifier(`${schema}.${tx.getMetadata(WalletRecord).tableName}`);
        // Lock only the wallet during selection, matching the financial write order.
        const [candidate] = await tx.execute<{ id: string; wallet_id: string }[]>(`
          SELECT wager.id, wager.wallet_id
          FROM ${wagers} AS wager
          JOIN ${wallets} AS wallet ON wallet.id = wager.wallet_id
          WHERE wager.status = 'PENDING_REFERENCE'
            AND (wager.reference_next_attempt_at IS NULL OR wager.reference_next_attempt_at <= statement_timestamp())
            ${excludedIds.length ? `AND wager.id NOT IN (${excludedIds.map(() => '?').join(', ')})` : ''}
          ORDER BY COALESCE(wager.reference_next_attempt_at, wager.created_at), wager.created_at, wager.id
          LIMIT 1 FOR UPDATE OF wallet SKIP LOCKED
        `, [...excludedIds]);
        if (!candidate) return false;

        const { id } = candidate;
        candidateId = id;
        // READ COMMITTED gives this statement a fresh snapshot after the wallet lock.
        const row = await tx.findOne(WagerTransactionRecord, {
          id, walletId: candidate.wallet_id, status: Status.PendingReference,
        }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!row) return true;

        const [{ at: databaseTime }] = await tx.execute<{ at: string }[]>('SELECT clock_timestamp() AS at');
        const at = new Date(databaseTime);
        if (row.referenceNextAttemptAt && row.referenceNextAttemptAt > at) return true;

        const wallet = walletFromRecord(await tx.findOneOrFail(WalletRecord, candidate.wallet_id));
        const transaction = wagerTransactionFromRecord(row);
        const reference = await this.#findReference(tx, transaction);
        const deadline = row.createdAt.getTime() + REFERENCE_TTL_MS;
        const effects = await applyWager(wallet, transaction, reference,
          () => this.#hasCompetingBetReversal(tx, transaction), at, deadline);
        const referenceAttempts = row.referenceAttempts + 1;

        if (transaction.status === Status.PendingReference) {
          const backoff = Math.min(REFERENCE_RETRY_MAX_MS, REFERENCE_RETRY_BASE_MS * 2 ** Math.min(row.referenceAttempts, 6));
          await tx.nativeUpdate(WagerTransactionRecord, { id }, {
            referenceAttempts,
            referenceNextAttemptAt: new Date(Math.min(deadline, at.getTime() + backoff)),
          });
        } else {
          await tx.nativeUpdate(WagerTransactionRecord, { id }, {
            ...wagerOutcomeToRecord(transaction), referenceAttempts, referenceNextAttemptAt: null,
          });
          await this.#persistEffects(tx, wallet, effects);
        }
        return true;
      }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    } catch (error) {
      // Commit failures are reported only after transactional has rolled back.
      if (candidateId !== undefined && !isDatabaseConnectionError(error)) {
        throw new PendingReferenceAttemptError(candidateId, error);
      }
      throw error;
    }
  }

  async #findReference(tx: EntityManager, transaction: WagerTransaction): Promise<WagerTransaction | undefined> {
    if (transaction.referenceExternalTransactionId === undefined) return undefined;
    const row = await tx.findOne(WagerTransactionRecord, {
      providerId: transaction.providerId,
      externalTransactionId: transaction.referenceExternalTransactionId,
    });
    return row ? wagerTransactionFromRecord(row) : undefined;
  }

  async #persistEffects(tx: EntityManager, wallet: Wallet, { entry, events }: WagerEffects): Promise<void> {
    if (entry) {
      await tx.nativeUpdate(WalletRecord, { id: wallet.id }, {
        balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt,
      });
      await tx.insert(WalletLedgerEntryRecord, ledgerEntryToRecord(entry));
    }
    await insertOutboxEvents(tx, events);
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
