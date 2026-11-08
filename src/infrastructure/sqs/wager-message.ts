import { createHash } from 'node:crypto';
import { parseWager, requiredText } from '../../application/parse-wager.js';
import { InvalidWagerInputError } from '../../application/submit-wager.js';

export function parseWagerMessage(body: string | undefined) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? '');
  } catch {
    throw new InvalidWagerInputError('SQS message body must be valid JSON.');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new InvalidWagerInputError('SQS message must be an object.');
  }
  const { messageId, type, occurredAt, data } = envelope as Record<string, unknown>;
  if (type !== 'WagerTransactionRequested') throw new InvalidWagerInputError('Unknown SQS event type.');
  if (typeof occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt) ||
      !Number.isFinite(Date.parse(occurredAt))) {
    throw new InvalidWagerInputError('occurredAt must be an ISO-8601 timestamp with a timezone.');
  }
  const id = requiredText(messageId, 'messageId');
  const input = parseWager(data, data && typeof data === 'object' && 'idempotencyKey' in data ? data.idempotencyKey : undefined);
  const canonical = JSON.stringify(envelope, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record<string, unknown>)[key]]));
  });
  return { messageId: id, input, payloadHash: createHash('sha256').update(canonical).digest('hex') };
}
