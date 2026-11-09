import 'reflect-metadata';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { SubmitWager } from '../../application/submit-wager.js';
import { logEvent } from '../observability/log.js';
import { startProcessingMetrics } from '../observability/processing-metrics.js';
import { WAGER_QUEUE } from './queues.js';
import { WagerConsumer } from './wager-consumer.js';

async function run() {
  const sqs = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.AWS_REGION ?? 'us-east-1',
    requestHandler: { connectionTimeout: 3000, requestTimeout: 25_000, throwOnRequestTimeout: true },
  });
  try {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    try {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE }));
      if (!QueueUrl) throw new Error('SQS did not return the wager queue URL.');
      const consumer = new WagerConsumer(sqs, QueueUrl, app.get(SubmitWager));
      const metrics = startProcessingMetrics(9465);
      const stop = () => consumer.stop();
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      try {
        logEvent({ event: 'process_started', component: 'sqs' });
        await consumer.run();
      } finally {
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
        await metrics.stop(true);
      }
    } finally {
      await app.close();
    }
  } finally {
    sqs.destroy();
  }
}

try {
  await run();
} catch {
  logEvent({ event: 'process_failed', component: 'sqs' });
  process.exitCode = 1;
}
