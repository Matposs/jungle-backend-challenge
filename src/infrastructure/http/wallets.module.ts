import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { OpenWallet } from '../../application/open-wallet.js';
import { PostgresWalletOpeningStore } from '../database/postgres-wallet-opening-store.js';
import { WalletsController } from './wallets.controller.js';

@Module({
  controllers: [WalletsController],
  providers: [{
    provide: OpenWallet,
    inject: [EntityManager],
    useFactory: (em: EntityManager) => new OpenWallet(new PostgresWalletOpeningStore(em)),
  }],
})
export class WalletsModule {}
