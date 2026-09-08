import {
  BUILTIN_UOMS,
  canonicalUomCode,
  isBuiltinUom,
  UOM_CODE_RE,
  UomRegistry,
  UnknownUomError,
  UomFamilyMismatchError,
  UomConversionUnavailableError,
  FractionalUnitError,
  InvalidUomError,
  InvalidUomConversionError,
  InexactConversionError,
  type UomConversion,
  type UomDef,
} from '@flower/uom';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3.6 pure UOM helpers. NO business logic beyond arithmetic delegation to
 * `@flower/uom` (HG3-UOM — no conversion arithmetic re-implemented here). All
 * quantity math flows through `@flower/uom`; `apps/api` never divides ratios.
 */

export interface TenantUomRow {
  code: string;
  family: string;
  perBaseNum: bigint;
  perBaseDen: bigint;
  maxDecimals: number;
}

export interface ConversionRow {
  fromUomCode: string;
  toUomCode: string;
  num: bigint;
  den: bigint;
}

/** Canonicalize + validate a raw UOM code against the ONE persisted shape (MC-1).
 *  Throws `UOM_INVALID_CODE` (422) — never a raw `::text` cast error. */
export function requireUomCode(raw: string): string {
  const code = canonicalUomCode(raw);
  if (!UOM_CODE_RE.test(code)) {
    throw new DomainError(
      'UOM_INVALID_CODE',
      'a UOM code must be lowercase, start with a letter, and use only a-z 0-9 . - _ (1–32 chars, no "/")',
      422,
      [{ field: 'code', issue: 'invalid UOM code' }],
    );
  }
  return code;
}

/** A tenant `uom` row → the `@flower/uom` `UomDef` shape. */
export function toUomDef(row: TenantUomRow): UomDef {
  return {
    code: row.code,
    family: row.family as UomDef['family'],
    perBase: { num: row.perBaseNum, den: row.perBaseDen },
    maxDecimals: row.maxDecimals,
  };
}

/** A `uom_conversion` row → the `@flower/uom` `UomConversion` shape. */
export function toUomConversion(row: ConversionRow): UomConversion {
  return { from: row.fromUomCode, to: row.toUomCode, num: row.num, den: row.den };
}

/**
 * Build a `UomRegistry` from tenant units + an effective (deduplicated,
 * non-contradictory) conversion set. The constructor eagerly validates
 * (num/den > 0, referenced units registered, COUNT discrete, EACH perBase 1/1);
 * a failure is surfaced as a `422` by `mapUomError`.
 */
export function buildRegistry(
  units: readonly UomDef[],
  conversions: readonly UomConversion[],
): UomRegistry {
  try {
    return new UomRegistry({ units, conversions });
  } catch (e) {
    throw mapUomError(e);
  }
}

/**
 * The effective resolution set for a variant with base `baseCode` (Task 3.6 §F):
 *   - every VARIANT-scoped row for the variant (all anchored to base), THEN
 *   - PRODUCT-scoped rows for the parent product whose `toUomCode == baseCode`
 *     and whose `fromUomCode` is not already covered by a VARIANT row.
 * Precedence (VARIANT overrides PRODUCT) is resolved HERE — the `UomRegistry`
 * never receives two rows for the same `fromUom`.
 */
export function effectiveConversions(
  variantRows: readonly ConversionRow[],
  productRows: readonly ConversionRow[],
  baseCode: string,
): UomConversion[] {
  const covered = new Set(variantRows.map((r) => r.fromUomCode));
  const out: UomConversion[] = variantRows.map(toUomConversion);
  for (const r of productRows) {
    if (r.toUomCode === baseCode && !covered.has(r.fromUomCode)) out.push(toUomConversion(r));
  }
  return out;
}

/** The full unit list a `GET /catalog/uoms` response exposes — built-ins
 *  (read-only) + this tenant's custom rows. */
export function mergeUomList(
  tenant: readonly (TenantUomRow & {
    id: string;
    nameEn: string;
    nameAr: string | null;
    version: number;
  })[],
): Array<{
  code: string;
  family: string;
  perBaseNum: string;
  perBaseDen: string;
  maxDecimals: number;
  nameEn: string;
  nameAr: string | null;
  builtin: boolean;
  version: number | null;
}> {
  const builtins = BUILTIN_UOMS.map((u) => ({
    code: u.code,
    family: u.family,
    perBaseNum: u.perBase.num.toString(),
    perBaseDen: u.perBase.den.toString(),
    maxDecimals: u.maxDecimals,
    nameEn: u.code,
    nameAr: null,
    builtin: true,
    version: null,
  }));
  const custom = tenant.map((u) => ({
    code: u.code,
    family: u.family,
    perBaseNum: u.perBaseNum.toString(),
    perBaseDen: u.perBaseDen.toString(),
    maxDecimals: u.maxDecimals,
    nameEn: u.nameEn,
    nameAr: u.nameAr,
    builtin: false,
    version: u.version,
  }));
  return [...builtins, ...custom].sort((a, b) => a.code.localeCompare(b.code));
}

export { isBuiltinUom, canonicalUomCode };

/**
 * Translate a `@flower/uom` error into a deterministic `DomainError`. Never lets
 * a raw arithmetic/validation error escape as a 500.
 */
export function mapUomError(e: unknown): DomainError {
  if (e instanceof DomainError) return e;
  if (e instanceof InvalidUomError) {
    return new DomainError('UOM_INVALID_DEFINITION', e.message, 422);
  }
  if (e instanceof InvalidUomConversionError) {
    return new DomainError('UOM_CONVERSION_INVALID', e.message, 422);
  }
  if (e instanceof InexactConversionError) {
    return new DomainError('IDENTIFIER_PACK_BASE_INEXACT', e.message, 422);
  }
  if (e instanceof FractionalUnitError) {
    return new DomainError('FRACTIONAL_UNIT', e.message, 422);
  }
  if (e instanceof UomFamilyMismatchError || e instanceof UomConversionUnavailableError) {
    return new DomainError('UOM_CONVERSION_UNRESOLVABLE', e.message, 422);
  }
  if (e instanceof UnknownUomError) {
    return new DomainError('UOM_NOT_REGISTERED', e.message, 422);
  }
  if (e instanceof Error && /is not exact/i.test(e.message)) {
    return new DomainError('IDENTIFIER_PACK_BASE_INEXACT', e.message, 422);
  }
  throw e;
}
