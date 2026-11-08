import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { SubmitWager } from '../../application/submit-wager.js';
import { PostgresWagerStore } from '../database/postgres-wager-store.js';
import { WageringController } from './wagering.controller.js';
import { FinancialQueriesModule } from './financial-queries.module.js';
import { ProviderTransactionsController } from './provider-transactions.controller.js';

@Module({
  imports: [FinancialQueriesModule],
  controllers: [WageringController, ProviderTransactionsController],
  providers: [{
    provide: SubmitWager,
    inject: [EntityManager],
    useFactory: (em: EntityManager) => new SubmitWager(new PostgresWagerStore(em)),
  }],
  exports: [SubmitWager],
})
export class WageringModule {}
