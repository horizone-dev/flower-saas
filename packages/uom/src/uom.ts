import { Quantity } from './quantity.js';

/**
 * Unit-of-measure model (ARCHITECTURE §17).
 *
 * - A `uom` belongs to a `family`. Within a family, conversion factors are global
 *   (meter <-> centimetre) and expressed as exact integer ratios to the family base.
 * - Item-specific conversions (1 bunch Baby's Breath ~= 10 stems) and pack
 *   conversions (1 carton = 12 pieces) are passed in per call as exact ratios.
 * - Each uom declares `maxDecimals`: you cannot sell 1.5 gift boxes, but you can
 *   sell 1.5 m of ribbon or 0.25 of a foam block.
 *
 * All math is exact bigint math — no binary floating point.
 */

export type UomFamily = 'LENGTH' | 'MASS' | 'VOLUME' | 'COUNT' | 'AREA';

/** An exact non-negative ratio numerator/denominator. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export interface UomDef {
  readonly code: string;
  readonly family: UomFamily;
  /** exact amount of the family base unit in one of this unit */
  readonly perBase: Ratio;
  /** max decimal places permitted for a quantity in this unit (0..4) */
  readonly maxDecimals: number;
}

const r = (num: number | bigint, den: number | bigint = 1n): Ratio => ({
  num: BigInt(num),
  den: BigInt(den),
});

/** Built-in units. `perBase` is relative to the family base (metre, gram, millilitre, piece). */
const BUILTIN: Record<string, UomDef> = {
  // LENGTH — base: metre
  meter: { code: 'meter', family: 'LENGTH', perBase: r(1), maxDecimals: 4 },
  centimeter: { code: 'centimeter', family: 'LENGTH', perBase: r(1, 100), maxDecimals: 4 },
  millimeter: { code: 'millimeter', family: 'LENGTH', perBase: r(1, 1000), maxDecimals: 4 },
  // MASS — base: gram
  gram: { code: 'gram', family: 'MASS', perBase: r(1), maxDecimals: 4 },
  kilogram: { code: 'kilogram', family: 'MASS', perBase: r(1000), maxDecimals: 4 },
  // VOLUME — base: millilitre
  milliliter: { code: 'milliliter', family: 'VOLUME', perBase: r(1), maxDecimals: 4 },
  liter: { code: 'liter', family: 'VOLUME', perBase: r(1000), maxDecimals: 4 },
  // COUNT — base: piece (discrete: no fractions)
  piece: { code: 'piece', family: 'COUNT', perBase: r(1), maxDecimals: 0 },
  stem: { code: 'stem', family: 'COUNT', perBase: r(1), maxDecimals: 0 },
  dozen: { code: 'dozen', family: 'COUNT', perBase: r(12), maxDecimals: 0 },
  // continuous COUNT-like units that DO allow fractions
  block: { code: 'block', family: 'COUNT', perBase: r(1), maxDecimals: 2 },
  sheet: { code: 'sheet', family: 'COUNT', perBase: r(1), maxDecimals: 2 },
  roll: { code: 'roll', family: 'COUNT', perBase: r(1), maxDecimals: 2 },
};

export class UnknownUomError extends Error {
  constructor(code: string) {
    super(`Unknown unit of measure: ${code}`);
    this.name = 'UnknownUomError';
  }
}

export class UomFamilyMismatchError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot convert across families: ${from} -> ${to}`);
    this.name = 'UomFamilyMismatchError';
  }
}

export class FractionalUnitError extends Error {
  constructor(code: string, value: string, maxDecimals: number) {
    super(`Unit "${code}" allows ${maxDecimals} decimal place(s); got ${value}`);
    this.name = 'FractionalUnitError';
  }
}

/**
 * A per-item / per-barcode conversion: `num` of `to` per `den` of `from`.
 * "1 carton = 12 pieces" -> { from: 'carton', to: 'piece', num: 12, den: 1 }.
 */
export interface UomConversion {
  readonly from: string;
  readonly to: string;
  readonly num: number | bigint;
  readonly den?: number | bigint;
}

export interface UomRegistryOptions {
  readonly units?: readonly UomDef[];
  readonly conversions?: readonly UomConversion[];
}

/** Divide `n / d` (d > 0) rounding half-up, sign-aware. */
function divHalfUp(n: bigint, d: bigint): bigint {
  if (d < 0n) return divHalfUp(-n, -d);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = a / d;
  const rem = a % d;
  const rounded = rem * 2n >= d ? q + 1n : q;
  return neg ? -rounded : rounded;
}

export class UomRegistry {
  private readonly units: Map<string, UomDef>;
  private readonly conversions: readonly UomConversion[];

  constructor(opts: UomRegistryOptions = {}) {
    this.units = new Map(Object.entries(BUILTIN));
    for (const u of opts.units ?? []) this.units.set(u.code, u);
    this.conversions = opts.conversions ?? [];
  }

  get(code: string): UomDef {
    const u = this.units.get(code);
    if (!u) throw new UnknownUomError(code);
    return u;
  }

  /** Throw if `qty` uses more decimal places than `unitCode` permits. */
  assertPermitted(qty: Quantity, unitCode: string): void {
    const unit = this.get(unitCode);
    if (qty.usedDecimals > unit.maxDecimals) {
      throw new FractionalUnitError(unit.code, qty.toString(), unit.maxDecimals);
    }
  }

  /**
   * Convert `qty` (expressed in `fromCode`) into `toCode`.
   *
   * Resolution order:
   *  1. an explicit conversion (either direction) from `opts.conversions`
   *  2. same-family ratio math via each unit's `perBase`
   *
   * The result is a Quantity (scale 4), half-up rounded. It is NOT re-validated
   * against the target unit's decimal rule — call `assertPermitted` where a whole
   * number is required (e.g. a point-of-sale line).
   */
  convert(qty: Quantity, fromCode: string, toCode: string): Quantity {
    if (fromCode === toCode) return qty;

    for (const c of this.conversions) {
      const cn = BigInt(c.num);
      const cd = BigInt(c.den ?? 1n);
      if (c.from === fromCode && c.to === toCode) {
        return Quantity.ofScaled(divHalfUp(qty.scaled * cn, cd));
      }
      if (c.from === toCode && c.to === fromCode) {
        return Quantity.ofScaled(divHalfUp(qty.scaled * cd, cn));
      }
    }

    const from = this.get(fromCode);
    const to = this.get(toCode);
    if (from.family !== to.family) {
      throw new UomFamilyMismatchError(fromCode, toCode);
    }
    // qty * (from.perBase) / (to.perBase)
    const num = qty.scaled * from.perBase.num * to.perBase.den;
    const den = from.perBase.den * to.perBase.num;
    return Quantity.ofScaled(divHalfUp(num, den));
  }
}
