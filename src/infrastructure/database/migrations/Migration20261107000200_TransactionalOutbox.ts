import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000200_TransactionalOutbox extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE outbox_messages (
        id text PRIMARY KEY,
        aggregate_id text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        CONSTRAINT outbox_attempts_check CHECK (attempts >= 0),
        CONSTRAINT outbox_envelope_check CHECK (
          jsonb_typeof(payload) = 'object'
          AND payload ?& ARRAY['eventId', 'aggregateId', 'eventType', 'correlationId', 'occurredAt', 'version', 'data']
          AND payload->'eventId' = to_jsonb(id)
          AND payload->'aggregateId' = to_jsonb(aggregate_id)
          AND payload->'eventType' = to_jsonb(event_type)
          AND jsonb_typeof(payload->'correlationId') = 'string'
          AND btrim(payload->>'correlationId') <> ''
          AND (NOT (payload ? 'causationId') OR jsonb_typeof(payload->'causationId') = 'string')
          AND jsonb_typeof(payload->'occurredAt') = 'string'
          AND jsonb_typeof(payload->'version') = 'number'
          AND payload->>'version' ~ '^[1-9][0-9]*$'
          AND jsonb_typeof(payload->'data') = 'object'
        )
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_due_idx ON outbox_messages (next_attempt_at NULLS FIRST, occurred_at, id)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages;');
  }
}
