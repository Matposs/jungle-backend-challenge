import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000100_FinancialSchema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id text PRIMARY KEY,
        player_id text NOT NULL,
        currency varchar(3) NOT NULL,
        balance numeric(20,2) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_identity_unique UNIQUE (id, player_id, currency),
        CONSTRAINT wallets_identity_check CHECK (btrim(id) <> '' AND btrim(player_id) <> ''),
        CONSTRAINT wallets_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_check CHECK (balance >= 0 AND balance <> 'NaN'::numeric),
        CONSTRAINT wallets_version_check CHECK (version >= 1)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id text PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash text NOT NULL,
        wallet_id text NOT NULL,
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        amount numeric(20,2) NOT NULL,
        currency varchar(3) NOT NULL,
        ledger_amount numeric(20,2) GENERATED ALWAYS AS (
          CASE WHEN status = 'PROCESSED' AND kind <> 'LOSS' THEN amount END
        ) STORED,
        reference_external_transaction_id text,
        reference_transaction_id text,
        failure_code text,
        observed_balance numeric(20,2),
        created_at timestamptz NOT NULL,
        finalized_at timestamptz,
        reference_attempts integer NOT NULL DEFAULT 0,
        reference_next_attempt_at timestamptz,
        CONSTRAINT wager_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_provider_idempotency_unique UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_reference_target_unique UNIQUE (id, provider_id, external_transaction_id, wallet_id, round_id),
        CONSTRAINT wager_ledger_target_unique UNIQUE (id, wallet_id, currency, ledger_amount),
        CONSTRAINT wager_wallet_fk FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES wallets (id, player_id, currency),
        CONSTRAINT wager_reference_fk
          FOREIGN KEY (reference_transaction_id, provider_id, reference_external_transaction_id, wallet_id, round_id)
          REFERENCES wager_transactions (id, provider_id, external_transaction_id, wallet_id, round_id),
        CONSTRAINT wager_required_text_check CHECK (
          btrim(id) <> '' AND btrim(provider_id) <> '' AND btrim(external_transaction_id) <> ''
          AND btrim(idempotency_key) <> '' AND btrim(payload_hash) <> ''
          AND btrim(round_id) <> '' AND btrim(game_id) <> ''
        ),
        CONSTRAINT wager_kind_check CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_status_check CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_amount_check CHECK (amount >= 0 AND amount <> 'NaN'::numeric),
        CONSTRAINT wager_observed_balance_check CHECK (
          observed_balance >= 0 AND observed_balance <> 'NaN'::numeric
        ),
        CONSTRAINT wager_reference_shape_check CHECK (
          (reference_external_transaction_id IS NULL OR
            (kind IN ('WIN', 'REFUND', 'ROLLBACK') AND btrim(reference_external_transaction_id) <> ''))
          AND (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL)
          AND (reference_transaction_id IS NULL OR
            (reference_external_transaction_id IS NOT NULL AND reference_transaction_id <> id))
          AND (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL)
          AND (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL)
        ),
        CONSTRAINT wager_outcome_check CHECK (
          ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (finalized_at IS NOT NULL))
          AND ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL))
          AND (failure_code IS NULL OR btrim(failure_code) <> '')
          AND (finalized_at IS NOT NULL OR (observed_balance IS NULL AND reference_transaction_id IS NULL))
          AND (status <> 'PROCESSED' OR kind = 'LOSS' OR observed_balance IS NOT NULL)
        ),
        CONSTRAINT wager_reference_attempts_check CHECK (reference_attempts >= 0)
      );
    `);

    // Reserve the external reference even before resolution. Unsuccessful attempts release it.
    this.addSql(`
      CREATE UNIQUE INDEX wager_reversal_reference_unique
        ON wager_transactions (provider_id, reference_external_transaction_id, kind)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED');
    `);
    this.addSql('CREATE INDEX wager_wallet_idx ON wager_transactions (wallet_id);');
    this.addSql(`
      CREATE INDEX wager_resolved_reference_idx ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;
    `);
    this.addSql(`
      CREATE INDEX wager_pending_reference_due_idx
        ON wager_transactions (reference_next_attempt_at NULLS FIRST, created_at, id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id text PRIMARY KEY,
        wallet_id text NOT NULL,
        transaction_id text NOT NULL,
        direction text NOT NULL,
        amount numeric(20,2) NOT NULL,
        currency varchar(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after numeric(20,2) NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency, amount)
          REFERENCES wager_transactions (id, wallet_id, currency, ledger_amount),
        CONSTRAINT ledger_id_check CHECK (btrim(id) <> ''),
        CONSTRAINT ledger_direction_check CHECK (direction IN ('CREDIT', 'DEBIT')),
        CONSTRAINT ledger_amount_check CHECK (amount > 0 AND amount <> 'NaN'::numeric),
        CONSTRAINT ledger_balances_check CHECK (
          balance_before >= 0 AND balance_before <> 'NaN'::numeric
          AND balance_after >= 0 AND balance_after <> 'NaN'::numeric
        ),
        CONSTRAINT ledger_arithmetic_check CHECK (
          balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END
        )
      );
    `);
    this.addSql('CREATE INDEX ledger_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, created_at, id);');

    this.addSql(`
      CREATE FUNCTION reject_wallet_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger entries are immutable' USING ERRCODE = '55000';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_wallet_ledger_mutation();
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wallet_ledger_entries;');
    this.addSql('DROP FUNCTION reject_wallet_ledger_mutation();');
    this.addSql('DROP TABLE wager_transactions;');
    this.addSql('DROP TABLE wallets;');
  }
}
