import { Quantity, QUANTITY_SCALE } from './quantity.js';
import { divRound, divRoundExact, InexactError, type RoundingMode } from './rounding.js';

/**
 * Unit-of-measure model (ARCHITECTURE §17).
 *
 * - A `uom` belongs to a `family`. Within a **physical** family
 *   (`LENGTH` / `MASS` / `VOLUME`) and within `COUNT`, conversion is derivable
 *   from each unit's exact ratio to the family base (`perBase`) — metre ⇄
 *   centimetre, gram ⇄ kilogram, carton ⇄ box ⇄ piece all resolve by going via
 *   the base, so an arbitrarily nested pack ladder works without a direct
 *   conversion for every pair.
 * - `COUNT` is **strictly discrete** — every `COUNT` unit has `maxDecimals: 0`
 *   (you cannot sell 1.5 gift boxes). Divisible individually-handled items
 *   (a foam block, a wrapping sheet, a ribbon roll) belong to the **`EACH`**
 *   family instead: `EACH` units are semantically unrelated to one another, so
 *   there is **no** generic `perBase` conversion between two distinct `EACH`
 *   units — the only way to convert one is an explicit item-specific
 *   `UomConversion`.
 * - Item-specific conversions (1 bunch Baby's Breath ≈ 10 stems) and pack
 *   conversions (this box = 10 pieces, not the generic 12) are passed in per
 *   registry as exact ratios and **override** the generic family math.
 *
 * All math is exact bigint math — no binary floating point.
 */

export type UomFamily = 'LENGTH' | 'MASS' | 'VOLUME' | 'COUNT' | 'EACH';

/** An exact positive ratio numerator/denominator. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export interface UomDef {
  readonly code: string;
  readonly family: UomFamily;
  /** exact amount of the family base unit in one of this unit. Ignored for
   *  `EACH` units (which have no generic conversion) — use `{ num: 1n, den: 1n }`. */
  readonly perBase: Ratio;
  /** max decimal places permitted for a quantity in this unit (0..4).
   *  Must be `0` for a `COUNT` unit. */
  readonly maxDecimals: number;
}

const r = (num: number | bigint, den: number | bigint = 1n): Ratio => ({
  num: BigInt(num),
  den: BigInt(den),
});

/** Built-in units. `perBase` is relative to the family base (metre, gram,
 *  millilitre, piece). No `EACH` units are built in — a tenant registers its
 *  own (foam block, wrapping sheet, gift box…). Codes are lowercase — the one
 *  canonical UOM-code convention (see `canonicalUomCode`). */
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
  // COUNT — base: piece (strictly discrete: no fractions)
  piece: { code: 'piece', family: 'COUNT', perBase: r(1), maxDecimals: 0 },
  stem: { code: 'stem', family: 'COUNT', perBase: r(1), maxDecimals: 0 },
  dozen: { code: 'dozen', family: 'COUNT', perBase: r(12), maxDecimals: 0 },
};

/**
 * The built-in unit definitions as a frozen array — the authoritative registry
 * a catalog layer lists / validates against without reconstructing anything
 * (Task 3.6 OD-6). Every `UomRegistry` seeds these internally; a tenant custom
 * `uom` row is only ever for a unit that is NOT one of these.
 */
export const BUILTIN_UOMS: readonly UomDef[] = Object.freeze(Object.values(BUILTIN));

/**
 * The one canonical persisted UOM-code shape (Task 3.6 MANDATORY CORRECTION 1):
 * lowercase, starts with a letter, then letters / digits / `.` / `-` / `_`,
 * 1–32 chars. **No `/`** — a UOM code is a REST path segment
 * (`GET /v1/catalog/uoms/:code`). Examples: `piece`, `box`, `bag-25kg`,
 * `bottle-100ml`, `roll.large`. Every built-in code matches.
 */
export const UOM_CODE_RE = /^[a-z][a-z0-9._-]{0,31}$/;

/**
 * Canonicalize a raw UOM code: trim, then lowercase (locale-independent — the
 * permitted `[a-z0-9._-]` set is unaffected by locale). Mirror of
 * `@flower/shared-types` `canonicalizeSku`. The caller then validates the
 * result against `UOM_CODE_RE`; built-in-shadow detection (`isBuiltinUom`)
 * happens AFTER this.
 */
export function canonicalUomCode(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether `code` (expected already canonical) is a `@flower/uom` built-in. */
export function isBuiltinUom(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN, code);
}

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

