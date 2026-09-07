import { Injectable } from '@nestjs/common';
import type { Prisma, ScopedTx } from '@flower/db';
import type { AttributeValueType } from '@flower/shared-types';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import { inScopeActiveDefinitions } from './attribute-definition.repository.js';
import { resolveAttributeValue, type AttributeValueInput } from './attribute.helpers.js';

export interface ProductAttributeValueRow {
  attributeDefinitionId: string;
  key: string;
  valueType: string;
  valueText: string | null;
  valueNumber: string | null;
  valueBool: boolean | null;
  valueDate: string | null;
  optionId: string | null;
}

interface LockedProduct {
  version: number;
  status: string;
  categoryId: string;
  productTypeId: string | null;
}

/**
 * The typed attribute values of ONE product (task 3.3). `PUT` is a replace-set
 * guarded by the parent `product.version` (`If-Match`); a successful replace
 * bumps `product.version` exactly once and writes one audit row (owner K.3).
 */
@Injectable()
export class ProductAttributeRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  getForProduct(
    productId: string,
  ): Promise<{ productVersion: number; values: ProductAttributeValueRow[] }> {
    return this.scoped(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { version: true },
      });
      if (!product) throw new NotFoundError('product');
      const rows = await tx.productAttributeValue.findMany({
        where: { productId },
        select: {
          attributeDefinitionId: true,
          valueText: true,
          valueNumber: true,
          valueBool: true,
          valueDate: true,
          optionId: true,
          definition: { select: { key: true, valueType: true } },
        },
        orderBy: { attributeDefinitionId: 'asc' },
      });
      return {
        productVersion: product.version,
        values: rows.map((r) => ({
          attributeDefinitionId: r.attributeDefinitionId,
          key: r.definition.key,
          valueType: r.definition.valueType,
          valueText: r.valueText,
          // canonical numeric(18,4) form — exact, never JS float (owner K.9)
          valueNumber: r.valueNumber === null ? null : r.valueNumber.toFixed(4),
          valueBool: r.valueBool,
          valueDate: r.valueDate === null ? null : toDateString(r.valueDate),
          optionId: r.optionId,
        })),
      };
    });
  }

  /**
   * Atomically replace the whole attribute set for a product. Each entry:
   *   - the definition must be same-tenant + ACTIVE + in scope for the product's
   *     category / product type (owner K.7 — exact category match)
   *   - the typed value must match the definition's `valueType`
   *   - for ENUM, the option must belong to the same definition (the DB ENUM
   *     composite FK is the backstop; this is the clean-4xx pre-check)
   * Bumps `product.version` once; one `catalog.product_attributes_changed` audit.
   */
  async replaceForProduct(
    productId: string,
    expectedVersion: number,
    entries: AttributeValueInput[],
  ): Promise<{ productVersion: number; values: ProductAttributeValueRow[] }> {
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.attributeDefinitionId)) {
        throw new DomainError(
          'DUPLICATE_ATTRIBUTE',
          `attribute definition ${e.attributeDefinitionId} appears more than once`,
          422,
        );
      }
      seen.add(e.attributeDefinitionId);
    }

    await this.scoped(async (tx) => {
      const current = await lockProduct(tx, productId);
      if (expectedVersion !== current.version) {
        throw versionConflict('product', expectedVersion, current.version);
      }

      const inScope = await inScopeActiveDefinitions(tx, current.categoryId, current.productTypeId);
      const byId = new Map(inScope.map((d) => [d.id, d]));

      const rows: Prisma.ProductAttributeValueCreateManyInput[] = [];
      const tenantId = requireTenantContext().tenantId;
      for (const e of entries) {
        const def = byId.get(e.attributeDefinitionId);
        if (!def) {
          // either unknown, archived, or not in this product's scope
          throw new DomainError(
            'ATTRIBUTE_NOT_IN_SCOPE',
            `attribute ${e.attributeDefinitionId} is not an ACTIVE in-scope definition for this product`,
            422,
          );
        }
        const resolved = resolveAttributeValue(def.valueType as AttributeValueType, e);
        if (resolved.column === 'optionId') {
          const opt = await tx.attributeOption.findUnique({
            where: { id: resolved.optionId },
            select: { attributeDefinitionId: true },
          });
          if (!opt || opt.attributeDefinitionId !== e.attributeDefinitionId) {
            throw new DomainError(
              'ATTRIBUTE_OPTION_MISMATCH',
              `option ${resolved.optionId} does not belong to attribute ${e.attributeDefinitionId}`,
              422,
            );
          }
        }
        rows.push({
          tenantId,
          productId,
          attributeDefinitionId: e.attributeDefinitionId,
          valueText: resolved.column === 'valueText' ? resolved.valueText : null,
          valueNumber: resolved.column === 'valueNumber' ? resolved.valueNumber : null,
          valueBool: resolved.column === 'valueBool' ? resolved.valueBool : null,
          valueDate:
            resolved.column === 'valueDate' ? new Date(`${resolved.valueDate}T00:00:00Z`) : null,
          optionId: resolved.column === 'optionId' ? resolved.optionId : null,
        });
      }

      const before = await tx.productAttributeValue.count({ where: { productId } });
      await tx.productAttributeValue.deleteMany({ where: { productId } });
      if (rows.length > 0) await tx.productAttributeValue.createMany({ data: rows });

      await tx.product.update({ where: { id: productId }, data: { version: { increment: 1 } } });
      await this.audit.record(tx, {
        action: 'catalog.product_attributes_changed',
        resourceType: 'product',
        resourceId: productId,
        before: { attributeCount: before },
        after: { attributeCount: rows.length },
      });
    });

    return this.getForProduct(productId);
  }
}

async function lockProduct(tx: ScopedTx, id: string): Promise<LockedProduct> {
  const rows = await tx.$queryRaw<LockedProduct[]>`
    SELECT "version", "status", "categoryId", "productTypeId"
      FROM "product" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('product');
  return rows[0]!;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
