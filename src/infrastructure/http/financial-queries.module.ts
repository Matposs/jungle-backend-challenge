import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { FinancialQueries } from '../../application/financial-queries.js';
import { PostgresFinancialQueries } from '../database/postgres-financial-queries.js';

@Module({
  providers: [
    {
      provide: PostgresFinancialQueries,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new PostgresFinancialQueries(em),
    },
    {
      provide: FinancialQueries,
      inject: [PostgresFinancialQueries],
      useFactory: (store: PostgresFinancialQueries) => new FinancialQueries(store),
    },
  ],
  exports: [FinancialQueries, PostgresFinancialQueries],
})
export class FinancialQueriesModule {}