/** Two distinct `EACH` units with no explicit conversion between them — there is
 *  no generic ratio to fall back on (unlike a physical or COUNT family). */
export class UomConversionUnavailableError extends Error {
  constructor(from: string, to: string) {
    super(
      `No conversion from "${from}" to "${to}": EACH units have no generic ratio; ` +
        `register an explicit UomConversion`,
    );
    this.name = 'UomConversionUnavailableError';
  }
}

export class FractionalUnitError extends Error {
  constructor(code: string, value: string, maxDecimals: number) {
    super(`Unit "${code}" allows ${maxDecimals} decimal place(s); got ${value}`);
    this.name = 'FractionalUnitError';
  }
}

export class InvalidUomError extends Error {
  constructor(code: string, reason: string) {
    super(`Invalid unit of measure "${code}": ${reason}`);
    this.name = 'InvalidUomError';
  }
}

export class InvalidUomConversionError extends Error {
  constructor(from: string, to: string, reason: string) {
    super(`Invalid UOM conversion ${from} -> ${to}: ${reason}`);
    this.name = 'InvalidUomConversionError';
  }
}

/**
 * A `convertExact` result that is not exactly representable at scale 4 — the
 * `from → to` ratio applied to `qty` leaves a remainder, so a rounded answer
 * would be a silent lie. Task 3.6 surfaces this as a `422` and refuses to
 * create the pack identifier.
 */
export class InexactConversionError extends Error {
  constructor(from: string, to: string) {
    super(
      `Conversion ${from} -> ${to} is not exact for this quantity — a printed ` +
        `pack identity must be exactly representable; use a different pack qty / ratio`,
    );
    this.name = 'InexactConversionError';
  }
}

