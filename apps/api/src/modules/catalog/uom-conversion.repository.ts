import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import { UomRepository } from './uom.repository.js';
import {
  buildRegistry,
  effectiveConversions,
  mapUomError,
  requireUomCode,
  toUomDef,
  toUomConversion,
  type ConversionRow,
  type TenantUomRow,
} from './uom.helpers.js';

export interface VariantConversionEntry {
  fromUomCode: string;
  num: string;
  den?: string | undefined;
}

export interface ProductConversionEntry {
  fromUomCode: string;
  toUomCode: string;
  num: string;
  den?: string | undefined;
}

export interface EffectiveConversionRow {
  fromUomCode: string;
  toUomCode: string;
  num: string;
  den: string;
  source: 'VARIANT' | 'PRODUCT';
  inherited: boolean;
}

export interface StoredProductConversionRow {
  id: string;
  fromUomCode: string;
  toUomCode: string;
  num: string;
  den: string;
  appliesToVariantCount: number;
}

const CONV_SELECT = {
  fromUomCode: true,
  toUomCode: true,
  num: true,
  den: true,
} as const;

/**
 * Product-/variant-scoped `uom_conversion` rows (task 3.6 §F). Base-anchored
 * (P2 — no graph / traversal). Replace-sets are guarded by the parent
 * `variant.version` / `product.version` (`If-Match`, D2-9) — no `Idempotency-Key`
 * (no external side effect). `multi_uom` is gated by `UomService`. Every custom
 * UOM code a row references is `FOR KEY SHARE`-locked before the write (owner
 * FINAL CORRECTION 2).
 */
