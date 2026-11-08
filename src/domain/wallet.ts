import type { Money } from './money.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletBalanceChange {
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

export class WalletError extends Error {
  override readonly name: string = 'WalletError';
}

export class InsufficientFundsError extends WalletError {
  override readonly name = 'InsufficientFundsError';

  constructor() {
    super('Insufficient wallet balance.');
  }
}

export class Wallet {
  readonly #createdAt: Date;
  #balance: Money;
  #version: number;
  #updatedAt: Date;

  private constructor(state: WalletState) {
    if (state.balance.isNegative()) {
      throw new WalletError('Wallet balance must be non-negative.');
    }

    this.id = state.id;
    this.playerId = state.playerId;
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = new Date(state.createdAt);
    this.#updatedAt = new Date(state.updatedAt);
  }

  readonly id: string;
  readonly playerId: string;

  static open({ id, playerId, initialBalance }: OpenWalletProps, at = new Date()): Wallet {
    return new Wallet({ id, playerId, balance: initialBalance, version: 1, createdAt: at, updatedAt: at });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get currency(): string {
    return this.#balance.currency;
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }

  credit(amount: Money, at = new Date()): WalletBalanceChange | undefined {
    this.#assertNonNegativeAmount(amount);
    return this.#changeBalance(this.#balance.add(amount), at);
  }

  debit(amount: Money, at = new Date()): WalletBalanceChange | undefined {
    this.#assertNonNegativeAmount(amount);
    const balanceAfter = this.#balance.subtract(amount);
    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError();
    }

    return this.#changeBalance(balanceAfter, at);
  }

  #changeBalance(balanceAfter: Money, at: Date): WalletBalanceChange | undefined {
    const balanceBefore = this.#balance;
    if (balanceAfter.equals(balanceBefore)) {
      return undefined;
    }

    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = new Date(at);
    return { balanceBefore, balanceAfter };
  }

  #assertNonNegativeAmount(amount: Money): void {
    if (amount.isNegative()) {
      throw new WalletError('Movement amount must be non-negative.');
    }
  }
}
