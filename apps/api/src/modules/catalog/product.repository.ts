import { Injectable } from '@nestjs/common';
import type { Prisma, ScopedTx } from '@flower/db';
import type { FulfilmentStrategy } from '@flower/shared-types';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { resolveSlug, SLUG_MAX, versionConflict } from './catalog-write.helpers.js';

export interface ProductRow {
  id: string;
  categoryId: string;
  productTypeId: string | null;
  slug: string;
  nameEn: string;
  nameAr: string | null;
  description: string | null;
  fulfilmentStrategy: string;
  hidePrice: boolean;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  categoryId: true,
  productTypeId: true,
  slug: true,
  nameEn: true,
  nameAr: true,
  description: true,
  fulfilmentStrategy: true,
  hidePrice: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface LockedProduct {
  version: number;
  status: string;
  fulfilmentStrategy: string;
  slug: string;
}

export interface CreateProductInput {
  categoryId: string;
  productTypeId?: string | null | undefined;
  slug?: string | undefined;
  nameEn: string;
  nameAr?: string | null | undefined;
  description?: string | null | undefined;
  fulfilmentStrategy: FulfilmentStrategy;
  hidePrice?: boolean | undefined;
}

export interface UpdateProductInput {
  categoryId?: string | undefined;
  productTypeId?: string | null | undefined;
  slug?: string | undefined;
  nameEn?: string | undefined;
  nameAr?: string | null | undefined;
  description?: string | null | undefined;
  hidePrice?: boolean | undefined;
  /** Only honoured while status = DRAFT (owner §5); the capability + entitlement
   *  re-check is done by `ProductService` before calling this. */
  fulfilmentStrategy?: FulfilmentStrategy | undefined;
}

/**
 * Tenant catalog products. RLS-scoped. No money / company / branch / stock /
 * media / tax / attribute / variant / UOM column (owner §11). `fulfilmentStrategy`
 * is stored only — the capability + entitlement gate lives in `ProductService`.
 */
@Injectable()
export class ProductRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  async list(filter: {
    status?: string | undefined;
    categoryId?: string | undefined;
    productTypeId?: string | undefined;
    fulfilmentStrategy?: string | undefined;
    q?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ data: ProductRow[]; nextCursor: string | null; hasNextPage: boolean }> {
    const take = filter.limit + 1;
    const rows = await this.scoped((tx) =>
      tx.product.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
          ...(filter.productTypeId ? { productTypeId: filter.productTypeId } : {}),
          ...(filter.fulfilmentStrategy ? { fulfilmentStrategy: filter.fulfilmentStrategy } : {}),
          ...(filter.q
            ? {
                OR: [
                  { nameEn: { contains: filter.q, mode: 'insensitive' } },
                  { nameAr: { contains: filter.q, mode: 'insensitive' } },
                  { slug: { contains: filter.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: { id: 'asc' },
        ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
        take,
        select: SELECT,
      }),
    );
    const hasNextPage = rows.length === take;
    const data = hasNextPage ? rows.slice(0, filter.limit) : rows;
    return { data, nextCursor: hasNextPage ? (data.at(-1)?.id ?? null) : null, hasNextPage };
  }

  get(id: string): Promise<ProductRow> {
    return this.scoped(async (tx) => {
      const row = await tx.product.findUnique({ where: { id }, select: SELECT });
      if (!row) throw new NotFoundError('product');
      return row;
    });
  }

  async create(input: CreateProductInput): Promise<ProductRow> {
    const slug = resolveSlug(input.slug, input.nameEn, SLUG_MAX.product);
    const productTypeId = input.productTypeId ?? null;

    return this.scoped(async (tx) => {
      await assertCategoryActive(tx, input.categoryId);
      if (productTypeId !== null) await assertProductTypeActive(tx, productTypeId);
      await this.assertSlugFree(tx, slug, null);

      const created = await tx.product.create({
        data: {
          tenantId: requireTenantContext().tenantId,
          categoryId: input.categoryId,
          productTypeId,
          slug,
          nameEn: input.nameEn,
          nameAr: input.nameAr ?? null,
          description: input.description ?? null,
          fulfilmentStrategy: input.fulfilmentStrategy,
          hidePrice: input.hidePrice ?? false,
        },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.product_created',
        resourceType: 'product',
        resourceId: created.id,
        after: {
          slug: created.slug,
          fulfilmentStrategy: created.fulfilmentStrategy,
          status: created.status,
        },
      });
      return created;
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateProductInput,
  ): Promise<ProductRow> {
    return this.scoped(async (tx) => {
      const current = await lockProduct(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('product', expectedVersion, current.version);
      }

      const strategyChange =
        input.fulfilmentStrategy !== undefined &&
        input.fulfilmentStrategy !== current.fulfilmentStrategy;
      if (strategyChange && current.status !== 'DRAFT') {
        throw new DomainError(
          'PRODUCT_STRATEGY_LOCKED',
          'fulfilmentStrategy can only change while the product is a DRAFT',
          409,
        );
      }

      if (input.categoryId !== undefined) await assertCategoryActive(tx, input.categoryId);
      if (input.productTypeId !== undefined && input.productTypeId !== null) {
        await assertProductTypeActive(tx, input.productTypeId);
      }
      const nextSlug =
        input.slug === undefined
          ? current.slug
          : resolveSlug(input.slug, input.nameEn ?? '', SLUG_MAX.product);
      if (nextSlug !== current.slug) await this.assertSlugFree(tx, nextSlug, id);

      const data: Prisma.ProductUncheckedUpdateInput = { version: { increment: 1 } };
      if (input.categoryId !== undefined) data.categoryId = input.categoryId;
      if (input.productTypeId !== undefined) data.productTypeId = input.productTypeId ?? null;
      if (input.slug !== undefined) data.slug = nextSlug;
      if (input.nameEn !== undefined) data.nameEn = input.nameEn;
      if (input.nameAr !== undefined) data.nameAr = input.nameAr ?? null;
      if (input.description !== undefined) data.description = input.description ?? null;
      if (input.hidePrice !== undefined) data.hidePrice = input.hidePrice;
      if (strategyChange && input.fulfilmentStrategy !== undefined) {
        data.fulfilmentStrategy = input.fulfilmentStrategy;
      }

      const updated = await tx.product.update({ where: { id }, data, select: SELECT });
      await this.audit.record(tx, {
        action: 'catalog.product_updated',
        resourceType: 'product',
        resourceId: id,
        ...(strategyChange
          ? {
              before: { fulfilmentStrategy: current.fulfilmentStrategy },
              after: { fulfilmentStrategy: updated.fulfilmentStrategy },
            }
          : {}),
      });
      return updated;
    });
  }

  /** DRAFT → ACTIVE or ARCHIVED → ACTIVE. The strategy capability + entitlement
   *  re-check is done by `ProductService` first (owner §12). */
  activate(id: string, expectedVersion: number): Promise<ProductRow> {
    return this.transition(id, expectedVersion, 'ACTIVE');
  }

  /** ACTIVE → ARCHIVED, DRAFT → ARCHIVED. */
  archive(id: string, expectedVersion: number): Promise<ProductRow> {
    return this.transition(id, expectedVersion, 'ARCHIVED');
  }

  private transition(
    id: string,
    expectedVersion: number,
    next: 'ACTIVE' | 'ARCHIVED',
  ): Promise<ProductRow> {
    return this.scoped(async (tx) => {
      const current = await lockProduct(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('product', expectedVersion, current.version);
      }
      if (current.status === next) {
        const row = await tx.product.findUnique({ where: { id }, select: SELECT });
        return row!;
      }
      // ACTIVE → DRAFT is never allowed; this method only ever sets ACTIVE or
      // ARCHIVED so that transition is unreachable here.
      const updated = await tx.product.update({
        where: { id },
        data: { status: next, version: { increment: 1 } },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.product_status_changed',
        resourceType: 'product',
        resourceId: id,
        before: { status: current.status },
        after: { status: next },
      });
      return updated;
    });
  }

  /** Hard delete — only a DRAFT product, correct `If-Match` (owner §13 / R-8). */
  async remove(id: string, expectedVersion: number): Promise<void> {
    await this.scoped(async (tx) => {
      const current = await lockProduct(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('product', expectedVersion, current.version);
      }
      if (current.status !== 'DRAFT') {
        throw new DomainError(
          'PRODUCT_NOT_DELETABLE',
          'only a DRAFT product can be hard-deleted; archive it instead',
          409,
        );
      }
      await tx.product.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'catalog.product_deleted',
        resourceType: 'product',
        resourceId: id,
        before: { slug: current.slug, fulfilmentStrategy: current.fulfilmentStrategy },
      });
    });
  }

  private async assertSlugFree(tx: ScopedTx, slug: string, selfId: string | null): Promise<void> {
    const clash = await tx.product.findFirst({
      where: { slug, ...(selfId ? { id: { not: selfId } } : {}) },
      select: { id: true },
    });
    if (clash) {
      throw new DomainError(
        'PRODUCT_SLUG_TAKEN',
        `a product with slug "${slug}" already exists`,
        409,
      );
    }
  }
}

async function lockProduct(tx: ScopedTx, id: string): Promise<LockedProduct> {
  const rows = await tx.$queryRaw<LockedProduct[]>`
    SELECT "version", "status", "fulfilmentStrategy", "slug"
      FROM "product" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('product');
  return rows[0]!;
}

async function assertCategoryActive(tx: ScopedTx, categoryId: string): Promise<void> {
  const cat = await tx.category.findUnique({ where: { id: categoryId }, select: { status: true } });
  if (!cat) throw new NotFoundError('category');
  if (cat.status !== 'ACTIVE') {
    throw new DomainError('CATEGORY_ARCHIVED', 'the category is archived', 409);
  }
}

async function assertProductTypeActive(tx: ScopedTx, productTypeId: string): Promise<void> {
  const pt = await tx.productType.findUnique({
    where: { id: productTypeId },
    select: { status: true },
  });
  if (!pt) throw new NotFoundError('product type');
  if (pt.status !== 'ACTIVE') {
    throw new DomainError('PRODUCT_TYPE_ARCHIVED', 'the product type is archived', 409);
  }
}
