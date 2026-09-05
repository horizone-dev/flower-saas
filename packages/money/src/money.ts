import { currencyExponent, getCurrency } from './currencies.js';
import { divRound, type RoundingMode } from './rounding.js';

/** Wire representation — JSON-safe (bigint serialised as a decimal string, never
 *  a JSON number: a `number` cannot safely hold the full minor-unit range and
 *  "no binary floating point for money" — ADR-0006 — rules it out on the wire
 *  too). See `API-CONVENTIONS.md`. */
export interface MoneyDTO {
  /** integer minor units, as a base-10 string (no decimal point) */
  readonly amountMinor: string;
  readonly currency: string;
  /** decimal places in the minor unit — carried so a consumer needs no currency table */
  readonly exponent: number;
}

/**
 * The storable range for a minor-unit amount: a signed 64-bit integer, matching
 * a PostgreSQL `BIGINT` column (`amount_minor bigint`, DB-CONVENTIONS). Every
 * `Money` — including an arithmetic result — is checked against this, so a value
 * that could not round-trip through the database can never be constructed.
 */
export const MONEY_MAX_MINOR = 2n ** 63n - 1n; // 9223372036854775807
export const MONEY_MIN_MINOR = -(2n ** 63n); // -9223372036854775808

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class MoneyOverflowError extends RangeError {
  constructor(amountMinor: bigint) {
    super(
      `Money amount ${amountMinor} is outside the storable BIGINT range ` +
        `[${MONEY_MIN_MINOR}, ${MONEY_MAX_MINOR}]`,
    );
    this.name = 'MoneyOverflowError';
  }
}

/**
 * Coerce a multiplier/weight to bigint, rejecting a `number` that has already
 * lost precision (`> 2^53`). The stored amount is only ever `bigint` or a
 * decimal string — this guard is for the small integer factors the arithmetic
 * helpers accept for ergonomics (`.mulInt(3)`, `.percentage(500)`).
 */
