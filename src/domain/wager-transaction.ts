import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt?: Date;
}

interface WagerTransactionOutcome {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: string;
  readonly observedBalance?: Money;
  readonly finalizedAt?: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps, WagerTransactionOutcome {
  readonly createdAt: Date;
}

export interface ProcessWagerTransactionProps {
  readonly reference?: WagerTransaction;
  readonly observedBalance?: Money;
  readonly at?: Date;
}

export interface WagerTransactionFailureDetails {
  readonly referenceTransactionId?: string;
  readonly observedBalance?: Money;
  readonly at?: Date;
}

export class WagerTransactionError extends Error {
  override readonly name: string = 'WagerTransactionError';
}

export class InvalidTransactionStateError extends WagerTransactionError {
  override readonly name = 'InvalidTransactionStateError';
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WagerTransactionError(`${field} is required.`);
  }
}

function timestamp(date: Date, field: string): number {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new WagerTransactionError(`${field} must be a valid date.`);
  }
  return date.getTime();
}

/** PENDING may await a reference. Both pending states may enter any terminal state exactly once. */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly #createdAt: number;
  #outcome: WagerTransactionOutcome = { status: WagerTransactionStatus.Pending };

  private constructor(props: CreateWagerTransactionProps, createdAt: Date) {
    const requiredFields = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(requiredFields)) {
      assertNonBlank(value, field);
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new WagerTransactionError('Unknown wager transaction kind.');
    }
    if (!(props.money instanceof Money) || props.money.isNegative()) {
      throw new WagerTransactionError('Transaction money must be a non-negative Money value.');
    }
    if (props.referenceExternalTransactionId !== undefined) {
      assertNonBlank(props.referenceExternalTransactionId, 'referenceExternalTransactionId');
    }

    this.id = requiredFields.id;
    this.providerId = requiredFields.providerId;
    this.externalTransactionId = requiredFields.externalTransactionId;
    this.idempotencyKey = requiredFields.idempotencyKey;
    this.payloadHash = requiredFields.payloadHash;
    this.walletId = requiredFields.walletId;
    this.playerId = requiredFields.playerId;
    this.roundId = requiredFields.roundId;
    this.gameId = requiredFields.gameId;
    this.kind = props.kind;
    this.money = props.money;
    this.referenceExternalTransactionId = props.referenceExternalTransactionId;
    this.#createdAt = timestamp(createdAt, 'createdAt');
    if (this.requiresReference() && this.referenceExternalTransactionId === undefined) {
      throw new WagerTransactionError('This operation requires referenceExternalTransactionId.');
    }
    if (this.referenceExternalTransactionId !== undefined && !this.requiresReference() && this.kind !== WagerTransactionKind.Win) {
      throw new WagerTransactionError('This operation does not support a reference.');
    }
    Object.freeze(this);
  }

  static create({ createdAt = new Date(), ...props }: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(props, createdAt);
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    const transaction = new WagerTransaction(state, state.createdAt);
    transaction.#setOutcome(state);
    return transaction;
  }

  get amount(): string { return this.money.toJSON().amount; }
  get currency(): string { return this.money.currency; }
  get createdAt(): Date { return new Date(this.#createdAt); }
  get status(): WagerTransactionStatus { return this.#outcome.status; }
  get referenceTransactionId(): string | undefined { return this.#outcome.referenceTransactionId; }
  get failureCode(): string | undefined { return this.#outcome.failureCode; }
  get observedBalance(): Money | undefined { return this.#outcome.observedBalance; }
  get finalizedAt(): Date | undefined {
    return this.#outcome.finalizedAt && new Date(this.#outcome.finalizedAt);
  }
  get processedAt(): Date | undefined {
    return this.status === WagerTransactionStatus.Processed ? this.finalizedAt : undefined;
  }

  markPendingReference(): void {
    if (this.status !== WagerTransactionStatus.Pending || this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError('Only a pending transaction with a reference can await it.');
    }
    this.#outcome = { status: WagerTransactionStatus.PendingReference };
  }

  markProcessed({ reference, observedBalance, at = new Date() }: ProcessWagerTransactionProps): void {
    this.#assertOpen();
    if (reference !== undefined || this.referenceExternalTransactionId !== undefined) {
      this.#assertResolvedReference(reference);
    }
    this.#setOutcome({
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: reference?.id,
      observedBalance,
      finalizedAt: at,
    });
  }

  reject(code: string, details: WagerTransactionFailureDetails = {}): void {
    this.#finishWithFailure(WagerTransactionStatus.Rejected, code, details);
  }

  fail(code: string, details: WagerTransactionFailureDetails = {}): void {
    this.#finishWithFailure(WagerTransactionStatus.Failed, code, details);
  }

  isTerminal(): boolean {
    return this.status !== WagerTransactionStatus.Pending && this.status !== WagerTransactionStatus.PendingReference;
  }

  isInternal(): boolean { return this.kind === WagerTransactionKind.Opening; }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss &&
      this.status !== WagerTransactionStatus.Rejected && this.status !== WagerTransactionStatus.Failed;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    if (!this.affectsBalance()) return undefined;
    if (this.kind === WagerTransactionKind.Rollback) {
      this.#assertResolvedReference(reference);
      return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    return this.kind === WagerTransactionKind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit;
  }

  #assertOpen(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot transition a transaction in ${this.status}.`);
    }
  }

  #finishWithFailure(
    status: WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed,
    failureCode: string,
    { referenceTransactionId, observedBalance, at = new Date() }: WagerTransactionFailureDetails,
  ): void {
    this.#assertOpen();
    this.#setOutcome({ status, failureCode, referenceTransactionId, observedBalance, finalizedAt: at });
  }

  #setOutcome({ status, referenceTransactionId, failureCode, observedBalance, finalizedAt }: WagerTransactionOutcome): void {
    if (!Object.values(WagerTransactionStatus).includes(status)) {
      throw new WagerTransactionError('Unknown wager transaction status.');
    }

    const processed = status === WagerTransactionStatus.Processed;
    const unsuccessful = status === WagerTransactionStatus.Rejected || status === WagerTransactionStatus.Failed;
    if (processed || unsuccessful) {
      if (finalizedAt === undefined) throw new WagerTransactionError('Terminal transactions require finalizedAt.');
    } else if (finalizedAt !== undefined || referenceTransactionId !== undefined || observedBalance !== undefined) {
      throw new WagerTransactionError('Pending transactions cannot carry a final outcome.');
    }
    if (unsuccessful) {
      if (failureCode === undefined) throw new WagerTransactionError('An unsuccessful transaction requires failureCode.');
      assertNonBlank(failureCode, 'failureCode');
    } else if (failureCode !== undefined) {
      throw new WagerTransactionError('failureCode is only valid for rejected or failed transactions.');
    }
    if (status === WagerTransactionStatus.PendingReference && this.referenceExternalTransactionId === undefined) {
      throw new WagerTransactionError('A pending reference requires referenceExternalTransactionId.');
    }
    if (referenceTransactionId !== undefined) {
      assertNonBlank(referenceTransactionId, 'referenceTransactionId');
      if (this.referenceExternalTransactionId === undefined) {
        throw new WagerTransactionError('A resolved reference requires referenceExternalTransactionId.');
      }
    } else if (processed && this.referenceExternalTransactionId !== undefined) {
      throw new WagerTransactionError('Processing requires a resolved reference.');
    }
    if (processed && this.kind !== WagerTransactionKind.Loss && observedBalance === undefined) {
      throw new WagerTransactionError('Processing a financial operation requires its observed balance.');
    }
    if (observedBalance !== undefined &&
        (!(observedBalance instanceof Money) || observedBalance.isNegative() || observedBalance.currency !== this.currency)) {
      throw new WagerTransactionError('Observed balance must be non-negative and in the transaction currency.');
    }

    this.#outcome = {
      status, referenceTransactionId, failureCode, observedBalance,
      finalizedAt: finalizedAt === undefined ? undefined : new Date(timestamp(finalizedAt, 'finalizedAt')),
    };
  }

  assertReferenceScope(reference: WagerTransaction | undefined): asserts reference is WagerTransaction {
    if (this.referenceExternalTransactionId === undefined || !(reference instanceof WagerTransaction) ||
        reference.externalTransactionId !== this.referenceExternalTransactionId || reference.id === this.id ||
        reference.providerId !== this.providerId || reference.playerId !== this.playerId ||
        reference.walletId !== this.walletId || reference.currency !== this.currency || reference.roundId !== this.roundId) {
      throw new WagerTransactionError('The reference must match the external ID and transaction scope.');
    }

    const allowedKinds = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]
      : [WagerTransactionKind.Bet];
    if (!allowedKinds.includes(reference.kind)) {
      throw new WagerTransactionError('Referenced transaction kind is not allowed.');
    }
  }

  #assertResolvedReference(reference: WagerTransaction | undefined): asserts reference is WagerTransaction {
    this.assertReferenceScope(reference);
    if (this.requiresReference() && (!this.money.equals(reference.money) || reference.status !== WagerTransactionStatus.Processed)) {
      throw new WagerTransactionError('A reversal requires a processed reference of the same amount.');
    }
  }
}
