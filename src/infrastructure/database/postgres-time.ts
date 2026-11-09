import type { EntityManager } from '@mikro-orm/postgresql';

export async function postgresNow(tx: EntityManager): Promise<Date> {
  const [{ at }] = await tx.execute<{ at: string }[]>('SELECT clock_timestamp() AS at');
  return new Date(at);
}
