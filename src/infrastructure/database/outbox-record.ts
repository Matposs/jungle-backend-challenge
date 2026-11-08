import { defineEntity } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent, IntegrationEventEnvelope } from '../../domain/integration-events.js';

export const OutboxRecord = defineEntity({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: (p) => ({
    id: p.text().primary(),
    aggregateId: p.text(),
    eventType: p.text(),
    payload: p.json<IntegrationEventEnvelope<object>>().columnType('jsonb'),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
  }),
});

export async function insertOutboxEvents(em: EntityManager, events: readonly IntegrationEvent<object>[]): Promise<void> {
  await em.insertMany(OutboxRecord, events.map((event) => {
    const payload = event.toJSON();
    return {
      id: payload.eventId, aggregateId: payload.aggregateId, eventType: payload.eventType,
      occurredAt: new Date(payload.occurredAt), payload,
    };
  }));
}
