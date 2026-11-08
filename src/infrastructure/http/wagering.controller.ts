import {
  BadRequestException, Body, ConflictException, Controller, Headers, HttpCode, Inject, Post,
  HttpStatus, Res, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import {
  DuplicateReversalError, InvalidWagerInputError, SubmitWager, WagerIdentityConflictError, WagerUnavailableError,
} from '../../application/submit-wager.js';
import { parseWager } from '../../application/parse-wager.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';

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
    try {
      const input = parseWager(body, header);
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
