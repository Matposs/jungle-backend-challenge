import type { Money } from './money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class LedgerEntryError extends Error {
  override readonly name = 'LedgerEntryError';
}

export class WalletLedgerEntry implements LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly #createdAt: number;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.#createdAt = state.createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new LedgerEntryError('Ledger entry must describe a valid wallet balance change.');
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  isBalanced(): boolean {
    const { money, balanceBefore, balanceAfter, direction } = this;
    if (!money.isPositive() || balanceBefore.isNegative() || balanceAfter.isNegative()) {
      return false;
    }
    if (balanceBefore.currency !== money.currency || balanceAfter.currency !== money.currency) {
      return false;
    }

    // The difference of two non-negative balances fits the range of Money.
    const change = balanceAfter.subtract(balanceBefore);
    switch (direction) {
      case LedgerDirection.Credit:
        return change.equals(money);
      case LedgerDirection.Debit:
        return change.equals(money.negate());
      default:
        return false;
    }
  }
}
