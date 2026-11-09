import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletRecord, WagerTransactionRecord, WalletLedgerEntryRecord } from './financial-records.js';
import { Migration20261107000100_FinancialSchema } from './migrations/Migration20261107000100_FinancialSchema.js';
import { Migration20261107000200_TransactionalOutbox } from './migrations/Migration20261107000200_TransactionalOutbox.js';
import { Migration20261107000300_TransactionalInbox } from './migrations/Migration20261107000300_TransactionalInbox.js';
import { Migration20261107000400_OutboxPublication } from './migrations/Migration20261107000400_OutboxPublication.js';
import { Migration20261107000500_WagerImmutability } from './migrations/Migration20261107000500_WagerImmutability.js';
import { Migration20261107000600_WalletScopedReversalReservations } from './migrations/Migration20261107000600_WalletScopedReversalReservations.js';
import { Migration20261107000700_RoundScopedReversalReservations } from './migrations/Migration20261107000700_RoundScopedReversalReservations.js';
import { InboxRecord } from './inbox-record.js';
import { OutboxRecord } from './outbox-record.js';

export const postgresConfig = defineConfig({
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  dbName: process.env.POSTGRES_DB ?? 'jungle',
  user: process.env.POSTGRES_USER ?? 'jungle',
  password: process.env.POSTGRES_PASSWORD,
  driverOptions: { connectionTimeoutMillis: 3000 },
  entities: [WalletRecord, WagerTransactionRecord, WalletLedgerEntryRecord, OutboxRecord, InboxRecord],
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      Migration20261107000100_FinancialSchema, Migration20261107000200_TransactionalOutbox,
      Migration20261107000300_TransactionalInbox, Migration20261107000400_OutboxPublication,
      Migration20261107000500_WagerImmutability, Migration20261107000600_WalletScopedReversalReservations,
      Migration20261107000700_RoundScopedReversalReservations,
    ],
    transactional: true,
    disableForeignKeys: false,
    snapshot: false,
  },
});
