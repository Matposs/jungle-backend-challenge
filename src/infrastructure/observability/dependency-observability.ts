import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { WagerTransactionRecord } from '../database/financial-records.js';
import { OutboxRecord } from '../database/outbox-record.js';
import { DEFAULT_OUTBOX_QUEUE, WAGER_DLQ, WAGER_QUEUE } from '../sqs/queues.js';
import { processingMetrics } from './processing-metrics.js';

const DLQ_COUNTS = [
  'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed',
] as const;

async function probe<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const signal = AbortSignal.timeout(2000);
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      operation(signal),
      new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class DependencyObservability {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    private readonly queues = {
      wager: WAGER_QUEUE, dlq: WAGER_DLQ, outbox: process.env.OUTBOX_QUEUE_NAME ?? DEFAULT_OUTBOX_QUEUE,
    },
  ) {}

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  async readiness() {
    const [postgres, sqs] = await Promise.all([
      probe(async (signal) => {
        await this.em.fork({ disableContextResolution: true }).execute('SELECT 1', [], {
          signal, inflightQueryAbortStrategy: 'cancel query',
        });
        return true;
      }),
      probe(async (signal) => {
        await Promise.all(Object.values(this.queues).map(async (queue) => {
          const { QueueArn } = await this.#queueAttributes(queue, ['QueueArn'], signal);
          if (!QueueArn) throw new Error('Queue identity is missing.');
        }));
        return true;
      }),
    ]);

    return { postgres: postgres === true, sqs: sqs === true };
  }

  async renderMetrics(): Promise<string> {
    const [database, dlq] = await Promise.all([
      probe((signal) => this.#databaseMetrics(signal)),
      probe(async (signal) => {
        const attributes = await this.#queueAttributes(this.queues.dlq, [...DLQ_COUNTS], signal);
        const counts = DLQ_COUNTS.map((key) => attributes[key]);
        if (!counts.every((count) => count !== undefined && /^\d+$/.test(count))) {
          throw new Error('Queue depth is unavailable.');
        }
        return counts.reduce((total, count) => total + BigInt(count!), 0n);
      }),
    ]);

    const lines = [
      '# TYPE postgres_metrics_up gauge',
      `postgres_metrics_up ${database === undefined ? 0 : 1}`,
      '# TYPE sqs_metrics_up gauge',
      `sqs_metrics_up ${dlq === undefined ? 0 : 1}`,
    ];
    if (database) {
      lines.push(
        '# TYPE wager_transactions gauge',
        ...Object.values(WagerTransactionStatus).map((status) =>
          `wager_transactions{status="${status}"} ${database.statuses[status] ?? '0'}`),
        '# TYPE outbox_lag_seconds gauge',
        `outbox_lag_seconds ${database.lag_seconds}`,
      );
    }
    if (dlq !== undefined) lines.push('# TYPE sqs_dlq_messages gauge', `sqs_dlq_messages ${dlq}`);
    return processingMetrics.render() + lines.join('\n') + '\n';
  }

  async #databaseMetrics(signal: AbortSignal) {
    const em = this.em.fork({ disableContextResolution: true });
    const schema = em.schema ?? em.config.getSchema() ?? 'public';
    const platform = em.getPlatform();
    const wagers = platform.quoteIdentifier(`${schema}.${em.getMetadata(WagerTransactionRecord).tableName}`);
    const outbox = platform.quoteIdentifier(`${schema}.${em.getMetadata(OutboxRecord).tableName}`);
    const [row] = await em.execute<{ statuses: Record<string, string>; lag_seconds: string }[]>(`
      SELECT COALESCE((
        SELECT jsonb_object_agg(counts.status, counts.total)
        FROM (SELECT status, COUNT(*)::text AS total FROM ${wagers} GROUP BY status) AS counts
      ), '{}'::jsonb) AS statuses,
      (SELECT GREATEST(EXTRACT(EPOCH FROM (statement_timestamp() - MIN(occurred_at))), 0)::text
       FROM ${outbox} WHERE published_at IS NULL) AS lag_seconds
    `, [], { signal, inflightQueryAbortStrategy: 'cancel query' });
    return row;
  }

  async #queueAttributes(queue: string, attributes: ('QueueArn' | typeof DLQ_COUNTS[number])[], abortSignal: AbortSignal) {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queue }), { abortSignal });
    if (!QueueUrl) throw new Error('Queue URL is missing.');
    const result = await this.sqs.send(new GetQueueAttributesCommand({
      QueueUrl, AttributeNames: attributes,
    }), { abortSignal });
    return result.Attributes ?? {};
  }
}
