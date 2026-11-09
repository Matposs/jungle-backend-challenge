import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { OpenWallet } from '../../application/open-wallet.js';
import { ReconcileWallet } from '../../application/reconcile-wallet.js';
import { PostgresFinancialQueries } from '../database/postgres-financial-queries.js';
import { PostgresWalletOpeningStore } from '../database/postgres-wallet-opening-store.js';
import { WalletsController } from './wallets.controller.js';
import { FinancialQueriesModule } from './financial-queries.module.js';
import { ReconciliationMetrics, ReconciliationMetricsController } from './reconciliation-metrics.js';

@Module({
  imports: [FinancialQueriesModule],
  controllers: [WalletsController, ReconciliationMetricsController],
  providers: [
    {
      provide: OpenWallet,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new OpenWallet(new PostgresWalletOpeningStore(em)),
    },
    {
      provide: ReconcileWallet,
      inject: [PostgresFinancialQueries, ReconciliationMetrics],
      useFactory: (store: PostgresFinancialQueries, metrics: ReconciliationMetrics) =>
        new ReconcileWallet(store, (walletId, checkedEntries) => metrics.recordDivergence(walletId, checkedEntries)),
    },
    ReconciliationMetrics,
  ],
})
export class WalletsModule {}
