import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000300_TransactionalInbox extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash text NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id),
        CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CHECK (processed_at >= received_at)
      );
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE inbox_messages;');
  }
}
