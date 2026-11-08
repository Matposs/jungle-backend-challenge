import {
  BadRequestException, Body, ConflictException, Controller, Headers, HttpCode, Inject, Post,
  HttpStatus, Res, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import {
  DuplicateReversalError, InvalidWagerInputError, SubmitWager, WagerIdentityConflictError, WagerUnavailableError, type SubmitWagerInput,
} from '../../application/submit-wager.js';
import { Money, MoneyError } from '../../domain/money.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.js';

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new BadRequestException(`${field} must be a non-blank string without NUL characters.`);
  }
  return value;
}

function parseWager(body: unknown, header: unknown): SubmitWagerInput {
  if (!body || typeof body !== 'object' || !('kind' in body)) {
    throw new BadRequestException('kind is required.');
  }
  const { kind } = body;
  if (kind !== WagerTransactionKind.Bet && kind !== WagerTransactionKind.Win &&
      kind !== WagerTransactionKind.Loss && kind !== WagerTransactionKind.Refund && kind !== WagerTransactionKind.Rollback) {
    throw new BadRequestException('kind must be BET, WIN, LOSS, REFUND or ROLLBACK.');
  }
  let referenceExternalTransactionId: string | undefined;
  if ('referenceExternalTransactionId' in body) {
    if (kind !== WagerTransactionKind.Win && kind !== WagerTransactionKind.Refund && kind !== WagerTransactionKind.Rollback) {
      throw new BadRequestException(`${kind} does not support a reference.`);
    }
    referenceExternalTransactionId = requiredText(body.referenceExternalTransactionId, 'referenceExternalTransactionId');
  }

  const payload = body as Record<string, unknown>;
  const money = payload.money;
  if (!money || typeof money !== 'object' || !('amount' in money) || !('currency' in money)) {
    throw new BadRequestException('money must contain amount and currency.');
  }

  let amount: Money;
  try {
    amount = Money.from({ amount: requiredText(money.amount, 'money.amount'), currency: requiredText(money.currency, 'money.currency') });
  } catch (error) {
    if (error instanceof MoneyError) throw new BadRequestException(error.message);
    throw error;
  }
  return {
    kind,
    referenceExternalTransactionId,
    providerId: requiredText(payload.providerId, 'providerId'),
    externalTransactionId: requiredText(payload.externalTransactionId, 'externalTransactionId'),
    idempotencyKey: requiredText(header, 'Idempotency-Key'),
    playerId: requiredText(payload.playerId, 'playerId'),
    walletId: requiredText(payload.walletId, 'walletId'),
    roundId: requiredText(payload.roundId, 'roundId'),
    gameId: requiredText(payload.gameId, 'gameId'),
    money: amount,
  };
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(@Inject(SubmitWager) private readonly submitWager: SubmitWager) {}

  @Post()
  @HttpCode(200)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') header: unknown,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ) {
    const input = parseWager(body, header);
    try {
      const { transaction, idempotentReplay } = await this.submitWager.execute(input);
      const result = {
        transactionId: transaction.id, status: transaction.status,
        balance: transaction.observedBalance?.toJSON(), idempotentReplay,
      };
      if (transaction.status === WagerTransactionStatus.Rejected) {
        throw new UnprocessableEntityException({ ...result, failureCode: transaction.failureCode });
      }
      if (transaction.status === WagerTransactionStatus.PendingReference) response.status(HttpStatus.ACCEPTED);
      return result;
    } catch (error) {
      if (error instanceof DuplicateReversalError) {
        throw new ConflictException({ statusCode: HttpStatus.CONFLICT, failureCode: error.failureCode, message: error.message });
      }
      if (error instanceof WagerIdentityConflictError) throw new ConflictException(error.message);
      if (error instanceof InvalidWagerInputError) throw new BadRequestException(error.message);
      if (error instanceof WagerUnavailableError) throw new ServiceUnavailableException(error.message);
      throw error;
    }
  }
}
