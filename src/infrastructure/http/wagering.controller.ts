import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Inject, Param, Post,
  HttpStatus, Res, ServiceUnavailableException, UnprocessableEntityException, UseGuards,
} from '@nestjs/common';
import { FinancialQueries } from '../../application/financial-queries.js';
import {
  DuplicateReversalError, InvalidWagerInputError, SubmitWager, WagerIdentityConflictError, WagerUnavailableError,
} from '../../application/submit-wager.js';
import { parseWager } from '../../application/parse-wager.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { FinancialQueryAccessGuard } from './financial-query-access.guard.js';
import { queryId, requireQueryResult, transactionResponse } from './financial-query-contracts.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(SubmitWager) private readonly submitWager: SubmitWager,
    @Inject(FinancialQueries) private readonly queries: FinancialQueries,
  ) {}

  @Get(':transactionId')
  @UseGuards(FinancialQueryAccessGuard)
  async getTransaction(@Param('transactionId') transactionId: string) {
    const id = queryId(transactionId, 'transactionId');
    const transaction = await requireQueryResult(() => this.queries.transaction(id), 'Transaction not found.');
    return transactionResponse(transaction);
  }

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
