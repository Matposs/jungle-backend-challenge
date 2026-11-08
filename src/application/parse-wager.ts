import { Money, MoneyError } from '../domain/money.js';
import { WagerTransactionKind as Kind } from '../domain/wager-transaction.js';
import { InvalidWagerInputError, type SubmitWagerInput } from './submit-wager.js';

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new InvalidWagerInputError(`${field} must be a non-blank string without NUL characters.`);
  }
  return value;
}

export function parseWager(body: unknown, idempotencyKey: unknown): SubmitWagerInput {
  if (!body || typeof body !== 'object' || !('kind' in body)) {
    throw new InvalidWagerInputError('kind is required.');
  }
  const { kind } = body;
  if (kind !== Kind.Bet && kind !== Kind.Win && kind !== Kind.Loss && kind !== Kind.Refund && kind !== Kind.Rollback) {
    throw new InvalidWagerInputError('kind must be BET, WIN, LOSS, REFUND or ROLLBACK.');
  }
  let referenceExternalTransactionId: string | undefined;
  if ('referenceExternalTransactionId' in body) {
    if (kind !== Kind.Win && kind !== Kind.Refund && kind !== Kind.Rollback) {
      throw new InvalidWagerInputError(`${kind} does not support a reference.`);
    }
    referenceExternalTransactionId = requiredText(body.referenceExternalTransactionId, 'referenceExternalTransactionId');
  }

  const payload = body as Record<string, unknown>;
  const money = payload.money;
  if (!money || typeof money !== 'object' || !('amount' in money) || !('currency' in money)) {
    throw new InvalidWagerInputError('money must contain amount and currency.');
  }

  try {
    return {
      kind,
      referenceExternalTransactionId,
      providerId: requiredText(payload.providerId, 'providerId'),
      externalTransactionId: requiredText(payload.externalTransactionId, 'externalTransactionId'),
      idempotencyKey: requiredText(idempotencyKey, 'Idempotency-Key'),
      playerId: requiredText(payload.playerId, 'playerId'),
      walletId: requiredText(payload.walletId, 'walletId'),
      roundId: requiredText(payload.roundId, 'roundId'),
      gameId: requiredText(payload.gameId, 'gameId'),
      money: Money.from({ amount: requiredText(money.amount, 'money.amount'), currency: requiredText(money.currency, 'money.currency') }),
    };
  } catch (error) {
    if (error instanceof MoneyError) throw new InvalidWagerInputError(error.message);
    throw error;
  }
}
