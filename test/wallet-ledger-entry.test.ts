import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money.js';
import { Wallet } from '../src/domain/wallet.js';
import { LedgerDirection, LedgerEntryError, WalletLedgerEntry } from '../src/domain/wallet-ledger-entry.js';

describe('WalletLedgerEntry', () => {
  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
  const credit = {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Credit,
    money: brl('0.20'),
    balanceBefore: brl('0.10'),
    balanceAfter: brl('0.30'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  test('creates an exact credit', () => {
    const entry = WalletLedgerEntry.create(credit);

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.toString()).toBe('0.30 BRL');
  });

  test('creates a debit from a wallet change down to zero', () => {
    const wallet = Wallet.open({ id: credit.walletId, playerId: 'player-1', initialBalance: brl('0.30') });
    const money = brl('0.30');
    const change = wallet.debit(money);
    if (!change) throw new Error('Expected a wallet balance change.');

    const entry = WalletLedgerEntry.create({ ...credit, ...change, direction: LedgerDirection.Debit, money });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test('rejects the wrong direction or a one-cent discrepancy', () => {
    expect(() => WalletLedgerEntry.create({ ...credit, direction: LedgerDirection.Debit })).toThrow(LedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...credit, balanceAfter: brl('0.31') })).toThrow(LedgerEntryError);
  });

  test('rejects currency mismatches in the amount and balances', () => {
    for (const field of ['money', 'balanceBefore', 'balanceAfter'] as const) {
      const value = Money.from({ ...credit[field].toJSON(), currency: 'USD' });
      expect(() => WalletLedgerEntry.create({ ...credit, [field]: value })).toThrow(LedgerEntryError);
    }
  });

  test('rejects zero and negative movements even when the arithmetic matches', () => {
    expect(() => WalletLedgerEntry.create({ ...credit, money: brl('0.00'), balanceAfter: credit.balanceBefore }))
      .toThrow(LedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...credit, money: brl('0.01').negate(), balanceAfter: brl('0.09') }))
      .toThrow(LedgerEntryError);
  });

  test('rejects negative balances and credits outside the Money range', () => {
    expect(() => WalletLedgerEntry.create({
      ...credit, direction: LedgerDirection.Debit, balanceAfter: brl('0.10').negate(),
    })).toThrow(LedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...credit, balanceBefore: brl('0.10').negate(), balanceAfter: brl('0.10') }))
      .toThrow(LedgerEntryError);
    const max = brl('999999999999999999.99');
    expect(() => WalletLedgerEntry.create({ ...credit, balanceBefore: max, balanceAfter: max })).toThrow(LedgerEntryError);
  });

  test('rehydrates stored state for inspection without replaying creation rules', () => {
    const state = { ...credit, balanceAfter: brl('0.31') };
    const entry = WalletLedgerEntry.rehydrate(state);

    expect(entry.id).toBe(state.id);
    expect(entry.walletId).toBe(state.walletId);
    expect(entry.transactionId).toBe(state.transactionId);
    expect(entry.direction).toBe(state.direction);
    expect(entry.balanceBefore).toBe(state.balanceBefore);
    expect(entry.balanceAfter).toBe(state.balanceAfter);
    expect(entry.money).toBe(state.money);
    expect(entry.createdAt).toEqual(state.createdAt);
    expect(entry.isBalanced()).toBe(false);
  });

  test('freezes fields and does not expose a mutable timestamp', () => {
    const createdAt = new Date(credit.createdAt);
    const entry = WalletLedgerEntry.create({ ...credit, createdAt });

    createdAt.setTime(0);
    entry.createdAt.setTime(0);

    expect(Reflect.set(entry, 'balanceAfter', brl('0.99'))).toBe(false);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('0.30 BRL');
    expect(entry.createdAt).toEqual(credit.createdAt);
  });
});
