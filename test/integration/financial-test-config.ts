import { postgresConfig } from '../../src/infrastructure/database/mikro-orm.config.js';

export function financialTestConfig(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^[a-zA-Z0-9_]+_test$/.test(dbName)) {
    throw new Error('FINANCIAL_TEST_DATABASE_URL must point to a PostgreSQL database ending in _test.');
  }

  return {
    ...postgresConfig,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    dbName,
    schema,
    migrations: { ...postgresConfig.migrations, schema },
  };
}
