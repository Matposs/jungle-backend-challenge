import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { FinancialQueries } from '../../application/financial-queries.js';
import { FinancialQueryAccessGuard } from './financial-query-access.guard.js';
import { queryId, requireQueryResult, transactionResponse } from './financial-query-contracts.js';

@Controller('providers/:providerId/wagering/transactions')
@UseGuards(FinancialQueryAccessGuard)
export class ProviderTransactionsController {
  constructor(@Inject(FinancialQueries) private readonly queries: FinancialQueries) {}

  @Get(':externalTransactionId')
  async getTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const provider = queryId(providerId, 'providerId');
    const externalId = queryId(externalTransactionId, 'externalTransactionId');
    const transaction = await requireQueryResult(
      () => this.queries.providerTransaction(provider, externalId),
      'Transaction not found.',
    );
    return transactionResponse(transaction);
  }
}
