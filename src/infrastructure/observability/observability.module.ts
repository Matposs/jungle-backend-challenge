import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import { DependencyObservability } from './dependency-observability.js';

@Global()
@Module({
  providers: [{
    provide: DependencyObservability,
    inject: [EntityManager],
    useFactory: (em: EntityManager) => new DependencyObservability(em, new SQSClient({
      endpoint: process.env.SQS_ENDPOINT,
      region: process.env.AWS_REGION ?? 'us-east-1',
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 1000, requestTimeout: 1500, throwOnRequestTimeout: true },
    })),
  }],
  exports: [DependencyObservability],
})
export class ObservabilityModule {}
