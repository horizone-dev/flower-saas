import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';

/** `PUT …/tax-category` result — the persisted key + the new parent version. */
export interface TaxCategoryAssignmentRow {
  taxCategoryKey: string | null;
  version: number;
}

/** The two catalog tax-category columns needed to resolve a variant's effective
 *  category (task 3.9 precedence: `variant -> product -> NONE`). */
export interface TaxCategoryResolutionContext {
  productId: string;
  variantTaxCategoryKey: string | null;
  productTaxCategoryKey: string | null;
}

/**
 * Task 3.9 — catalog tax-category assignment (`product.taxCategoryKey` /
 * `variant.taxCategoryKey`) + the read that `TaxResolutionService` needs.
 * Tenant-owned, RLS-scoped (`product` / `variant` already carry ENABLE + FORCE +
 * a tenant policy — this task adds only a nullable column, no policy change).
 *
 * Concurrency = the EXISTING catalog optimistic-concurrency convention: the
 * assignment lives directly on `product` / `variant`, so `product.version` /
 * `variant.version` IS the `If-Match` handle (no dedicated aggregate/version row
 * — unlike Tasks 3.7 / 3.8 pricing). Each write takes a `FOR UPDATE` row lock,
 * checks the version, blocks an ARCHIVED resource (owner O2), validates the key
 * against the platform `tax_category` table, mutates + `version += 1`, and
 * writes exactly one audit row. A stale / ARCHIVED / unknown-key write makes NO
 * change and NO audit row. Business Type is never read (HG3-NO-BT-BRANCH).
 */
@Injectable()
export class TaxCategoryRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  setProductTaxCategory(
    productId: string,
    expectedVersion: number,
    taxCategoryKey: string | null,
  ): Promise<TaxCategoryAssignmentRow> {
    return this.scoped(async (tx) => {
      const current = await lockProductForTax(tx, productId);
      if (expectedVersion !== current.version) {
        throw versionConflict('product', expectedVersion, current.version);
      }
      if (current.status === 'ARCHIVED') {
        throw new DomainError(
          'PRODUCT_ARCHIVED',
          'the product is archived — reactivate it before changing its tax category',
          409,
        );
      }
      if (taxCategoryKey !== null) await assertTaxCategoryExists(tx, taxCategoryKey);

      const updated = await tx.product.update({
        where: { id: productId },
        data: { taxCategoryKey, version: { increment: 1 } },
        select: { taxCategoryKey: true, version: true },
      });
      await this.audit.record(tx, {
        action: 'catalog.product_tax_category_changed',
        resourceType: 'product',
        resourceId: productId,
        before: { taxCategoryKey: current.taxCategoryKey },
        after: { taxCategoryKey },
      });
      return updated;
    });
  }

  setVariantTaxCategory(
    variantId: string,
    expectedVersion: number,
    taxCategoryKey: string | null,
  ): Promise<TaxCategoryAssignmentRow> {
    return this.scoped(async (tx) => {
      const current = await lockVariantForTax(tx, variantId);
      if (expectedVersion !== current.version) {
        throw versionConflict('variant', expectedVersion, current.version);
      }
      if (current.status === 'ARCHIVED') {
        throw new DomainError(
          'VARIANT_ARCHIVED',
          'the variant is archived — reactivate it before changing its tax category',
          409,
        );
      }
      if (taxCategoryKey !== null) await assertTaxCategoryExists(tx, taxCategoryKey);

      const updated = await tx.variant.update({
        where: { id: variantId },
        data: { taxCategoryKey, version: { increment: 1 } },
        select: { taxCategoryKey: true, version: true },
      });
      await this.audit.record(tx, {
        action: 'catalog.variant_tax_category_changed',
        resourceType: 'variant',
        resourceId: variantId,
        before: { taxCategoryKey: current.taxCategoryKey },
        after: { taxCategoryKey },
      });
      return updated;
    });
  }

  /** Read the variant + its product tax-category keys for resolution. RLS
   *  restricts to the caller's tenant; an unknown / cross-tenant variant → 404. */
  getResolutionContext(variantId: string): Promise<TaxCategoryResolutionContext> {
    return this.scoped(async (tx) => {
      const v = await tx.variant.findUnique({
        where: { id: variantId },
        select: {
          productId: true,
          taxCategoryKey: true,
          product: { select: { taxCategoryKey: true } },
        },
      });
      if (!v) throw new NotFoundError('variant');
      return {
        productId: v.productId,
        variantTaxCategoryKey: v.taxCategoryKey,
        productTaxCategoryKey: v.product.taxCategoryKey,
      };
    });
  }
}

interface LockedForTax {
  version: number;
  status: string;
  taxCategoryKey: string | null;
}

async function lockProductForTax(tx: ScopedTx, id: string): Promise<LockedForTax> {
  const rows = await tx.$queryRaw<LockedForTax[]>`
    SELECT "version", "status", "taxCategoryKey"
      FROM "product" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('product');
  return rows[0]!;
}

async function lockVariantForTax(tx: ScopedTx, id: string): Promise<LockedForTax> {
  const rows = await tx.$queryRaw<LockedForTax[]>`
    SELECT "version", "status", "taxCategoryKey"
      FROM "variant" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('variant');
  return rows[0]!;
}

/** A well-formed key that is not a real `tax_category` row → `422` (the DB FK is
 *  the backstop; this gives a clean typed error instead of a raw `23503`). */
async function assertTaxCategoryExists(tx: ScopedTx, key: string): Promise<void> {
  const row = await tx.taxCategory.findUnique({ where: { key }, select: { key: true } });
  if (!row) {
    throw new DomainError('TAX_CATEGORY_UNKNOWN', `tax category "${key}" does not exist`, 422, [
      { field: 'taxCategoryKey', issue: 'unknown tax category' },
    ]);
  }
}
