import { describe, expect, test } from 'bun:test';
import { Money, MoneyError } from '../src/domain/money.js';
import { InsufficientFundsError, Wallet, WalletError } from '../src/domain/wallet.js';

describe('Wallet', () => {
  const id = 'wallet-1';
  const playerId = 'player-1';
  const openedAt = new Date('2026-01-01T00:00:00.000Z');
  const movedAt = new Date('2026-01-02T00:00:00.000Z');
  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
  const open = (amount: string) => Wallet.open({ id, playerId, initialBalance: brl(amount) }, openedAt);

  test.each(['0.00', '100.00'])('opens with balance %s and version 1', (amount) => {
    const wallet = open(amount);

    expect(wallet.id).toBe(id);
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(brl(amount))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('rejects a negative opening balance', () => {
    expect(() => Wallet.open({ id, playerId, initialBalance: brl('0.01').negate() }, openedAt)).toThrow(WalletError);
  });

  test('credits and debits exactly, returning the balances for each change', () => {
    const wallet = open('10.00');
    const credit = wallet.credit(brl('0.30'), movedAt);

    expect(credit?.balanceBefore.toString()).toBe('10.00 BRL');
    expect(credit?.balanceAfter.toString()).toBe('10.30 BRL');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(movedAt);

    const debitedAt = new Date('2026-01-03T00:00:00.000Z');
    const debit = wallet.debit(brl('10.30'), debitedAt);

    expect(debit?.balanceBefore.toString()).toBe('10.30 BRL');
    expect(debit?.balanceAfter.isZero()).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(debitedAt);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(credit?.balanceAfter.toString()).toBe('10.30 BRL');
  });

  test('rejects an overdraft without mutating the wallet', () => {
    const wallet = open('20.00');

    expect(() => wallet.debit(brl('20.01'), movedAt)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00 BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('rejects negative amounts and currency mismatches before changing state', () => {
    const wallet = open('20.00');
    const negative = brl('0.01').negate();
    const usd = Money.zero('USD');

    expect(() => wallet.credit(negative, movedAt)).toThrow(WalletError);
    expect(() => wallet.debit(negative, movedAt)).toThrow(WalletError);
    expect(() => wallet.credit(usd, movedAt)).toThrow(MoneyError);
    expect(() => wallet.debit(usd, movedAt)).toThrow(MoneyError);
    expect(wallet.balance.toString()).toBe('20.00 BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('treats zero movements as no-ops', () => {
    const wallet = open('20.00');
    const zero = Money.zero('BRL');

    expect(wallet.credit(zero, movedAt)).toBeUndefined();
    expect(wallet.debit(zero, movedAt)).toBeUndefined();
    expect(wallet.balance.toString()).toBe('20.00 BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('rehydrates persisted state and continues from its version', () => {
    const balance = Money.rehydrate({ amount: '15.25', currency: 'USD' });
    const wallet = Wallet.rehydrate({ id, playerId, balance, version: 7, createdAt: openedAt, updatedAt: movedAt });

    expect(wallet.id).toBe(id);
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance.equals(balance)).toBe(true);
    expect(wallet.currency).toBe('USD');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(movedAt);

    wallet.debit(Money.from({ amount: '0.25', currency: 'USD' }));
    expect(wallet.balance.toString()).toBe('15.00 USD');
    expect(wallet.version).toBe(8);
  });

  test('does not expose mutable date references', () => {
    const at = new Date(openedAt);
    const wallet = Wallet.open({ id, playerId, initialBalance: brl('10.00') }, at);
    at.setTime(0);
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);

    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });
});
