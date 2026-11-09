import { ConnectionException, DeadlockException, DriverException } from '@mikro-orm/core';

const TRANSIENT_CONNECTION_CODES = new Set([
  '08001', '08003', '08006', '57P01', '57P02', '57P03', '53300',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
]);

// pg and pg-pool report these transport and pool errors without a code.
const UNCODED_CONNECTION_ERRORS = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'timeout expired',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
]);

export function isTransientPostgresConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  return error instanceof ConnectionException || TRANSIENT_CONNECTION_CODES.has(code) ||
    (error instanceof DriverException && !error.code && UNCODED_CONNECTION_ERRORS.has(error.message));
}

export function isTransientPostgresWriteError(error: unknown): boolean {
  if (isTransientPostgresConnectionError(error) || error instanceof DeadlockException) return true;
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  // BEGIN and COMMIT can surface the pg error directly, without the ORM's DriverException wrapper.
  return code ? ['40001', '55P03', '57014'].includes(String(code)) : UNCODED_CONNECTION_ERRORS.has(error.message);
}
