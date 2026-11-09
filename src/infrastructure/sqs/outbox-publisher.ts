import { setTimeout as delay } from 'node:timers/promises';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEventEnvelope } from '../../domain/integration-events.js';
import { OutboxRecord } from '../database/outbox-record.js';
import { postgresNow } from '../database/postgres-time.js';
import { logEvent } from '../observability/log.js';
import { processingMetrics } from '../observability/processing-metrics.js';

export interface OutboxPublisherOptions {
  batchSize: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

interface PendingEvent {
  id: string;
  aggregate_id: string;
  attempts: number;
  payload: IntegrationEventEnvelope<{ transactionId?: unknown; walletId?: unknown; providerId?: unknown }>;
}

type Publication =
  | { status: 'published'; messageId: string }
  | { status: 'retry' | 'failed'; code: string };

type Log = (entry: Readonly<Record<string, unknown>>) => void;

const PERMANENT_MESSAGE_ERRORS = ['InvalidMessageContents', 'InvalidParameterValue', 'MessageTooLong'];
const SAFE_SEND_ERRORS = new Set([
  ...PERMANENT_MESSAGE_ERRORS, 'QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue', 'AccessDenied',
  'AccessDeniedException', 'RequestThrottled', 'TimeoutError', 'MISSING_SQS_MESSAGE_ID',
]);

export class OutboxPublisher {
  readonly #stop = new AbortController();

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly options: OutboxPublisherOptions,
    private readonly log: Log = logEvent,
  ) {}

  stop(): void {
    this.#stop.abort();
  }

  async run(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      try {
        if (await this.publishBatch()) continue;
      } catch {
        processingMetrics.increment('retries', 'outbox');
        this.log({ event: 'outbox_batch_failed' });
      }
      try {
        await delay(this.options.pollIntervalMs, undefined, { signal: this.#stop.signal });
      } catch (error) {
        if (!this.#stop.signal.aborted) throw error;
      }
    }
  }

  async publishBatch(): Promise<number> {
    const outcomes = await this.em.fork().transactional(async (tx) => {
      const schema = tx.schema ?? tx.config.getSchema() ?? 'public';
      const table = tx.getPlatform().quoteIdentifier(`${schema}.${tx.getMetadata(OutboxRecord).tableName}`);
      const events = await tx.execute<PendingEvent[]>(`
        SELECT event.id, event.aggregate_id, event.attempts, event.payload
        FROM ${table} AS event
        WHERE event.published_at IS NULL AND event.failed_at IS NULL
          AND (event.next_attempt_at IS NULL OR event.next_attempt_at <= statement_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM ${table} AS earlier
            WHERE earlier.aggregate_id = event.aggregate_id AND earlier.published_at IS NULL
              AND earlier.publication_order < event.publication_order
          )
        ORDER BY COALESCE(event.next_attempt_at, event.occurred_at), event.occurred_at, event.id
        LIMIT ? FOR UPDATE OF event SKIP LOCKED
      `, [this.options.batchSize]);
      if (events.length === 0) return [];

      // Each selected row is the head of a different aggregate.
      const results = await Promise.all(events.map(async (event) => ({ event, outcome: await this.#send(event) })));
      const at = await postgresNow(tx);
      for (const { event, outcome } of results) {
        const attempts = event.attempts + 1;
        if (outcome.status === 'published') {
          await tx.nativeUpdate(OutboxRecord, { id: event.id }, { attempts, publishedAt: at, nextAttemptAt: null, lastErrorCode: null });
        } else if (outcome.status === 'failed') {
          await tx.nativeUpdate(OutboxRecord, { id: event.id }, { attempts, failedAt: at, nextAttemptAt: null, lastErrorCode: outcome.code });
        } else {
          const backoff = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** Math.min(event.attempts, 31));
          await tx.nativeUpdate(OutboxRecord, { id: event.id }, { attempts, nextAttemptAt: new Date(at.getTime() + backoff), lastErrorCode: outcome.code });
        }
      }
      return results;
    }).catch((error: unknown) => {
      processingMetrics.recordLockConflict('outbox', error);
      throw error;
    });

    for (const { event, outcome } of outcomes) {
      if (outcome.status === 'retry') processingMetrics.increment('retries', 'outbox');
      const { transactionId, walletId, providerId } = event.payload.data;
      this.log({ event: `outbox_${outcome.status}`, eventId: event.id, aggregateId: event.aggregate_id,
        eventType: event.payload.eventType, correlationId: event.payload.correlationId, attempts: event.attempts + 1,
        transactionId: typeof transactionId === 'string' ? transactionId : undefined,
        walletId: typeof walletId === 'string' ? walletId : undefined,
        providerId: typeof providerId === 'string' ? providerId : undefined,
        ...(outcome.status === 'published'
          ? { messageId: outcome.messageId }
          : { errorCode: SAFE_SEND_ERRORS.has(outcome.code) ? outcome.code : 'SQS_SEND_FAILED' }) });
    }
    return outcomes.length;
  }

  async #send(event: PendingEvent): Promise<Publication> {
    const startedAt = performance.now();
    try {
      const result = await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregate_id,
        MessageDeduplicationId: event.id,
      }));
      return result.MessageId ? { status: 'published', messageId: result.MessageId } : { status: 'retry', code: 'MISSING_SQS_MESSAGE_ID' };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const code = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : 'UNKNOWN_SQS_ERROR';
      return { status: PERMANENT_MESSAGE_ERRORS.includes(code) ? 'failed' : 'retry', code };
    } finally {
      processingMetrics.observe('outbox', startedAt);
    }
  }
}
