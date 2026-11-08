import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { FinancialQueries } from '../../application/financial-queries.js';
import { PostgresFinancialQueries } from '../database/postgres-financial-queries.js';

@Module({
  providers: [{
    provide: FinancialQueries,
    inject: [EntityManager],
    useFactory: (em: EntityManager) => new FinancialQueries(new PostgresFinancialQueries(em)),
  }],
  exports: [FinancialQueries],
})
export class FinancialQueriesModule {}
