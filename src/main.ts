import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { readLedgerCursorSecret } from './infrastructure/http/financial-query-contracts.js';
import { logEvent } from './infrastructure/observability/log.js';

readLedgerCursorSecret();
let app: INestApplication | undefined;
try {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? '3000'));
  logEvent({ event: 'process_started', component: 'http' });
} catch {
  logEvent({ event: 'process_failed', component: 'http' });
  process.exitCode = 1;
  await app?.close();
}
