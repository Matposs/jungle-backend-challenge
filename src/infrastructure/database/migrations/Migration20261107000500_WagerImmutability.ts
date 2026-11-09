import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000500_WagerImmutability extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION reject_wager_immutable_changes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
               NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
               NEW.reference_external_transaction_id)
           IS DISTINCT FROM
           ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
               OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
               OLD.reference_external_transaction_id) THEN
          RAISE EXCEPTION 'wager identity and business fields are immutable' USING ERRCODE = '55000';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND
           ROW(NEW.status, NEW.reference_transaction_id, NEW.failure_code, NEW.observed_balance,
               NEW.created_at, NEW.finalized_at)
           IS DISTINCT FROM
           ROW(OLD.status, OLD.reference_transaction_id, OLD.failure_code, OLD.observed_balance,
               OLD.created_at, OLD.finalized_at) THEN
          RAISE EXCEPTION 'terminal wager outcomes are immutable' USING ERRCODE = '55000';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_immutable_fields
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION reject_wager_immutable_changes();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER wager_immutable_fields ON wager_transactions;');
    this.addSql('DROP FUNCTION reject_wager_immutable_changes();');
  }
}
