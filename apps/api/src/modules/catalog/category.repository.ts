import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { MAX_CATEGORY_DEPTH } from '@flower/shared-types';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { resolveSlug, SLUG_MAX, versionConflict } from './catalog-write.helpers.js';

export interface CategoryRow {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameAr: string | null;
  sortOrder: number;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  parentId: true,
  slug: true,
  nameEn: true,
  nameAr: true,
  sortOrder: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateCategoryInput {
  parentId?: string | null | undefined;
  slug?: string | undefined;
  nameEn: string;
  nameAr?: string | null | undefined;
  sortOrder?: number | undefined;
}

export interface UpdateCategoryInput {
  slug?: string | undefined;
  nameEn?: string | undefined;
  nameAr?: string | null | undefined;
  sortOrder?: number | undefined;
  parentId?: string | null | undefined;
}

interface LockedCategory {
  version: number;
  status: string;
  parentId: string | null;
  slug: string;
  sortOrder: number;
  nameEn: string;
}

/**
 * Tenant catalog categories. Every read/write is RLS-scoped to the request
 * tenant (`ScopedRepository`); no method ever names a tenant id (CLAUDE.md
 * rule 5/6). Optimistic concurrency: a `version int` bumped on every successful
 * mutation, checked with a row `FOR UPDATE` + `If-Match` (D2-9).
 */
@Injectable()
export class CategoryRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  list(filter: {
    status?: string | undefined;
    parentId?: string | undefined;
    q?: string | undefined;
  }) {
    return this.scoped((tx) =>
      tx.category.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.parentId ? { parentId: filter.parentId } : {}),
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
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }],
        select: SELECT,
      }),
    );
  }

  get(id: string): Promise<CategoryRow> {
    return this.scoped(async (tx) => {
      const row = await tx.category.findUnique({ where: { id }, select: SELECT });
      if (!row) throw new NotFoundError('category');
      return row;
    });
  }

  async create(input: CreateCategoryInput): Promise<CategoryRow> {
    const slug = resolveSlug(input.slug, input.nameEn, SLUG_MAX.category);
    const parentId = input.parentId ?? null;

    return this.scoped(async (tx) => {
      if (parentId !== null) await this.assertParentUsable(tx, parentId, null);
      await this.assertSlugFree(tx, parentId, slug, null);

      const created = await tx.category.create({
        data: {
          tenantId: requireTenantContext().tenantId,
          parentId,
          slug,
          nameEn: input.nameEn,
          nameAr: input.nameAr ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.category_created',
        resourceType: 'category',
        resourceId: created.id,
        after: { slug: created.slug, parentId: created.parentId, status: created.status },
      });
      return created;
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateCategoryInput,
  ): Promise<CategoryRow> {
    return this.scoped(async (tx) => {
      const current = await lockCategory(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('category', expectedVersion, current.version);
      }

      const nextParentId =
        input.parentId === undefined ? current.parentId : (input.parentId ?? null);
      const reparent = nextParentId !== current.parentId;
      const nextSlug =
        input.slug === undefined
          ? current.slug
          : resolveSlug(input.slug, input.nameEn ?? current.nameEn, SLUG_MAX.category);

      if (reparent && nextParentId !== null) {
        await this.assertParentUsable(tx, nextParentId, id);
      }
      if (reparent || nextSlug !== current.slug) {
        await this.assertSlugFree(tx, nextParentId, nextSlug, id);
      }

      const updated = await tx.category.update({
        where: { id },
        data: {
          slug: nextSlug,
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.nameAr !== undefined ? { nameAr: input.nameAr ?? null } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          parentId: nextParentId,
          version: { increment: 1 },
        },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.category_updated',
        resourceType: 'category',
        resourceId: id,
        before: { slug: current.slug, parentId: current.parentId, sortOrder: current.sortOrder },
        after: { slug: updated.slug, parentId: updated.parentId, sortOrder: updated.sortOrder },
      });
      return updated;
    });
  }

  /** ACTIVE ↔ ARCHIVED. Archiving never cascades (owner §3). Re-activating a
   *  category under an archived parent is rejected. */
  async setStatus(
    id: string,
    expectedVersion: number,
    next: 'ACTIVE' | 'ARCHIVED',
  ): Promise<CategoryRow> {
    return this.scoped(async (tx) => {
      const current = await lockCategory(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('category', expectedVersion, current.version);
      }
      if (current.status === next) {
        const row = await tx.category.findUnique({ where: { id }, select: SELECT });
        return row!;
      }
      if (next === 'ACTIVE' && current.parentId !== null) {
        const parent = await tx.category.findUnique({
          where: { id: current.parentId },
          select: { status: true },
        });
        if (parent && parent.status !== 'ACTIVE') {
          throw new DomainError(
            'CATEGORY_PARENT_ARCHIVED',
            'cannot activate a category whose parent is archived',
            409,
          );
        }
      }
      const updated = await tx.category.update({
        where: { id },
        data: { status: next, version: { increment: 1 } },
        select: SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.category_status_changed',
        resourceType: 'category',
        resourceId: id,
        before: { status: current.status },
        after: { status: next },
      });
      return updated;
    });
  }

  /** Hard delete — only an ACTIVE category with zero child categories AND zero
   *  products, with a correct `If-Match` (owner §13 / R-8). Otherwise archive. */
  async remove(id: string, expectedVersion: number): Promise<void> {
    await this.scoped(async (tx) => {
      const current = await lockCategory(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('category', expectedVersion, current.version);
      }
      if (current.status !== 'ACTIVE') {
        throw new DomainError(
          'CATEGORY_NOT_DELETABLE',
          'only an ACTIVE category can be hard-deleted; archive it instead',
          409,
        );
      }
      const [children, products] = await Promise.all([
        tx.category.count({ where: { parentId: id } }),
        tx.product.count({ where: { categoryId: id } }),
      ]);
      if (children > 0) {
        throw new DomainError(
          'CATEGORY_HAS_CHILDREN',
          'archive or move the child categories first',
          409,
        );
      }
      if (products > 0) {
        throw new DomainError('CATEGORY_IN_USE', 'the category still has products', 409);
      }
      await tx.category.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'catalog.category_deleted',
        resourceType: 'category',
        resourceId: id,
        before: { slug: current.slug, parentId: current.parentId },
      });
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The parent must exist and be ACTIVE, and placing a node under it must not
   * push the tree past `MAX_CATEGORY_DEPTH` (root = 1). On re-parent
   * (`movingNodeId` set) the parent must not be the node itself or one of its
   * descendants (cycle), and the moving subtree's deepest leaf must still fit.
   */
  private async assertParentUsable(
    tx: ScopedTx,
    parentId: string,
    movingNodeId: string | null,
  ): Promise<void> {
    const parent = await tx.category.findUnique({
      where: { id: parentId },
      select: { id: true, status: true },
    });
    if (!parent) throw new NotFoundError('parent category');
    if (parent.status !== 'ACTIVE') {
      throw new DomainError(
        'CATEGORY_PARENT_ARCHIVED',
        'cannot nest a category under an archived parent',
        409,
      );
    }

    if (movingNodeId !== null && parentId === movingNodeId) {
      throw new DomainError('CATEGORY_CYCLE', 'a category cannot be its own parent', 409);
    }

    // depth of the parent (root = 1); on re-parent, also whether the moving node
    // is an ancestor of the target parent (→ cycle).
    const anc = await tx.$queryRaw<{ depth: number; hits_node: boolean | null }[]>`
      WITH RECURSIVE anc AS (
        SELECT "id", "parentId", 1 AS lvl FROM "category" WHERE "id" = ${parentId}::uuid
        UNION ALL
        SELECT c."id", c."parentId", anc.lvl + 1
          FROM "category" c JOIN anc ON c."id" = anc."parentId"
      )
      SELECT max(lvl)::int AS depth,
             bool_or("id" = ${movingNodeId ?? parentId}::uuid) AS hits_node
        FROM anc`;
    const parentDepth = anc[0]?.depth ?? 1;
    if (movingNodeId !== null && anc[0]?.hits_node === true) {
      throw new DomainError(
        'CATEGORY_CYCLE',
        'a category cannot be moved under one of its own descendants',
        409,
      );
    }

    let subtreeBelow = 0;
    if (movingNodeId !== null) {
      const sub = await tx.$queryRaw<{ m: number }[]>`
        WITH RECURSIVE sub AS (
          SELECT "id", 0 AS rel FROM "category" WHERE "id" = ${movingNodeId}::uuid
          UNION ALL
          SELECT c."id", sub.rel + 1 FROM "category" c JOIN sub ON c."parentId" = sub."id"
        )
        SELECT COALESCE(max(rel), 0)::int AS m FROM sub`;
      subtreeBelow = sub[0]?.m ?? 0;
    }

    if (parentDepth + 1 + subtreeBelow > MAX_CATEGORY_DEPTH) {
      throw new DomainError(
        'CATEGORY_TOO_DEEP',
        `category tree may not exceed ${MAX_CATEGORY_DEPTH} levels`,
        409,
      );
    }
  }

  /** Sibling-unique slug (root: tenant-unique). The DB indexes are the hard
   *  guarantee; this returns a clean 409 instead of a raw unique violation. */
  private async assertSlugFree(
    tx: ScopedTx,
    parentId: string | null,
    slug: string,
    selfId: string | null,
  ): Promise<void> {
    const clash = await tx.category.findFirst({
      where: { slug, parentId, ...(selfId ? { id: { not: selfId } } : {}) },
      select: { id: true },
    });
    if (clash) {
      throw new DomainError(
        'CATEGORY_SLUG_TAKEN',
        parentId === null
          ? `a root category with slug "${slug}" already exists`
          : `a sibling category with slug "${slug}" already exists`,
        409,
      );
    }
  }
}

async function lockCategory(tx: ScopedTx, id: string): Promise<LockedCategory> {
  const rows = await tx.$queryRaw<LockedCategory[]>`
    SELECT "version", "status", "parentId", "slug", "sortOrder", "nameEn"
      FROM "category" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('category');
  return rows[0]!;
}
