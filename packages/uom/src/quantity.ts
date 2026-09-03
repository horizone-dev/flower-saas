/**
 * A fractional-safe quantity. The DB stores quantities as NUMERIC(18,4) in the
 * item's base UOM (ARCHITECTURE §17, §52), so a Quantity is an integer number of
 * ten-thousandths (scale 4). No binary floating point.
 */

export const QUANTITY_SCALE = 4;
const SCALE_FACTOR = 10_000n; // 10 ** QUANTITY_SCALE

export class Quantity {
  /** value in ten-thousandths (scale 4). */
  private constructor(readonly scaled: bigint) {}

  static ofScaled(scaled: bigint | number): Quantity {
    return new Quantity(BigInt(scaled));
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
    return new Quantity(this.scaled * BigInt(factor));
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
}