@Injectable()
export class UomConversionRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  /** The effective resolution set for a variant — its own rows + inherited
   *  matching PRODUCT rows (owner §F). */
  getVariantEffective(variantId: string): Promise<{
    variantVersion: number;
    baseUomCode: string | null;
    rows: EffectiveConversionRow[];
  }> {
    return this.scoped(async (tx) => {
      const variant = await tx.variant.findUnique({
        where: { id: variantId },
        select: { id: true, productId: true, version: true, baseUomCode: true },
      });
      if (!variant) throw new NotFoundError('variant');
      const [variantRows, productRows] = await Promise.all([
        tx.uomConversion.findMany({
          where: { scopeKind: 'VARIANT', scopeId: variantId },
          orderBy: { fromUomCode: 'asc' },
          select: CONV_SELECT,
        }),
        tx.uomConversion.findMany({
          where: { scopeKind: 'PRODUCT', scopeId: variant.productId },
          orderBy: { fromUomCode: 'asc' },
          select: CONV_SELECT,
        }),
      ]);
      const covered = new Set(variantRows.map((r) => r.fromUomCode));
      const rows: EffectiveConversionRow[] = variantRows.map((r) => ({
        fromUomCode: r.fromUomCode,
        toUomCode: r.toUomCode,
        num: r.num.toString(),
        den: r.den.toString(),
        source: 'VARIANT',
        inherited: false,
      }));
      for (const r of productRows) {
        if (
          variant.baseUomCode !== null &&
          r.toUomCode === variant.baseUomCode &&
          !covered.has(r.fromUomCode)
        ) {
          rows.push({
            fromUomCode: r.fromUomCode,
            toUomCode: r.toUomCode,
            num: r.num.toString(),
            den: r.den.toString(),
            source: 'PRODUCT',
            inherited: true,
          });
        }
      }
      return { variantVersion: variant.version, baseUomCode: variant.baseUomCode, rows };
    });
  }

  /** The stored PRODUCT-scoped rows — NOT the variant projection. An inert row
   *  (`appliesToVariantCount = 0`, owner OD-E) only appears here. */
  getProductStored(
    productId: string,
  ): Promise<{ productVersion: number; rows: StoredProductConversionRow[] }> {
    return this.scoped(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { version: true },
      });
      if (!product) throw new NotFoundError('product');
      const rows = await tx.uomConversion.findMany({
        where: { scopeKind: 'PRODUCT', scopeId: productId },
        orderBy: [{ fromUomCode: 'asc' }, { toUomCode: 'asc' }],
        select: { id: true, ...CONV_SELECT },
      });
      const variants = await tx.variant.findMany({
        where: { productId, status: { not: 'ARCHIVED' } },
        select: { baseUomCode: true },
      });
      const baseCounts = new Map<string, number>();
      for (const v of variants) {
        if (v.baseUomCode) baseCounts.set(v.baseUomCode, (baseCounts.get(v.baseUomCode) ?? 0) + 1);
      }
      return {
        productVersion: product.version,
        rows: rows.map((r) => ({
          id: r.id,
          fromUomCode: r.fromUomCode,
          toUomCode: r.toUomCode,
          num: r.num.toString(),
          den: r.den.toString(),
          appliesToVariantCount: baseCounts.get(r.toUomCode) ?? 0,
        })),
      };
    });
  }

  async replaceVariantConversions(
    variantId: string,
    expectedVersion: number,
    entries: VariantConversionEntry[],
  ): Promise<{ variantVersion: number; rows: EffectiveConversionRow[] }> {
    await this.scoped(async (tx) => {
      const current = await lockVariant(tx, variantId);
      if (!current) throw new NotFoundError('variant');
      if (expectedVersion !== current.version) {
        throw versionConflict('variant', expectedVersion, current.version);
      }
      if (current.baseUomCode === null) {
        throw new DomainError(
          'VARIANT_BASE_UOM_REQUIRED',
          'set the variant base UOM before adding conversions',
          409,
        );
      }
      const base = current.baseUomCode;

      const normalized = entries.map((e) => ({
        fromUomCode: requireUomCode(e.fromUomCode),
        num: e.num,
        den: e.den ?? '1',
      }));
      const seen = new Set<string>();
      for (const e of normalized) {
        if (e.fromUomCode === base) {
          throw new DomainError(
            'UOM_CONVERSION_INVALID',
            `"${base}" is the variant base UOM — a conversion from it to itself is meaningless`,
            422,
          );
        }
        if (seen.has(e.fromUomCode)) {
          throw new DomainError(
            'UOM_CONVERSION_DUPLICATE',
            `conversion from "${e.fromUomCode}" appears more than once`,
            422,
          );
        }
        seen.add(e.fromUomCode);
      }

      await UomRepository.lockCustomUomRefs(tx, [base, ...normalized.map((e) => e.fromUomCode)]);

      const units = await loadTenantUnits(tx);
      const proposed: ConversionRow[] = normalized.map((e) => ({
        fromUomCode: e.fromUomCode,
        toUomCode: base,
        num: parseRatioPart(e.num, 'num'),
        den: parseRatioPart(e.den, 'den'),
      }));

      // eager validation (num/den > 0, both units registered) + redundancy guard
      const registry = buildRegistry(units.map(toUomDef), proposed.map(toUomConversion));
      for (const r of proposed) {
        if (registry.isSameFamilyResolvable(r.fromUomCode, base)) {
          throw new DomainError(
            'UOM_CONVERSION_REDUNDANT',
            `"${r.fromUomCode}" → "${base}" is already resolvable by same-family perBase semantics — an explicit conversion is not permitted (model one side as an EACH unit for a different ratio)`,
            422,
          );
        }
      }

      const before = await tx.uomConversion.count({
        where: { scopeKind: 'VARIANT', scopeId: variantId },
      });
      await tx.uomConversion.deleteMany({ where: { scopeKind: 'VARIANT', scopeId: variantId } });
      if (proposed.length > 0) {
        await tx.uomConversion.createMany({
          data: proposed.map((r) => ({
            tenantId: requireTenantContext().tenantId,
            scopeKind: 'VARIANT',
            scopeId: variantId,
            fromUomCode: r.fromUomCode,
            toUomCode: r.toUomCode,
            num: r.num,
            den: r.den,
          })),
        });
      }
      await tx.variant.update({
        where: { id: variantId },
        data: { version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'catalog.variant_conversions_changed',
        resourceType: 'variant',
        resourceId: variantId,
        before: { count: before },
        after: {
          count: proposed.length,
          conversions: proposed.map((r) => ({
            fromUomCode: r.fromUomCode,
            toUomCode: r.toUomCode,
            num: r.num.toString(),
            den: r.den.toString(),
          })),
        },
      });
    });
    return this.getVariantEffective(variantId).then((r) => ({
      variantVersion: r.variantVersion,
      rows: r.rows,
    }));
  }

  async replaceProductConversions(
    productId: string,
    expectedVersion: number,
    entries: ProductConversionEntry[],
  ): Promise<{ productVersion: number; rows: StoredProductConversionRow[] }> {
    await this.scoped(async (tx) => {
      const current = await lockProduct(tx, productId);
      if (!current) throw new NotFoundError('product');
      if (expectedVersion !== current.version) {
        throw versionConflict('product', expectedVersion, current.version);
      }

      const normalized = entries.map((e) => ({
        fromUomCode: requireUomCode(e.fromUomCode),
        toUomCode: requireUomCode(e.toUomCode),
        num: e.num,
        den: e.den ?? '1',
      }));
      const seen = new Set<string>();
      for (const e of normalized) {
        if (e.fromUomCode === e.toUomCode) {
          throw new DomainError(
            'UOM_CONVERSION_INVALID',
            'a conversion from a unit to itself is meaningless',
            422,
          );
        }
        const key = `${e.fromUomCode} ${e.toUomCode}`;
        if (seen.has(key)) {
          throw new DomainError(
            'UOM_CONVERSION_DUPLICATE',
            `conversion "${e.fromUomCode}" → "${e.toUomCode}" appears more than once`,
            422,
          );
        }
        seen.add(key);
      }

      await UomRepository.lockCustomUomRefs(tx, [
        ...normalized.map((e) => e.fromUomCode),
        ...normalized.map((e) => e.toUomCode),
      ]);

      const units = await loadTenantUnits(tx);
      const proposed: ConversionRow[] = normalized.map((e) => ({
        fromUomCode: e.fromUomCode,
        toUomCode: e.toUomCode,
        num: parseRatioPart(e.num, 'num'),
        den: parseRatioPart(e.den, 'den'),
      }));
      const registry = buildRegistry(units.map(toUomDef), proposed.map(toUomConversion));
      for (const r of proposed) {
        if (registry.isSameFamilyResolvable(r.fromUomCode, r.toUomCode)) {
          throw new DomainError(
            'UOM_CONVERSION_REDUNDANT',
            `"${r.fromUomCode}" → "${r.toUomCode}" is already resolvable by same-family perBase semantics — an explicit conversion is not permitted`,
            422,
          );
        }
      }

      const before = await tx.uomConversion.count({
        where: { scopeKind: 'PRODUCT', scopeId: productId },
      });
      await tx.uomConversion.deleteMany({ where: { scopeKind: 'PRODUCT', scopeId: productId } });
      if (proposed.length > 0) {
        await tx.uomConversion.createMany({
          data: proposed.map((r) => ({
            tenantId: requireTenantContext().tenantId,
            scopeKind: 'PRODUCT',
            scopeId: productId,
            fromUomCode: r.fromUomCode,
            toUomCode: r.toUomCode,
            num: r.num,
            den: r.den,
          })),
        });
      }
      await tx.product.update({ where: { id: productId }, data: { version: { increment: 1 } } });
      await this.audit.record(tx, {
        action: 'catalog.product_conversions_changed',
        resourceType: 'product',
        resourceId: productId,
        before: { count: before },
        after: {
          count: proposed.length,
          conversions: proposed.map((r) => ({
            fromUomCode: r.fromUomCode,
            toUomCode: r.toUomCode,
            num: r.num.toString(),
            den: r.den.toString(),
          })),
        },
      });
    });
    return this.getProductStored(productId);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseRatioPart(raw: string, field: string): bigint {
  if (!/^\d{1,19}$/.test(String(raw).trim())) {
    throw new DomainError('UOM_CONVERSION_INVALID', `${field} must be a positive integer`, 422, [
      { field, issue: 'not a positive integer' },
    ]);
  }
  const v = BigInt(String(raw).trim());
  if (v <= 0n) {
    throw new DomainError('UOM_CONVERSION_INVALID', `${field} must be > 0`, 422, [
      { field, issue: 'must be > 0' },
    ]);
  }
  return v;
}

function loadTenantUnits(tx: ScopedTx): Promise<TenantUomRow[]> {
  return tx.uom.findMany({
    select: { code: true, family: true, perBaseNum: true, perBaseDen: true, maxDecimals: true },
  }) as Promise<TenantUomRow[]>;
}

async function lockVariant(
  tx: ScopedTx,
  id: string,
): Promise<{
  version: number;
  status: string;
  productId: string;
  baseUomCode: string | null;
} | null> {
  const rows = await tx.$queryRaw<
    { version: number; status: string; productId: string; baseUomCode: string | null }[]
  >`SELECT "version", "status", "productId", "baseUomCode" FROM "variant" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

async function lockProduct(
  tx: ScopedTx,
  id: string,
): Promise<{ version: number; status: string } | null> {
  const rows = await tx.$queryRaw<{ version: number; status: string }[]>`
    SELECT "version", "status" FROM "product" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

export { effectiveConversions, mapUomError };