function toExactBigInt(value: bigint | number, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer (got ${value})`);
  }
  return BigInt(value);
}

/**
 * An amount of money as integer minor units + currency. Immutable. All arithmetic
 * is exact; only `mulRatio` / `percentage` / `allocate` round, and they say how.
 * No binary floating point is used anywhere (ADR-0006). Rounding defaults to
 * `HALF_UP` — a **generic** default; tax rounding policy (per-line vs
 * per-invoice, inclusive vs exclusive) is the caller's concern (the Phase 3
 * `tax` module), never hard-coded here.
 */
export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: string,
  ) {
    if (amountMinor < MONEY_MIN_MINOR || amountMinor > MONEY_MAX_MINOR) {
      throw new MoneyOverflowError(amountMinor);
    }
  }

  // --- construction ---

  /** Minor units as an exact `bigint` or a base-10 integer string. A `number`
   *  is deliberately not accepted — it cannot safely represent the range. */
  static ofMinor(amountMinor: bigint | string, currency: string): Money {
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

  get isPositive(): boolean {
    return this.amountMinor > 0n;
  }

  toDTO(): MoneyDTO {
    return {
      amountMinor: this.amountMinor.toString(),
      currency: this.currency,
      exponent: this.exponent,
    };
  }

  /** Major-unit decimal string, e.g. "10.005 KWD". **Display / logging only** —
   *  never parse this back; the wire form is `MoneyDTO`. */
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

  /** Absolute value. Returns `this` when already non-negative (immutable). */
  abs(): Money {
    return this.amountMinor < 0n ? new Money(-this.amountMinor, this.currency) : this;
  }

  /** The smaller of the two amounts (same currency). Returns one of the operands. */
  min(other: Money): Money {
    this.assertSame(other);
    return this.amountMinor <= other.amountMinor ? this : other;
  }

  /** The larger of the two amounts (same currency). Returns one of the operands. */
  max(other: Money): Money {
    this.assertSame(other);
    return this.amountMinor >= other.amountMinor ? this : other;
  }

  /** Multiply by an integer count (exact). */
  mulInt(factor: bigint | number): Money {
    return new Money(this.amountMinor * toExactBigInt(factor, 'factor'), this.currency);
  }

  /**
   * Integer division of the minor-unit amount by a **positive integer** divisor:
   * `{ quotient, remainder }` such that `quotient × divisor + remainder === this`
   * exactly. `remainder` carries the sign of `this`, `|remainder| < divisor`.
   *
   * Purely arithmetic — no rounding, no rate, no accumulation, and no costing or
   * valuation semantics (a *rounded* quotient is `mulRatio(1, divisor, mode)`).
   */
  divmod(divisor: bigint | number): { quotient: Money; remainder: Money } {
    const d = toExactBigInt(divisor, 'divisor');
    if (d <= 0n) throw new RangeError('divmod: divisor must be a positive integer');
    return {
      quotient: new Money(this.amountMinor / d, this.currency),
      remainder: new Money(this.amountMinor % d, this.currency),
    };
  }

  // --- rounded arithmetic ---

  /** Multiply by the rational `numerator/denominator`, rounding the result. */
  mulRatio(
    numerator: bigint | number,
    denominator: bigint | number,
    mode: RoundingMode = 'HALF_UP',
  ): Money {
    const value = divRound(
      this.amountMinor * toExactBigInt(numerator, 'numerator'),
      toExactBigInt(denominator, 'denominator'),
      mode,
    );
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
   *
   * `base` uses floor division (toward −∞), so every remainder is in `[0, total)`
   * and the residual to hand out is always ≥ 0 — the largest-remainder rule then
   * behaves identically for positive and negative amounts. (A prior version divided
   * toward zero and mis-placed the residual on negative amounts with unequal
   * weights — ultra-review F2.)
   *
   * A zero weight always yields a zero part; the residual only ever lands on a
   * part whose weighted share had a non-zero fractional remainder.
   */
  allocate(weights: readonly (bigint | number)[]): Money[] {
    if (weights.length === 0) throw new RangeError('allocate needs at least one weight');
    const w = weights.map((x) => toExactBigInt(x, 'weight'));
    if (w.some((x) => x < 0n)) throw new RangeError('weights must be non-negative');
    const total = w.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError('weight total must be > 0');

    // floor division: total is always > 0, so `q - 1` when the truncated remainder
    // is negative gives the floor.
    const floorDiv = (numerator: bigint): bigint => {
      const q = numerator / total;
      return numerator % total < 0n ? q - 1n : q;
    };

    const numer = w.map((wi) => this.amountMinor * wi);
    const base = numer.map(floorDiv);
    const remainders = numer.map((n, i) => ({ i, rem: n - base[i]! * total })); // each in [0, total)
    let residual = this.amountMinor - base.reduce((a, b) => a + b, 0n); // always >= 0

    // hand out the residual: +1 minor unit to the largest remainders first, ties by order
    remainders.sort((a, b) => {
      if (a.rem === b.rem) return a.i - b.i;
      return a.rem > b.rem ? -1 : 1;
    });
    const result = [...base];
    let k = 0;
    while (residual > 0n) {
      const target = remainders[k % remainders.length]!.i;
      result[target] = result[target]! + 1n;
      residual -= 1n;
      k++;
    }

    // invariant: the parts sum back to the original amount, exactly
    if (result.reduce((a, b) => a + b, 0n) !== this.amountMinor) {
      throw new Error('allocate invariant violated');
    }
    return result.map((v) => new Money(v, this.currency));
  }

  /**
   * Deterministic cap-based distribution: walk `caps` in the given order, giving
   * each entry `min(remaining, cap)`, and return the per-cap allocations plus
   * whatever is left over. A **pure primitive** for FIFO-style allocation (one
   * received amount across a list of already-ordered, already-eligible targets —
   * e.g. one customer payment across their open invoices oldest-first).
   *
   * It applies **no ordering, eligibility, or business rule of its own** — the
   * domain decides which targets are eligible and in what order before calling
   * this. The leftover is returned explicitly, never silently absorbed
   * (ADR-0019 §11 — an unallocated remainder is always surfaced).
   *
   * `this` and every cap must be the same currency and non-negative.
   * Invariant: `Σ allocations + remainder === this` and
   * `0 ≤ allocations[i] ≤ caps[i]` for every `i`. Empty `caps` → `remainder === this`.
   */
  capAllocate(caps: readonly Money[]): { allocations: Money[]; remainder: Money } {
    if (this.amountMinor < 0n) {
      throw new RangeError('capAllocate: the amount to distribute must be non-negative');
    }
    let remaining = this.amountMinor;
    const allocations = caps.map((cap) => {
      this.assertSame(cap);
      if (cap.amountMinor < 0n) throw new RangeError('capAllocate: every cap must be non-negative');
      const take = remaining < cap.amountMinor ? remaining : cap.amountMinor;
      remaining -= take;
      return new Money(take, this.currency);
    });
    return { allocations, remainder: new Money(remaining, this.currency) };
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
