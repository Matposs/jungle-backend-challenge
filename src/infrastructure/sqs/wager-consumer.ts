import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import {
  DuplicateReversalError, InboxPayloadConflictError, InvalidWagerInputError, WagerIdentityConflictError, type SubmitWager,
} from '../../application/submit-wager.js';
import { parseWagerMessage } from './wager-message.js';
import { logEvent } from '../observability/log.js';
import { processingMetrics } from '../observability/processing-metrics.js';

export const WAGER_CONSUMER_NAME = 'wager-transactions';
const VISIBILITY_SECONDS = 60;

type Log = (entry: Readonly<Record<string, unknown>>) => void;

function permanentReason(error: unknown): string | undefined {
  if (error instanceof InvalidWagerInputError) return 'INVALID_MESSAGE';
  if (error instanceof InboxPayloadConflictError) return 'INBOX_PAYLOAD_CONFLICT';
  if (error instanceof WagerIdentityConflictError) return 'WAGER_IDENTITY_CONFLICT';
  if (error instanceof DuplicateReversalError) return error.failureCode;
  return undefined;
}

export class WagerConsumer {
  #stopping = false;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly submitWager: SubmitWager,
    private readonly log: Log = logEvent,
    private readonly waitTimeSeconds = 10,
  ) {}

  stop(): void {
    this.#stopping = true;
  }

  async run(): Promise<void> {
    while (!this.#stopping) {
      try {
        const { Messages } = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl, WaitTimeSeconds: this.waitTimeSeconds, MaxNumberOfMessages: 1,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
        for (const message of Messages ?? []) {
          if (!this.#stopping) await this.#process(message);
          else if (message.ReceiptHandle) await this.#changeVisibility(message.ReceiptHandle, 0);
        }
      } catch {
        if (!this.#stopping) processingMetrics.increment('retries', 'sqs');
        this.log({ event: 'sqs_poll_failed', consumerName: WAGER_CONSUMER_NAME });
        if (!this.#stopping) await Bun.sleep(1000);
      }
    }
  }

  async #process(message: Message): Promise<void> {
    const startedAt = performance.now();
    const receipt = message.ReceiptHandle;
    if (!receipt) {
      this.log({ event: 'sqs_missing_receipt', messageId: message.MessageId, correlationId: message.MessageId });
      processingMetrics.observe('sqs', startedAt);
      return;
    }
    const receiveCount = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount) || 1);
    let metadata: Record<string, unknown> = { messageId: message.MessageId, correlationId: message.MessageId, receiveCount };
    let committed = false;
    try {
      const { messageId, input, payloadHash } = parseWagerMessage(message.Body);
      metadata = { ...metadata, messageId, correlationId: messageId, walletId: input.walletId, providerId: input.providerId };
      const result = await this.#withVisibility(receipt, metadata, () => this.submitWager.execute(input, {
        consumerName: WAGER_CONSUMER_NAME, messageId, payloadHash,
      }));
      committed = true;
      if (result) metadata = { ...metadata, transactionId: result.transaction.id, correlationId: result.transaction.id };
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }));
      this.log({ ...metadata, event: 'sqs_ack', status: result?.transaction.status, duplicate: !result || result.idempotentReplay });
    } catch (error) {
      const reason = permanentReason(error);
      if (!reason) processingMetrics.increment('retries', 'sqs');
      const delay = reason ? 0 : Math.min(VISIBILITY_SECONDS, 2 ** Math.min(receiveCount - 1, 6));
      this.log({ ...metadata, event: reason ? 'sqs_permanent_failure' : 'sqs_retry', reason, committed, delay });
      try {
        await this.#changeVisibility(receipt, delay);
      } catch {
        this.log({ ...metadata, event: 'sqs_visibility_failed' });
      }
    } finally {
      processingMetrics.observe('sqs', startedAt);
    }
  }

  async #withVisibility<T>(receipt: string, metadata: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      renewal ??= this.#changeVisibility(receipt, VISIBILITY_SECONDS)
        .catch(() => this.log({ ...metadata, event: 'sqs_visibility_renewal_failed' }))
        .finally(() => { renewal = undefined; });
    }, 20_000);
    try {
      return await operation();
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  async #changeVisibility(receipt: string, seconds: number): Promise<void> {
    await this.sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl, ReceiptHandle: receipt, VisibilityTimeout: seconds,
    }));
  }
}
