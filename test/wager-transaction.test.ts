import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money.js';
import {
  type CreateWagerTransactionProps,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionError,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../src/domain/wager-transaction.js';
import { LedgerDirection } from '../src/domain/wallet-ledger-entry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const createdAt = new Date('2026-01-01T00:00:00.000Z');
const finalizedAt = new Date('2026-01-02T00:00:00.000Z');
const observedBalance = brl('75.00');
const props = {
  id: 'transaction-1', providerId: 'provider-1', externalTransactionId: 'external-1',
  idempotencyKey: 'provider-1:external-1', payloadHash: 'payload-hash', walletId: 'wallet-1',
  playerId: 'player-1', roundId: 'round-1', gameId: 'game-1', kind: Kind.Bet, money: brl('25.00'), createdAt,
} satisfies CreateWagerTransactionProps;

function create(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({ ...props, ...overrides });
}

function referencing(kind: Kind, target = props.externalTransactionId): WagerTransaction {
  return create({ id: 'transaction-2', externalTransactionId: 'external-2', kind, referenceExternalTransactionId: target });
}

function processedBet(): WagerTransaction {
  const bet = create();
  bet.markProcessed({ observedBalance, at: finalizedAt });
  return bet;
}

describe('WagerTransaction', () => {
  test.each(Object.values(Kind))('creates %s in PENDING', (kind) => {
    const needsReference = kind === Kind.Refund || kind === Kind.Rollback;
    const transaction = needsReference ? referencing(kind) : create({ kind });

    expect(transaction.kind).toBe(kind);
    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.isInternal()).toBe(kind === Kind.Opening);
    expect(transaction.requiresReference()).toBe(needsReference);
    expect(transaction.affectsBalance()).toBe(kind !== Kind.Loss);
    expect(transaction.amount).toBe('25.00');
    expect(transaction.currency).toBe('BRL');
    expect(transaction.finalizedAt).toBeUndefined();
  });

  test('rejects an unknown kind, invalid Money and invalid dates', () => {
    expect(() => create({ kind: 'UNKNOWN' as Kind })).toThrow(WagerTransactionError);
    expect(() => create({ money: props.money.negate() })).toThrow(WagerTransactionError);
    expect(() => create({ money: undefined })).toThrow(WagerTransactionError);
    expect(() => create({ createdAt: new Date('invalid') })).toThrow(WagerTransactionError);
  });

  test.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const)(
    'rejects missing or blank %s',
    (field) => {
      expect(() => create({ [field]: undefined })).toThrow(WagerTransactionError);
      expect(() => create({ [field]: '  ' })).toThrow(WagerTransactionError);
    },
  );

  test('preserves the idempotency key and compares the supplied hash exactly', () => {
    const transaction = create();

    expect(transaction.idempotencyKey).toBe(props.idempotencyKey);
    expect(transaction.matchesPayload(props.payloadHash)).toBe(true);
    expect(transaction.matchesPayload('different-hash')).toBe(false);
  });

  test('validates external reference presence and supported combinations', () => {
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      expect(() => create({ kind })).toThrow(WagerTransactionError);
    }
    for (const kind of [Kind.Opening, Kind.Bet, Kind.Loss]) {
      expect(() => referencing(kind)).toThrow(WagerTransactionError);
    }
    expect(() => referencing(Kind.Win, ' ')).toThrow(WagerTransactionError);
    expect(create({ kind: Kind.Win }).referenceExternalTransactionId).toBeUndefined();
    expect(referencing(Kind.Win).referenceExternalTransactionId).toBe(props.externalTransactionId);
  });

  test('waits for a reference and processes after it resolves', () => {
    const transaction = referencing(Kind.Refund);
    transaction.markPendingReference();

    expect(transaction.status).toBe(Status.PendingReference);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => transaction.markProcessed({ observedBalance })).toThrow(WagerTransactionError);
    expect(transaction.status).toBe(Status.PendingReference);

    transaction.markProcessed({ reference: processedBet(), observedBalance: brl('100.00'), at: finalizedAt });

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId).toBe(props.id);
    expect(transaction.observedBalance?.toString()).toBe('100.00 BRL');
    expect(transaction.processedAt).toEqual(finalizedAt);
  });

  test('rejects and fails directly or while waiting for a reference', () => {
    for (const awaitingReference of [false, true]) {
      const rejected = referencing(Kind.Refund);
      const failed = referencing(Kind.Rollback);
      if (awaitingReference) {
        rejected.markPendingReference();
        failed.markPendingReference();
      }

      rejected.reject('REFERENCE_NOT_FOUND', { at: finalizedAt });
      failed.fail('PERMANENT_FAILURE', { referenceTransactionId: props.id, at: finalizedAt });

      expect(rejected.status).toBe(Status.Rejected);
      expect(rejected.failureCode).toBe('REFERENCE_NOT_FOUND');
      expect(rejected.affectsBalance()).toBe(false);
      expect(rejected.ledgerDirectionFor()).toBeUndefined();
      expect(rejected.referenceTransactionId).toBeUndefined();
      expect(failed.status).toBe(Status.Failed);
      expect(failed.failureCode).toBe('PERMANENT_FAILURE');
      expect(failed.referenceTransactionId).toBe(props.id);
      expect(failed.finalizedAt).toEqual(finalizedAt);
      expect(failed.processedAt).toBeUndefined();
    }
  });

  test('protects all terminal states against every transition', () => {
    const processed = processedBet();
    const rejected = create();
    rejected.reject('INSUFFICIENT_FUNDS', { observedBalance, at: finalizedAt });
    const failed = create();
    failed.fail('PERMANENT_FAILURE', { at: finalizedAt });

    for (const transaction of [processed, rejected, failed]) {
      const status = transaction.status;
      const code = transaction.failureCode;
      const balance = transaction.observedBalance;
      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed({ observedBalance })).toThrow(InvalidTransactionStateError);
      expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => transaction.reject('OTHER_REJECTION')).toThrow(InvalidTransactionStateError);
      expect(() => transaction.fail('OTHER_FAILURE')).toThrow(InvalidTransactionStateError);
      expect(transaction.status).toBe(status);
      expect(transaction.failureCode).toBe(code);
      expect(transaction.observedBalance).toBe(balance);
      expect(transaction.finalizedAt).toEqual(finalizedAt);
    }
  });

  test('validates failures, references and observed balances before changing state', () => {
    const transaction = create();
    const usd = Money.from({ amount: '75.00', currency: 'USD' });

    expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => transaction.reject('  ')).toThrow(WagerTransactionError);
    expect(() => transaction.fail('PERMANENT_FAILURE', { referenceTransactionId: props.id })).toThrow(WagerTransactionError);
    expect(() => transaction.markProcessed({ reference: processedBet(), observedBalance })).toThrow(WagerTransactionError);
    expect(() => transaction.markProcessed({})).toThrow(WagerTransactionError);
    expect(() => transaction.markProcessed({ observedBalance: usd })).toThrow(WagerTransactionError);
    expect(() => transaction.markProcessed({ observedBalance: observedBalance.negate() })).toThrow(WagerTransactionError);
    expect(() => transaction.markProcessed({ observedBalance, at: new Date('invalid') })).toThrow(WagerTransactionError);
    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.observedBalance).toBeUndefined();
    expect(transaction.finalizedAt).toBeUndefined();
  });

  test('validates the reference scope, kind, state and amount for a refund', () => {
    const refund = referencing(Kind.Refund);
    const invalidReferences: Partial<CreateWagerTransactionProps>[] = [
      { externalTransactionId: 'another-external-id' }, { providerId: 'another-provider' },
      { playerId: 'another-player' }, { walletId: 'another-wallet' }, { roundId: 'another-round' },
      { money: Money.from({ amount: '25.00', currency: 'USD' }) }, { money: brl('24.99') }, { kind: Kind.Win },
    ];

    for (const overrides of invalidReferences) {
      const reference = create(overrides);
      reference.markProcessed({ observedBalance: Money.zero(reference.currency) });
      expect(() => refund.markProcessed({ reference, observedBalance })).toThrow(WagerTransactionError);
    }
    expect(() => refund.markProcessed({ reference: create(), observedBalance })).toThrow(WagerTransactionError);
    expect(refund.status).toBe(Status.Pending);
    expect(refund.referenceTransactionId).toBeUndefined();
  });

  test('handles optional WIN references and processes LOSS without a ledger direction', () => {
    const win = referencing(Kind.Win);
    win.markProcessed({ reference: processedBet(), observedBalance });
    expect(win.referenceTransactionId).toBe(props.id);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const independentWin = create({ kind: Kind.Win });
    independentWin.markProcessed({ observedBalance });
    expect(independentWin.status).toBe(Status.Processed);

    const loss = create({ kind: Kind.Loss });
    loss.markProcessed({});
    expect(loss.status).toBe(Status.Processed);
    expect(loss.observedBalance).toBeUndefined();
    expect(loss.ledgerDirectionFor()).toBeUndefined();
  });

  test('derives the ledger direction and inverts only eligible rollback references', () => {
    const bet = processedBet();
    const win = create({ kind: Kind.Win });
    win.markProcessed({ observedBalance });
    const refund = referencing(Kind.Refund);
    refund.markProcessed({ reference: bet, observedBalance });
    const rollback = referencing(Kind.Rollback);
    const rollbackOfRefund = create({
      id: 'transaction-3', externalTransactionId: 'external-3', kind: Kind.Rollback,
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    const opening = create({ kind: Kind.Opening });
    opening.markProcessed({ observedBalance });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollbackOfRefund.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(WagerTransactionError);
    expect(() => rollback.ledgerDirectionFor(opening)).toThrow(WagerTransactionError);

    rollbackOfRefund.markProcessed({ reference: refund, observedBalance });
    expect(rollbackOfRefund.status).toBe(Status.Processed);
    expect(rollbackOfRefund.referenceTransactionId).toBe(refund.id);
  });

  test('rehydrates a processed result without loading its resolved reference again', () => {
    const transaction = WagerTransaction.rehydrate({
      ...props, kind: Kind.Refund, referenceExternalTransactionId: 'referenced-external',
      status: Status.Processed, referenceTransactionId: 'referenced-internal', observedBalance, finalizedAt,
    });

    expect(transaction.referenceExternalTransactionId).toBe('referenced-external');
    expect(transaction.referenceTransactionId).toBe('referenced-internal');
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.observedBalance?.toString()).toBe('75.00 BRL');
    expect(transaction.processedAt).toEqual(finalizedAt);
    expect(transaction.createdAt).toEqual(createdAt);
    expect(transaction.failureCode).toBeUndefined();
    expect(() => transaction.fail('OTHER_FAILURE')).toThrow(InvalidTransactionStateError);
  });

  test.each([Status.Pending, Status.PendingReference])('rehydrates %s without finalizing it', (status) => {
    const transaction = WagerTransaction.rehydrate({
      ...props, kind: Kind.Win, referenceExternalTransactionId: 'referenced-external', status,
    });

    expect(transaction.status).toBe(status);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.finalizedAt).toBeUndefined();
    transaction.reject('REFERENCE_NOT_FOUND', { at: finalizedAt });
    expect(transaction.status).toBe(Status.Rejected);
  });

  test('rejects inconsistent persisted outcome shapes', () => {
    expect(() => WagerTransaction.rehydrate({ ...props, status: 'UNKNOWN' as Status })).toThrow(WagerTransactionError);
    expect(() => WagerTransaction.rehydrate({ ...props, status: Status.Pending, observedBalance })).toThrow(WagerTransactionError);
    expect(() => WagerTransaction.rehydrate({ ...props, status: Status.PendingReference })).toThrow(WagerTransactionError);
    expect(() => WagerTransaction.rehydrate({ ...props, status: Status.Processed, observedBalance })).toThrow(WagerTransactionError);
    expect(() => WagerTransaction.rehydrate({ ...props, status: Status.Failed, finalizedAt })).toThrow(WagerTransactionError);
  });

  test('protects audit fields, dates and the original financial result from external changes', () => {
    const opened = new Date(createdAt);
    const processed = new Date(finalizedAt);
    const input = { ...props, createdAt: opened };
    const transaction = WagerTransaction.create(input);
    const result = { observedBalance, at: processed };
    transaction.markProcessed(result);

    input.payloadHash = 'modified';
    result.observedBalance = brl('99.00');
    opened.setTime(0);
    processed.setTime(0);
    transaction.createdAt.setTime(0);
    transaction.processedAt?.setTime(0);
    expect(Reflect.set(transaction, 'idempotencyKey', 'modified')).toBe(false);
    expect(Reflect.set(transaction, 'status', Status.Failed)).toBe(false);
    expect(transaction.matchesPayload(props.payloadHash)).toBe(true);
    expect(transaction.idempotencyKey).toBe(props.idempotencyKey);
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.observedBalance?.toString()).toBe('75.00 BRL');
    expect(transaction.createdAt).toEqual(createdAt);
    expect(transaction.finalizedAt).toEqual(finalizedAt);
  });
});
