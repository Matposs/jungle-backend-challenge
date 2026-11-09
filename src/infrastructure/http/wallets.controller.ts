import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Param, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { FinancialQueries } from '../../application/financial-queries.js';
import { OpenWallet, WalletAlreadyExistsError, WalletOpeningUnavailableError } from '../../application/open-wallet.js';
import { hasUnsupportedSqsJsonCharacters } from '../../application/parse-wager.js';
import { ReconcileWallet } from '../../application/reconcile-wallet.js';
import { Money, MoneyError, type MoneyProps } from '../../domain/money.js';
import { FinancialQueryAccessGuard } from './financial-query-access.guard.js';
import { decodeLedgerCursor, encodeLedgerCursor, ledgerEntryResponse, ledgerLimit, queryId, requireQueryResult, walletResponse } from './financial-query-contracts.js';

function parseOpeningRequest(body: unknown): { playerId: string; initialBalance: Money } {
  if (body === null || typeof body !== 'object' || !('playerId' in body) ||
      typeof body.playerId !== 'string' || !body.playerId.trim() || body.playerId.includes('\0')) {
    throw new BadRequestException('playerId must be a non-blank string without NUL characters.');
  }
  if (hasUnsupportedSqsJsonCharacters(body.playerId)) {
    throw new BadRequestException('playerId contains characters unsupported by SQS.');
  }
  if (!('initialBalance' in body) || body.initialBalance === null || typeof body.initialBalance !== 'object') {
    throw new BadRequestException('initialBalance must contain amount and currency.');
  }

  const { initialBalance, playerId } = body;
  if (!('amount' in initialBalance) || typeof initialBalance.amount !== 'string' ||
      !('currency' in initialBalance) || typeof initialBalance.currency !== 'string') {
    throw new BadRequestException('initialBalance.amount and initialBalance.currency must be strings.');
  }

  try {
    return { playerId, initialBalance: Money.from({ amount: initialBalance.amount, currency: initialBalance.currency }) };
  } catch (error) {
    if (error instanceof MoneyError) throw new BadRequestException(error.message);
    throw error;
  }
}

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(FinancialQueries) private readonly queries: FinancialQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Get(':walletId')
  @UseGuards(FinancialQueryAccessGuard)
  async getWallet(@Param('walletId') walletId: string) {
    const id = queryId(walletId, 'walletId');
    const wallet = await requireQueryResult(() => this.queries.wallet(id), 'Wallet not found.');
    return walletResponse(wallet);
  }

  @Get(':walletId/ledger')
  @UseGuards(FinancialQueryAccessGuard)
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('limit') rawLimit: unknown,
    @Query('cursor') cursor: unknown,
  ) {
    const id = queryId(walletId, 'walletId');
    const limit = ledgerLimit(rawLimit);
    const afterId = decodeLedgerCursor(cursor, id);
    const page = await requireQueryResult(() => this.queries.ledger(id, limit, afterId), 'Wallet not found.');
    return {
      items: page.items.map(ledgerEntryResponse),
      nextCursor: page.nextEntryId === undefined ? null : encodeLedgerCursor(id, page.nextEntryId),
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @UseGuards(FinancialQueryAccessGuard)
  async reconcile(@Param('walletId') walletId: string) {
    const id = queryId(walletId, 'walletId');
    return requireQueryResult(() => this.reconcileWallet.execute(id), 'Wallet not found.');
  }

  @Post()
  async open(@Body() body: unknown): Promise<{ id: string; playerId: string; balance: MoneyProps; version: number }> {
    const { playerId, initialBalance } = parseOpeningRequest(body);

    try {
      const wallet = await this.openWallet.execute(playerId, initialBalance);
      return walletResponse(wallet);
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) throw new ConflictException(error.message);
      if (error instanceof WalletOpeningUnavailableError) throw new ServiceUnavailableException(error.message);
      throw error;
    }
  }
}
