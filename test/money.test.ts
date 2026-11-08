import { describe, expect, test } from 'bun:test';
import { Money, MoneyError } from '../src/domain/money.js';

describe('Money', () => {
  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

  test('adds and subtracts cents exactly', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(brl('0.30').subtract(brl('0.10')).toString()).toBe('0.20 BRL');
    expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe('999999999999999999.99 BRL');
  });

  test('rejects input and arithmetic outside the NUMERIC(20,2) range', () => {
    const max = brl('999999999999999999.99');
    const cent = brl('0.01');

    expect(() => brl('1000000000000000000.00')).toThrow(MoneyError);
    expect(() => max.add(cent)).toThrow(MoneyError);
    expect(() => max.negate().subtract(cent)).toThrow(MoneyError);
  });

  test('supports signed results and rehydrates them exactly', () => {
    const positive = brl('0.20');
    const negative = brl('0.10').subtract(positive);
    const zero = Money.zero('BRL').negate();

    expect(positive.isPositive()).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(negative.isLessThan(zero)).toBe(true);
    expect(negative.equals(positive)).toBe(false);
    expect(negative.negate().equals(brl('0.10'))).toBe(true);
    expect(Money.rehydrate(negative.toJSON()).equals(negative)).toBe(true);
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(JSON.stringify(zero)).toBe('{"amount":"0.00","currency":"BRL"}');
  });

  test.each(['', 'NaN', 'Infinity', '1e2', '1', '1.0', '1.001', '-0.01', '-0.00', '+1.00', ' 1.00', '1.00\n'])(
    'rejects invalid input amount %j',
    (amount) => expect(() => brl(amount)).toThrow(MoneyError),
  );

  test('rejects a numeric input at runtime', () => {
    expect(() => brl(1 as unknown as string)).toThrow(MoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRL ', 'ZZZ'])('rejects invalid currency %j', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(MoneyError);
    expect(() => Money.zero(currency)).toThrow(MoneyError);
  });

  test('rejects arithmetic and comparisons across currencies', () => {
    const real = brl('1.00');
    const dollar = Money.from({ amount: '1.00', currency: 'USD' });

    expect(dollar.toString()).toBe('1.00 USD');
    expect(() => real.add(dollar)).toThrow(MoneyError);
    expect(() => real.subtract(dollar)).toThrow(MoneyError);
    expect(() => real.isLessThan(dollar)).toThrow(MoneyError);
    expect(() => real.equals(dollar)).toThrow(MoneyError);
  });

  test('returns new values and keeps operands immutable', () => {
    const original = brl('1.00');
    const other = brl('0.25');
    const json = original.toJSON();

    expect(original.add(other)).not.toBe(original);
    expect(original.subtract(other)).not.toBe(original);
    expect(original.negate()).not.toBe(original);
    expect(Reflect.set(original, 'currency', 'USD')).toBe(false);
    json.amount = '100.00';
    expect(original.toString()).toBe('1.00 BRL');
    expect(other.toString()).toBe('0.25 BRL');
  });
});
