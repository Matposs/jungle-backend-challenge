import { BadRequestException, Body, ConflictException, Controller, Inject, Post } from '@nestjs/common';
import { OpenWallet, WalletAlreadyExistsError } from '../../application/open-wallet.js';
import { Money, MoneyError, type MoneyProps } from '../../domain/money.js';

function parseOpeningRequest(body: unknown): { playerId: string; initialBalance: Money } {
  if (body === null || typeof body !== 'object' || !('playerId' in body) ||
      typeof body.playerId !== 'string' || !body.playerId.trim() || body.playerId.includes('\0')) {
    throw new BadRequestException('playerId must be a non-blank string without NUL characters.');
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
  constructor(@Inject(OpenWallet) private readonly openWallet: OpenWallet) {}

  @Post()
  async open(@Body() body: unknown): Promise<{ id: string; playerId: string; balance: MoneyProps; version: number }> {
    const { playerId, initialBalance } = parseOpeningRequest(body);

    try {
      const wallet = await this.openWallet.execute(playerId, initialBalance);
      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) throw new ConflictException(error.message);
      throw error;
    }
  }
}
