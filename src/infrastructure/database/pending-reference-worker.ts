import { setTimeout as delay } from 'node:timers/promises';
import { PendingReferenceAttemptError, type PostgresWagerStore } from './postgres-wager-store.js';
import { logEvent } from '../observability/log.js';
import { processingMetrics } from '../observability/processing-metrics.js';

const FAILURE_COOLDOWN_MS = 5000;

export class PendingReferenceWorker {
  readonly #stop = new AbortController();
  readonly #retryAfter = new Map<string, number>();

  constructor(private readonly store: PostgresWagerStore) {}

  stop(): void {
    this.#stop.abort();
  }

  async run(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      try {
        await this.processBatch();
      } catch {
        processingMetrics.increment('retries', 'references');
        logEvent({ event: 'pending_reference_batch_failed' });
      }

      try {
        await delay(1000, undefined, { signal: this.#stop.signal });
      } catch (error) {
        if (!this.#stop.signal.aborted) throw error;
      }
    }
  }

  async processBatch(): Promise<void> {
    const now = performance.now();
    for (const [id, retryAfter] of this.#retryAfter) {
      if (retryAfter <= now) this.#retryAfter.delete(id);
    }
    const excludedIds = [...this.#retryAfter.keys()];

    for (let index = 0; index < 10 && !this.#stop.signal.aborted; index++) {
      try {
        if (!await this.store.processNextPendingReference(excludedIds)) return;
      } catch (error) {
        if (!(error instanceof PendingReferenceAttemptError)) throw error;
        excludedIds.push(error.transactionId);
        this.#retryAfter.set(error.transactionId, performance.now() + FAILURE_COOLDOWN_MS);
        processingMetrics.increment('retries', 'references');
      }
    }
  }
}
