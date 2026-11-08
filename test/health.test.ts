import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';

test('GET /health/live returns HTTP 200 with the liveness status', async () => {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });

  try {
    await app.listen(0, '127.0.0.1');

    const response = await fetch(`${await app.getUrl()}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    await app.close();
  }
});
