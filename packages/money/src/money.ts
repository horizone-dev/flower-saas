import { currencyExponent, getCurrency } from './currencies.js';
import { divRound, type RoundingMode } from './rounding.js';

/** Wire representation — JSON-safe (bigint serialised as a decimal string). */
export interface MoneyDTO {
  /** integer minor units, as a base-10 string (no decimal point) */
  readonly amountMinor: string;
  readonly currency: string;
  /** decimal places in the minor unit — carried so a consumer needs no currency table */
  readonly exponent: number;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * An amount of money as integer minor units + currency. Immutable. All arithmetic
 * is exact; only `mulRatio` / `percentage` / `allocate` round, and they say how.
 * No binary floating point is used anywhere (ADR-0006).
 */
export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: string,
  ) {}

  // --- construction ---

  static ofMinor(amountMinor: bigint | number | string, currency: string): Money {
    getCurrency(currency); // validate
    return new Money(BigInt(amountMinor), currency);
  }

  /** Parse a major-unit decimal string ("10.005") into minor units for `currency`. */
  static ofMajor(major: string, currency: string): Money {
    const exp = currencyExponent(currency);
    const trimmed = major.trim();
    const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!m) throw new RangeError(`Not a decimal amount: "${major}"`);
    const sign = m[1];
    const whole = m[2] ?? '0';
    const frac = m[3] ?? '';
    if (frac.length > exp) {
      throw new RangeError(`"${major}" has ${frac.length} decimals but ${currency} allows ${exp}`);
    }
    const scaled = (whole + frac.padEnd(exp, '0')).replace(/^0+(?=\d)/, '');
    const value = BigInt(scaled) * (sign ? -1n : 1n);
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.ofMinor(0n, currency);
  }

  static fromDTO(dto: MoneyDTO): Money {
    const expected = currencyExponent(dto.currency);
    if (dto.exponent !== expected) {
      throw new RangeError(`DTO exponent ${dto.exponent} != ${dto.currency} exponent ${expected}`);
    }
    return new Money(BigInt(dto.amountMinor), dto.currency);
  }

  // --- accessors ---

  get exponent(): number {
    return currencyExponent(this.currency);
  }

  get isZero(): boolean {
    return this.amountMinor === 0n;
  }

  get isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  toDTO(): MoneyDTO {
    return {
      amountMinor: this.amountMinor.toString(),
      currency: this.currency,
      exponent: this.exponent,
    };
  }

  /** Major-unit decimal string, e.g. "10.005" for KWD. For display/serialisation only. */
  toString(): string {
    const exp = this.exponent;
    const neg = this.amountMinor < 0n;
    const digits = (neg ? -this.amountMinor : this.amountMinor).toString().padStart(exp + 1, '0');
    const whole = digits.slice(0, digits.length - exp) || '0';
    const frac = exp > 0 ? '.' + digits.slice(digits.length - exp) : '';
    return `${neg ? '-' : ''}${whole}${frac} ${this.currency}`;
  }

  // --- exact arithmetic ---

  private assertSame(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  negate(): Money {
    return new Money(-this.amountMinor, this.currency);
  }

  /** Multiply by an integer count (exact). */
  mulInt(factor: bigint | number): Money {
    return new Money(this.amountMinor * BigInt(factor), this.currency);
  }

  // --- rounded arithmetic ---

  /** Multiply by the rational `numerator/denominator`, rounding the result. */
  mulRatio(
    numerator: bigint | number,
    denominator: bigint | number,
    mode: RoundingMode = 'HALF_UP',
  ): Money {
    const value = divRound(this.amountMinor * BigInt(numerator), BigInt(denominator), mode);
    return new Money(value, this.currency);
  }

  /** Take `bps` basis points (1/10000) of this amount, rounded. 500 bps = 5%. */
  percentage(bps: bigint | number, mode: RoundingMode = 'HALF_UP'): Money {
    return this.mulRatio(bps, 10_000n, mode);
  }

  /**
   * Split into `weights.length` parts that sum EXACTLY to this amount. The residual
   * from rounding is distributed one minor unit at a time to the parts with the
   * largest remainder, then by order (deterministic — ADR-0006 residual rule).
   */
  allocate(weights: readonly (bigint | number)[]): Money[] {
    if (weights.length === 0) throw new RangeError('allocate needs at least one weight');
    const w = weights.map((x) => BigInt(x));
    if (w.some((x) => x < 0n)) throw new RangeError('weights must be non-negative');
    const total = w.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError('weight total must be > 0');

    const base = w.map((wi) => (this.amountMinor * wi) / total);
    const remainders = w.map((wi, i) => ({
      i,
      rem: this.amountMinor * wi - base[i]! * total,
    }));
    let allocated = base.reduce((a, b) => a + b, 0n);
    let residual = this.amountMinor - allocated;

    // hand out the residual: +1 (or -1 if negative) to the largest remainders first
    const step = residual >= 0n ? 1n : -1n;
    remainders.sort((a, b) => {
      if (a.rem === b.rem) return a.i - b.i;
      return a.rem > b.rem ? -1 : 1;
    });
    const result = [...base];
    let k = 0;
    while (residual !== 0n) {
      const target = remainders[k % remainders.length]!.i;
      result[target] = result[target]! + step;
      residual -= step;
      k++;
    }
    allocated = result.reduce((a, b) => a + b, 0n);
    // invariant
    if (allocated !== this.amountMinor) {
      throw new Error('allocate invariant violated');
    }
    return result.map((v) => new Money(v, this.currency));
  }

  // --- comparison ---

  compare(other: Money): -1 | 0 | 1 {
    this.assertSame(other);
    if (this.amountMinor < other.amountMinor) return -1;
    if (this.amountMinor > other.amountMinor) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return other.currency === this.currency && other.amountMinor === this.amountMinor;
  }
}

export function sumMoney(items: readonly Money[], currency: string): Money {
  return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
}
