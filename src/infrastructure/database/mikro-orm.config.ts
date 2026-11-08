import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletRecord, WagerTransactionRecord, WalletLedgerEntryRecord } from './financial-records.js';
import { Migration20261107000100_FinancialSchema } from './migrations/Migration20261107000100_FinancialSchema.js';
import { Migration20261107000200_TransactionalOutbox } from './migrations/Migration20261107000200_TransactionalOutbox.js';
import { OutboxRecord } from './outbox-record.js';

export const postgresConfig = defineConfig({
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  dbName: process.env.POSTGRES_DB ?? 'jungle',
  user: process.env.POSTGRES_USER ?? 'jungle',
  password: process.env.POSTGRES_PASSWORD,
  entities: [WalletRecord, WagerTransactionRecord, WalletLedgerEntryRecord, OutboxRecord],
  extensions: [Migrator],
  migrations: {
    migrationsList: [Migration20261107000100_FinancialSchema, Migration20261107000200_TransactionalOutbox],
    transactional: true,
    disableForeignKeys: false,
    snapshot: false,
  },
});
