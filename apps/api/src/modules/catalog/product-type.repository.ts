import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertValidProductTypeKey, versionConflict } from './catalog-write.helpers.js';

export interface ProductTypeRow {
  id: string;
  key: string;
  nameEn: string;
  nameAr: string | null;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  key: true,
  nameEn: true,
  nameAr: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface LockedProductType {
  version: number;
  status: string;
  key: string;
}

/**
 * Tenant-defined product types — a reusable classification, NOT a behaviour
 * source and NOT a hardcoded enum (owner §4 / §10). No `defaultFulfilmentStrategy`
 * or any other behavioural column: fulfilment behaviour lives ONLY on
 * `product.fulfilmentStrategy`. RLS-scoped like every catalog table.
 */
@Injectable()
export class ProductTypeRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  list(filter: { status?: string | undefined; q?: string | undefined }) {
    return this.scoped((tx) =>
      tx.productType.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.q
            ? {
                OR: [
                  { key: { contains: filter.q, mode: 'insensitive' } },
                  { nameEn: { contains: filter.q, mode: 'insensitive' } },
                  { nameAr: { contains: filter.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: { key: 'asc' },
        select: SELECT,
      }),
    );
  }

  get(id: string): Promise<ProductTypeRow> {
    return this.scoped(async (tx) => {
      const row = await tx.productType.findUnique({ where: { id }, select: SELECT });
      if (!row) throw new NotFoundError('product type');
      return row;
    });
  }

  async create(input: {
    key: string;
    nameEn: string;
    nameAr?: string | null | undefined;
  }): Promise<ProductTypeRow> {
    assertValidProductTypeKey(input.key);
    return this.scoped(async (tx) => {
      const clash = await tx.productType.findUnique({
        where: { tenantId_key: { tenantId: requireTenantContext().tenantId, key: input.key } },
        select: { id: true },
      });
      if (clash) {
        throw new DomainError(
          'PRODUCT_TYPE_KEY_TAKEN',
          `a product type with key "${input.key}" already exists`,
          409,
        );
      }
      const created = await tx.productType.create({
        data: {
          tenantId: requireTenantContext().tenantId,
          key: input.key,
          nameEn: input.nameEn,
          nameAr: input.nameAr ?? null,
        },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.product_type_created',
        resourceType: 'product_type',
        resourceId: created.id,
        after: { key: created.key },
      });
      return created;
    });
  }

  /** `key` is immutable (owner §11 wording — a stable classification handle). */
  async update(
    id: string,
    expectedVersion: number,
    input: { nameEn?: string | undefined; nameAr?: string | null | undefined },
  ): Promise<ProductTypeRow> {
    return this.scoped(async (tx) => {
      const current = await lockProductType(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('product_type', expectedVersion, current.version);
      }
      const updated = await tx.productType.update({
        where: { id },
        data: {
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.nameAr !== undefined ? { nameAr: input.nameAr ?? null } : {}),
          version: { increment: 1 },
        },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.product_type_updated',
        resourceType: 'product_type',
        resourceId: id,
      });
      return updated;
    });
  }

  async setStatus(
    id: string,
    expectedVersion: number,
    next: 'ACTIVE' | 'ARCHIVED',
  ): Promise<ProductTypeRow> {
    return this.scoped(async (tx) => {
      const current = await lockProductType(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('product_type', expectedVersion, current.version);
      }
      if (current.status === next) {
        const row = await tx.productType.findUnique({ where: { id }, select: SELECT });
        return row!;
      }
      const updated = await tx.productType.update({
        where: { id },
        data: { status: next, version: { increment: 1 } },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.product_type_status_changed',
        resourceType: 'product_type',
        resourceId: id,
        before: { status: current.status },
        after: { status: next },
      });
      return updated;
    });
  }

  /** Hard delete — only an ACTIVE product type with zero products, correct
   *  `If-Match` (owner §13 / R-8). Otherwise archive. */
  async remove(id: string, expectedVersion: number): Promise<void> {
    await this.scoped(async (tx) => {
      const current = await lockProductType(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('product_type', expectedVersion, current.version);
      }
      if (current.status !== 'ACTIVE') {
        throw new DomainError(
          'PRODUCT_TYPE_NOT_DELETABLE',
          'only an ACTIVE product type can be hard-deleted; archive it instead',
          409,
        );
      }
      const products = await tx.product.count({ where: { productTypeId: id } });
      if (products > 0) {
        throw new DomainError('PRODUCT_TYPE_IN_USE', 'the product type still has products', 409);
      }
      await tx.productType.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'catalog.product_type_deleted',
        resourceType: 'product_type',
        resourceId: id,
        before: { key: current.key },
      });
    });
  }
}

async function lockProductType(tx: ScopedTx, id: string): Promise<LockedProductType> {
  const rows = await tx.$queryRaw<LockedProductType[]>`
    SELECT "version", "status", "key" FROM "product_type" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('product type');
  return rows[0]!;
}
