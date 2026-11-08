import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { SubmitWager } from '../../application/submit-wager.js';
import { PostgresWagerStore } from '../database/postgres-wager-store.js';
import { WageringController } from './wagering.controller.js';

@Module({
  controllers: [WageringController],
  providers: [{
    provide: SubmitWager,
    inject: [EntityManager],
    useFactory: (em: EntityManager) => new SubmitWager(new PostgresWagerStore(em)),
  }],
})
export class WageringModule {}
