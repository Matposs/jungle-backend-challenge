import { MikroORM } from '@mikro-orm/postgresql';
import { postgresConfig } from './mikro-orm.config.js';
import { PendingReferenceWorker } from './pending-reference-worker.js';
import { PostgresWagerStore } from './postgres-wager-store.js';

const orm = await MikroORM.init(postgresConfig);
const worker = new PendingReferenceWorker(new PostgresWagerStore(orm.em));
const stop = () => worker.stop();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

try {
  await worker.run();
} finally {
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  await orm.close();
}
