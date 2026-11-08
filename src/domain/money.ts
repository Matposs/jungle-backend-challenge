import { Decimal } from 'decimal.js';

// Two NUMERIC(20,2) values can produce a 21-digit result before the range check.
const MoneyDecimal = Decimal.clone({ precision: 21 });
const MAX_AMOUNT = new MoneyDecimal('999999999999999999.99');
const AMOUNT_PATTERN = /^-?[0-9]+\.[0-9]{2}$/;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export class Money {
  readonly #value: Decimal;

  private constructor(value: Decimal, public readonly currency: string) {
    if (!CURRENCIES.has(currency)) {
      throw new MoneyError('Currency must be a supported ISO 4217 code.');
    }
    if (value.abs().gt(MAX_AMOUNT)) {
      throw new MoneyError('Amount exceeds the NUMERIC(20,2) range.');
    }

    this.#value = value;
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    const value = Money.#parse(amount);
    if (value.isNegative()) {
      throw new MoneyError('Input amount must be non-negative.');
    }

    return new Money(value, currency);
  }

  static rehydrate({ amount, currency }: MoneyProps): Money {
    return new Money(Money.#parse(amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(new MoneyDecimal('0.00'), currency);
  }

  add(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#value.plus(other.#value), this.currency);
  }

  subtract(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#value.minus(other.#value), this.currency);
  }

  negate(): Money {
    return new Money(this.#value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.gt('0');
  }

  isNegative(): boolean {
    return this.#value.lt('0');
  }

  isLessThan(other: Money): boolean {
    this.#assertSameCurrency(other);
    return this.#value.lt(other.#value);
  }

  equals(other: Money): boolean {
    this.#assertSameCurrency(other);
    return this.#value.eq(other.#value);
  }

  toJSON(): MoneyProps {
    return { amount: this.#value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  static #parse(amount: string): Decimal {
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new MoneyError('Amount must be a decimal string with exactly two places.');
    }

    return new MoneyDecimal(amount);
  }

  #assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(`Currency mismatch: ${this.currency} and ${other.currency}.`);
    }
  }
}
