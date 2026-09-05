import { divRound, type RoundingMode } from './rounding.js';

/**
 * A fractional-safe quantity. The DB stores quantities as NUMERIC(18,4) in the
 * item's base UOM (ARCHITECTURE §17, §52), so a Quantity is an integer number of
 * ten-thousandths (scale 4). No binary floating point.
 *
 * A `Quantity` is deliberately **unit-neutral** — it is a magnitude in *some*
 * base UOM; the UOM code travels alongside it in the domain (on the movement
 * ledger row, the order line, etc.), never inside the value object.
 */

export const QUANTITY_SCALE = 4;
const SCALE_FACTOR = 10_000n; // 10 ** QUANTITY_SCALE

/**
 * The storable range for a scaled quantity: `NUMERIC(18,4)` holds 18 significant
 * digits, so with 4 fractional places the integer part is at most 14 digits.
 * The scaled (×10^4) value therefore fits in ±(10^18 − 1). Every `Quantity`,
 * including a conversion or `scaleBy` result, is checked against this so a value
 * that could not round-trip through the database can never be constructed.
 */
export const QUANTITY_MAX_SCALED = 10n ** 18n - 1n;
export const QUANTITY_MIN_SCALED = -(10n ** 18n - 1n);

export class QuantityOverflowError extends RangeError {
  constructor(scaled: bigint) {
    super(
      `Quantity ${scaled} (scaled) is outside the storable NUMERIC(18,4) range ` +
        `[${QUANTITY_MIN_SCALED}, ${QUANTITY_MAX_SCALED}]`,
    );
    this.name = 'QuantityOverflowError';
  }
}

function toExactBigInt(value: bigint | number, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer (got ${value})`);
  }
  return BigInt(value);
}

/** Wire representation — a decimal string, never a JSON number (avoid float in
 *  JSON; API-CONVENTIONS). Unit-neutral, like `Quantity` itself. */
export interface QuantityDTO {
  /** the magnitude as a decimal string with at most 4 fractional places */
  readonly amount: string;
}

export class Quantity {
  /** value in ten-thousandths (scale 4). */
  private constructor(readonly scaled: bigint) {
    if (scaled < QUANTITY_MIN_SCALED || scaled > QUANTITY_MAX_SCALED) {
      throw new QuantityOverflowError(scaled);
    }
  }

  /** Scale-4 integer value, as an exact `bigint`. A `number` is not accepted —
   *  it cannot safely represent the range. */
  static ofScaled(scaled: bigint): Quantity {
    return new Quantity(scaled);
  }

  /** Parse a decimal string ("1.5", "0.25", "12") with at most 4 decimal places. */
  static parse(input: string): Quantity {
    const s = input.trim();
    const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new RangeError(`Not a quantity: "${input}"`);
    const neg = m[1] === '-';
    const whole = m[2] ?? '0';
    const frac = m[3] ?? '';
    if (frac.length > QUANTITY_SCALE) {
      throw new RangeError(`"${input}" has more than ${QUANTITY_SCALE} decimal places`);
    }
    const digits = whole + frac.padEnd(QUANTITY_SCALE, '0');
    const value = BigInt(digits) * (neg ? -1n : 1n);
    return new Quantity(value);
  }

  static zero(): Quantity {
    return new Quantity(0n);
  }

  static fromDTO(dto: QuantityDTO): Quantity {
    return Quantity.parse(dto.amount);
  }

  get isZero(): boolean {
    return this.scaled === 0n;
  }

  get isNegative(): boolean {
    return this.scaled < 0n;
  }

  /** Number of decimal places actually used (0..4). */
  get usedDecimals(): number {
    let n = Math.abs(Number(this.scaled % SCALE_FACTOR));
    if (n === 0) return 0;
    let d = QUANTITY_SCALE;
    while (n % 10 === 0) {
      n /= 10;
      d--;
    }
    return d;
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.scaled + other.scaled);
  }

  subtract(other: Quantity): Quantity {
    return new Quantity(this.scaled - other.scaled);
  }

  mulInt(factor: bigint | number): Quantity {
    return new Quantity(this.scaled * toExactBigInt(factor, 'factor'));
  }

  /**
   * Multiply by the rational `num / den` (den > 0), rounding the scale-4 result
   * with `mode` (default `HALF_UP`). A generic exact primitive — the ratio is
   * whatever the caller supplies (a recipe batch multiplier, a wastage factor…);
   * this method attaches no domain meaning to it and does no availability or
   * reservation logic.
   */
  scaleBy(
    num: bigint | number,
    den: bigint | number = 1n,
    mode: RoundingMode = 'HALF_UP',
  ): Quantity {
    const d = toExactBigInt(den, 'den');
    if (d <= 0n) throw new RangeError('scaleBy: denominator must be > 0');
    return new Quantity(divRound(this.scaled * toExactBigInt(num, 'num'), d, mode));
  }

  compare(other: Quantity): -1 | 0 | 1 {
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: Quantity): boolean {
    return this.scaled === other.scaled;
  }

  toString(): string {
    const neg = this.scaled < 0n;
    const digits = (neg ? -this.scaled : this.scaled).toString().padStart(QUANTITY_SCALE + 1, '0');
    const whole = digits.slice(0, digits.length - QUANTITY_SCALE);
    const frac = digits.slice(digits.length - QUANTITY_SCALE).replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
  }

  /** For NUMERIC(18,4) columns / DTOs — always exactly 4 decimal places. */
  toFixed4(): string {
    const neg = this.scaled < 0n;
    const digits = (neg ? -this.scaled : this.scaled).toString().padStart(QUANTITY_SCALE + 1, '0');
    const whole = digits.slice(0, digits.length - QUANTITY_SCALE);
    const frac = digits.slice(digits.length - QUANTITY_SCALE);
    return `${neg ? '-' : ''}${whole}.${frac}`;
  }

  toDTO(): QuantityDTO {
    return { amount: this.toFixed4() };
  }
}
