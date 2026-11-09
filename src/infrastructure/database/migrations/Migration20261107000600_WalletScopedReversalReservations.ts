import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000600_WalletScopedReversalReservations extends Migration {
  override up(): void {
    this.addSql('DROP INDEX wager_reversal_reference_unique;');
    this.addSql(`
      CREATE UNIQUE INDEX wager_reversal_reference_unique
        ON wager_transactions (provider_id, wallet_id, reference_external_transaction_id, kind)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED');
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX wager_reversal_reference_unique;');
    this.addSql(`
      CREATE UNIQUE INDEX wager_reversal_reference_unique
        ON wager_transactions (provider_id, reference_external_transaction_id, kind)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED');
    `);
  }
}
