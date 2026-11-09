import { MikroORM } from '@mikro-orm/postgresql';
import { logEvent } from '../observability/log.js';
import { startProcessingMetrics } from '../observability/processing-metrics.js';
import { postgresConfig } from './mikro-orm.config.js';
import { PendingReferenceWorker } from './pending-reference-worker.js';
import { PostgresWagerStore } from './postgres-wager-store.js';

async function run() {
  const orm = await MikroORM.init(postgresConfig);
  try {
    const worker = new PendingReferenceWorker(new PostgresWagerStore(orm.em));
    const metrics = startProcessingMetrics(9467);
    const stop = () => worker.stop();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      logEvent({ event: 'process_started', component: 'references' });
      await worker.run();
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      await metrics.stop(true);
    }
  } finally {
    await orm.close();
  }
}

try {
  await run();
} catch {
  logEvent({ event: 'process_failed', component: 'references' });
  process.exitCode = 1;
}