/**
 * A per-item / per-barcode conversion: `num` of `to` per `den` of `from`.
 * "1 carton = 12 pieces" -> { from: 'carton', to: 'piece', num: 12, den: 1 }.
 * Both `num` and `den` must be > 0, and both units must be registered.
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

export class UomRegistry {
  private readonly units: Map<string, UomDef>;
  private readonly conversions: readonly UomConversion[];

  constructor(opts: UomRegistryOptions = {}) {
    this.units = new Map(Object.entries(BUILTIN));
    for (const u of opts.units ?? []) {
      assertValidUomDef(u);
      this.units.set(u.code, u);
    }
    for (const c of opts.conversions ?? []) this.assertValidConversion(c);
    this.conversions = opts.conversions ?? [];
  }

  get(code: string): UomDef {
    const u = this.units.get(code);
    if (!u) throw new UnknownUomError(code);
    return u;
  }

  private assertValidConversion(c: UomConversion): void {
    const num = BigInt(c.num);
    const den = BigInt(c.den ?? 1n);
    if (num <= 0n) throw new InvalidUomConversionError(c.from, c.to, 'num must be > 0');
    if (den <= 0n) throw new InvalidUomConversionError(c.from, c.to, 'den must be > 0');
    if (!this.units.has(c.from)) {
      throw new InvalidUomConversionError(c.from, c.to, `unit "${c.from}" is not registered`);
    }
    if (!this.units.has(c.to)) {
      throw new InvalidUomConversionError(c.from, c.to, `unit "${c.to}" is not registered`);
    }
  }

  /** Throw if `qty` uses more decimal places than `unitCode` permits. */
  assertPermitted(qty: Quantity, unitCode: string): void {
    const unit = this.get(unitCode);
    if (qty.usedDecimals > unit.maxDecimals) {
      throw new FractionalUnitError(unit.code, qty.toString(), unit.maxDecimals);
    }
  }

  /**
   * Convert `qty` (expressed in `fromCode`) into `toCode`, rounding the scale-4
   * result with `mode` (default `HALF_UP`).
   *
   * Resolution order:
   *  1. an explicit conversion (either direction) from `opts.conversions`
   *     — item-specific ratios override generic family math;
   *  2. same-family ratio math via each unit's `perBase`
   *     (`LENGTH` / `MASS` / `VOLUME` / `COUNT` only).
   *
   * An `EACH` → different `EACH` conversion with no explicit rule throws
   * `UomConversionUnavailableError`; a cross-family conversion with no explicit
   * rule throws `UomFamilyMismatchError`.
   *
   * **Rounding contract:** the caller chooses `mode` per use case (a forward
   * pack conversion into base units is exact; a reverse conversion, e.g.
   * pieces → cartons, is lossy — an availability check would pass `'DOWN'` so
   * stock is never overstated). `convert` is a pure arithmetic primitive: it
   * applies no availability, reservation, or ledger behaviour, and it does
   * **not** re-validate the result against the target unit's decimal rule —
   * call `assertPermitted` where a whole number is required.
   */
  convert(
    qty: Quantity,
    fromCode: string,
    toCode: string,
    mode: RoundingMode = 'HALF_UP',
  ): Quantity {
    if (fromCode === toCode) return qty;

    for (const c of this.conversions) {
      const cn = BigInt(c.num);
      const cd = BigInt(c.den ?? 1n);
      if (c.from === fromCode && c.to === toCode) {
        return Quantity.ofScaled(divRound(qty.scaled * cn, cd, mode));
      }
      if (c.from === toCode && c.to === fromCode) {
        return Quantity.ofScaled(divRound(qty.scaled * cd, cn, mode));
      }
    }

    const from = this.get(fromCode);
    const to = this.get(toCode);
    if (from.family !== to.family) {
      throw new UomFamilyMismatchError(fromCode, toCode);
    }
    if (from.family === 'EACH') {
      throw new UomConversionUnavailableError(fromCode, toCode);
    }
    // qty * (from.perBase) / (to.perBase)
    const num = qty.scaled * from.perBase.num * to.perBase.den;
    const den = from.perBase.den * to.perBase.num;
    return Quantity.ofScaled(divRound(num, den, mode));
  }

  /**
   * `convert` with **no rounding** — the same resolution order (explicit
   * conversion either direction, then same-family `perBase` math), but the
   * scale-4 result must divide exactly or `InexactConversionError` is thrown.
   * Task 3.6 uses this for the printed pack-identity snapshot
   * (`item_identifier.packBaseQty`) so a barcode never silently denotes a
   * rounded base quantity. `UnknownUomError` / `UomFamilyMismatchError` /
   * `UomConversionUnavailableError` still apply for an unresolvable pair.
   */
  convertExact(qty: Quantity, fromCode: string, toCode: string): Quantity {
    if (fromCode === toCode) return qty;

    const exact = (n: bigint, d: bigint): Quantity => {
      try {
        return Quantity.ofScaled(divRoundExact(n, d));
      } catch (e) {
        if (e instanceof InexactError) throw new InexactConversionError(fromCode, toCode);
        throw e;
      }
    };

    for (const c of this.conversions) {
      const cn = BigInt(c.num);
      const cd = BigInt(c.den ?? 1n);
      if (c.from === fromCode && c.to === toCode) return exact(qty.scaled * cn, cd);
      if (c.from === toCode && c.to === fromCode) return exact(qty.scaled * cd, cn);
    }

    const from = this.get(fromCode);
    const to = this.get(toCode);
    if (from.family !== to.family) throw new UomFamilyMismatchError(fromCode, toCode);
    if (from.family === 'EACH') throw new UomConversionUnavailableError(fromCode, toCode);
    const num = qty.scaled * from.perBase.num * to.perBase.den;
    const den = from.perBase.den * to.perBase.num;
    return exact(num, den);
  }

  /**
   * Whether `from → to` is already resolvable by authoritative same-family
   * `perBase` semantics (built-in OR a registered tenant physical/COUNT unit) —
   * an EXPLICIT scoped `uom_conversion` for such a pair is redundant and Task
   * 3.6 rejects it (`UOM_CONVERSION_REDUNDANT`). Ignores `opts.conversions`.
   * `false` if either code is unknown, they are the same, or the pair is
   * cross-family / EACH (which legitimately needs an explicit rule).
   */
  isSameFamilyResolvable(fromCode: string, toCode: string): boolean {
    if (fromCode === toCode) return false;
    const from = this.units.get(fromCode);
    const to = this.units.get(toCode);
    if (!from || !to) return false;
    return from.family === to.family && from.family !== 'EACH';
  }
}

function assertValidUomDef(u: UomDef): void {
  if (u.perBase.num <= 0n || u.perBase.den <= 0n) {
    throw new InvalidUomError(u.code, 'perBase num and den must both be > 0');
  }
  if (!Number.isInteger(u.maxDecimals) || u.maxDecimals < 0 || u.maxDecimals > QUANTITY_SCALE) {
    throw new InvalidUomError(u.code, `maxDecimals must be an integer in [0, ${QUANTITY_SCALE}]`);
  }
  if (u.family === 'COUNT' && u.maxDecimals !== 0) {
    throw new InvalidUomError(u.code, 'a COUNT unit is discrete and must have maxDecimals: 0');
  }
}
