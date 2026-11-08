import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { FinancialQueriesUnavailableError, InvalidLedgerCursorError } from '../../application/financial-queries.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/wallet.js';

export function queryId(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new BadRequestException(`${name} must be a non-blank string without NUL characters.`);
  }
  return value;
}

export function ledgerLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(value)) {
    throw new BadRequestException('limit must be an integer from 1 to 100.');
  }
  return Number(value);
}

export function readLedgerCursorSecret(): Buffer {
  const secret = process.env.LEDGER_CURSOR_SECRET;
  if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret)) {
    throw new Error('LEDGER_CURSOR_SECRET must contain 64 hexadecimal characters (32 bytes).');
  }
  return Buffer.from(secret, 'hex');
}

function signCursor(payload: string): string {
  return createHmac('sha256', readLedgerCursorSecret()).update(payload).digest('base64url');
}

export function encodeLedgerCursor(walletId: string, entryId: string): string {
  const payload = Buffer.from(JSON.stringify([1, walletId, entryId])).toString('base64url');
  return `${payload}.${signCursor(payload)}`;
}

export function decodeLedgerCursor(value: unknown, walletId: string): string | undefined {
  if (value === undefined) return undefined;
  const invalid = new BadRequestException('Invalid ledger cursor.');
  if (typeof value !== 'string' || value.length > 16_384) throw invalid;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw invalid;
  const [, payload, signature] = match;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(signCursor(payload)))) throw invalid;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== 1 || decoded[1] !== walletId) throw invalid;
  return queryId(decoded[2], 'cursor entry ID');
}

export async function requireQueryResult<T>(read: () => Promise<T | null>, notFound: string): Promise<T> {
  try {
    const result = await read();
    if (result === null) throw new NotFoundException(notFound);
    return result;
  } catch (error) {
    if (error instanceof FinancialQueriesUnavailableError) throw new ServiceUnavailableException(error.message);
    if (error instanceof InvalidLedgerCursorError) throw new BadRequestException(error.message);
    throw error;
  }
}

export function walletResponse(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

export function ledgerEntryResponse(entry: WalletLedgerEntry) {
  return {
    id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
    money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function transactionResponse(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId, roundId: transaction.roundId, gameId: transaction.gameId,
    kind: transaction.kind, status: transaction.status, money: transaction.money.toJSON(),
    createdAt: transaction.createdAt.toISOString(), finalizedAt: transaction.finalizedAt?.toISOString(),
    observedBalance: transaction.observedBalance?.toJSON(), failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
  };
}
