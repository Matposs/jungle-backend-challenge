import 'reflect-metadata';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { SubmitWager } from '../../application/submit-wager.js';
import { WagerConsumer } from './wager-consumer.js';

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT,
  region: process.env.AWS_REGION ?? 'us-east-1',
  requestHandler: { connectionTimeout: 3000, requestTimeout: 25_000, throwOnRequestTimeout: true },
});
const app = await NestFactory.createApplicationContext(AppModule);
try {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
  if (!QueueUrl) throw new Error('SQS did not return the wager queue URL.');
  const consumer = new WagerConsumer(sqs, QueueUrl, app.get(SubmitWager));
  const stop = () => consumer.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await consumer.run();
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
} finally {
  sqs.destroy();
  await app.close();
}
