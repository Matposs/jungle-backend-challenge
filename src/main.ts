import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { readLedgerCursorSecret } from './infrastructure/http/financial-query-contracts.js';

readLedgerCursorSecret();
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? '3000'));
