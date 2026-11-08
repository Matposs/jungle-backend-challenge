import { MikroORM } from '@mikro-orm/postgresql';
import { postgresConfig } from './mikro-orm.config.js';

const command = process.argv[2];
if (command !== 'up' && command !== 'status' && command !== 'down') {
  throw new Error('Usage: migrate.ts up|status|down');
}

const orm = await MikroORM.init(postgresConfig);
try {
  const migrator = orm.migrator;
  if (command === 'up') {
    const applied = await migrator.up();
    console.log('Applied:', applied.map(({ name }) => name));
  } else if (command === 'down') {
    const reverted = await migrator.down();
    console.log('Reverted:', reverted.map(({ name }) => name));
  } else {
    const applied = await migrator.getExecuted();
    const pending = await migrator.getPending();
    console.log('Applied:', applied.map(({ name }) => name));
    console.log('Pending:', pending.map(({ name }) => name));
  }
} finally {
  await orm.close();
}
