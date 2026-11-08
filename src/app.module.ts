import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { postgresConfig } from './infrastructure/database/mikro-orm.config.js';
import { HealthController } from './infrastructure/http/health.controller.js';
import { WageringModule } from './infrastructure/http/wagering.module.js';
import { WalletsModule } from './infrastructure/http/wallets.module.js';

@Module({
  imports: [MikroOrmModule.forRoot(postgresConfig), WalletsModule, WageringModule],
  controllers: [HealthController],
})
export class AppModule {}
