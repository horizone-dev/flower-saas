import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { OPTION_VALUE_RE } from '@flower/shared-types';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import { assertValidOptionGroupKey } from './variant.helpers.js';
import {
  createDefaultVariant,
  nonDefaultVariantExists,
  removeDefaultVariantForRestructure,
} from './variant.repository.js';

export interface OptionValueRow {
  id: string;
  value: string;
  labelEn: string;
  labelAr: string | null;
  sortOrder: number;
}

export interface OptionGroupRow {
  id: string;
  productId: string;
  key: string;
  nameEn: string;
  nameAr: string | null;
  sortOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OptionGroupWithValues extends OptionGroupRow {
  values: OptionValueRow[];
}

const G_SELECT = {
  id: true,
  productId: true,
  key: true,
  nameEn: true,
  nameAr: true,
  sortOrder: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const V_SELECT = {
  id: true,
  value: true,
  labelEn: true,
  labelAr: true,
  sortOrder: true,
} as const;

export interface CreateOptionGroupInput {
  key: string;
  nameEn: string;
  nameAr?: string | null | undefined;
  sortOrder?: number | undefined;
}

export interface UpdateOptionGroupInput {
  nameEn?: string | undefined;
  nameAr?: string | null | undefined;
  sortOrder?: number | undefined;
}

export interface OptionValueInput {
  value: string;
  labelEn: string;
  labelAr?: string | null | undefined;
  sortOrder?: number | undefined;
}

interface LockedGroup {
  version: number;
  productId: string;
  key: string;
}

/**
 * Per-product variant dimensions (task 3.4). INDEPENDENT of
 * `attribute_definition` (owner L-5). `key` is immutable; values are a
 * parent-controlled replace-set guarded by `option_group.version` (owner L-11 /
 * L-12). Structural changes (add / remove a group) only while the product is
 * DRAFT and has no explicit variants. RLS-scoped; `tenant.businessTypeKey` is
 * never read (HG3-NO-BT-BRANCH).
 */
@Injectable()
export class OptionGroupRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  listForProduct(productId: string): Promise<OptionGroupWithValues[]> {
    return this.scoped(async (tx) => {
      await assertProductExists(tx, productId);
      return tx.optionGroup.findMany({
        where: { productId },
        orderBy: { sortOrder: 'asc' },
        select: { ...G_SELECT, values: { orderBy: { sortOrder: 'asc' }, select: V_SELECT } },
      });
    });
  }

  async create(productId: string, input: CreateOptionGroupInput): Promise<OptionGroupWithValues> {
    assertValidOptionGroupKey(input.key);
    return this.scoped(async (tx) => {
      const product = await lockProduct(tx, productId);
      if (product.status !== 'DRAFT') {
        throw new DomainError(
          'PRODUCT_NOT_DRAFT',
          'option groups can only be added while the product is a DRAFT',
          409,
        );
      }
      const clash = await tx.optionGroup.findFirst({
        where: { productId, key: input.key },
        select: { id: true },
      });
      if (clash) {
        throw new DomainError(
          'OPTION_GROUP_KEY_TAKEN',
          `an option group with key "${input.key}" already exists on this product`,
          409,
        );
      }
      if (await nonDefaultVariantExists(tx, productId)) {
        throw new DomainError(
          'PRODUCT_HAS_VARIANTS',
          'the option-group set cannot change once the product has explicit variants',
          409,
        );
      }
      // owner L-4 — the first option group consumes the auto-created default
      // variant; explicit variant creation is then left to the Owner.
      await removeDefaultVariantForRestructure(tx, productId);

      const created = await tx.optionGroup.create({
        data: {
          tenantId: requireTenantContext().tenantId,
          productId,
          key: input.key,
          nameEn: input.nameEn,
          nameAr: input.nameAr ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'catalog.option_group_created',
        resourceType: 'option_group',
        resourceId: created.id,
        after: { productId, key: input.key },
      });
      return this.getInTx(tx, created.id);
    });
  }

  async update(
    productId: string,
    groupId: string,
    expectedVersion: number,
    input: UpdateOptionGroupInput,
  ): Promise<OptionGroupWithValues> {
    return this.scoped(async (tx) => {
      const current = await lockGroup(tx, groupId);
      if (current.productId !== productId) throw new NotFoundError('option group');
      if (expectedVersion !== current.version) {
        throw versionConflict('option_group', expectedVersion, current.version);
      }
      await tx.optionGroup.update({
        where: { id: groupId },
        data: {
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.nameAr !== undefined ? { nameAr: input.nameAr ?? null } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'catalog.option_group_updated',
        resourceType: 'option_group',
        resourceId: groupId,
      });
      return this.getInTx(tx, groupId);
    });
  }

  /** Replace the value-set (owner L-11). `If-Match` = the group version; a
   *  successful replace bumps it once. Existing rows keep their id (labels /
   *  order updated in place); a removed value still referenced by a variant
   *  fails atomically. */
  async replaceValues(
    productId: string,
    groupId: string,
    expectedVersion: number,
    values: OptionValueInput[],
  ): Promise<OptionGroupWithValues> {
    const seen = new Set<string>();
    for (const v of values) {
      if (!OPTION_VALUE_RE.test(v.value)) {
        throw new DomainError('INVALID_OPTION_VALUE', `invalid option value "${v.value}"`, 422, [
          { field: 'value', issue: 'invalid format' },
        ]);
      }
      if (seen.has(v.value)) {
        throw new DomainError(
          'DUPLICATE_OPTION_VALUE',
          `option value "${v.value}" appears more than once`,
          422,
        );
      }
      seen.add(v.value);
    }

    return this.scoped(async (tx) => {
      const current = await lockGroup(tx, groupId);
      if (current.productId !== productId) throw new NotFoundError('option group');
      if (expectedVersion !== current.version) {
        throw versionConflict('option_group', expectedVersion, current.version);
      }

      const existing = await tx.optionValue.findMany({
        where: { optionGroupId: groupId },
        select: { id: true, value: true },
      });
      const byValue = new Map(existing.map((e) => [e.value, e.id]));
      const desired = new Set(values.map((v) => v.value));
      const removedIds = existing.filter((e) => !desired.has(e.value)).map((e) => e.id);

      if (removedIds.length > 0) {
        const refs = await tx.variantOptionValue.count({
          where: { optionValueId: { in: removedIds } },
        });
        if (refs > 0) {
          throw new DomainError(
            'OPTION_VALUE_IN_USE',
            'an option value being removed is still referenced by a variant',
            409,
          );
        }
        await tx.optionValue.deleteMany({ where: { id: { in: removedIds } } });
      }

      for (const v of values) {
        const existingId = byValue.get(v.value);
        if (existingId) {
          await tx.optionValue.update({
            where: { id: existingId },
            data: { labelEn: v.labelEn, labelAr: v.labelAr ?? null, sortOrder: v.sortOrder ?? 0 },
          });
        } else {
          await tx.optionValue.create({
            data: {
              tenantId: requireTenantContext().tenantId,
              optionGroupId: groupId,
              value: v.value,
              labelEn: v.labelEn,
              labelAr: v.labelAr ?? null,
              sortOrder: v.sortOrder ?? 0,
            },
          });
        }
      }

      await tx.optionGroup.update({
        where: { id: groupId },
        data: { version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'catalog.option_value_set_changed',
        resourceType: 'option_group',
        resourceId: groupId,
        before: { valueCount: existing.length },
        after: { valueCount: values.length },
      });
      return this.getInTx(tx, groupId);
    });
  }

  /** Remove an option group — only while the product is DRAFT with no explicit
   *  variants and nothing referencing the group's values (owner L-11). When the
   *  last group goes, the default variant is recreated (owner L-4). */
  async remove(
    productId: string,
    groupId: string,
    expectedVersion: number,
  ): Promise<{ recreatedDefaultVariant: boolean }> {
    return this.scoped(async (tx) => {
      const current = await lockGroup(tx, groupId);
      if (current.productId !== productId) throw new NotFoundError('option group');
      if (expectedVersion !== current.version) {
        throw versionConflict('option_group', expectedVersion, current.version);
      }
      const product = await lockProduct(tx, productId);
      if (product.status !== 'DRAFT') {
        throw new DomainError(
          'PRODUCT_NOT_DRAFT',
          'option groups can only be removed while the product is a DRAFT',
          409,
        );
      }
      if (await nonDefaultVariantExists(tx, productId)) {
        throw new DomainError(
          'PRODUCT_HAS_VARIANTS',
          'the option-group set cannot change once the product has explicit variants',
          409,
        );
      }
      const inUse = await tx.variantOptionValue.count({ where: { optionGroupId: groupId } });
      if (inUse > 0) {
        throw new DomainError(
          'OPTION_GROUP_IN_USE',
          'the option group is referenced by a variant',
          409,
        );
      }

      await tx.optionGroup.delete({ where: { id: groupId } });

      let recreatedDefaultVariant = false;
      const remaining = await tx.optionGroup.count({ where: { productId } });
      if (remaining === 0 && !(await nonDefaultVariantExists(tx, productId))) {
        await createDefaultVariant(tx, {
          id: product.id,
          nameEn: product.nameEn,
          nameAr: product.nameAr,
        });
        recreatedDefaultVariant = true;
      }

      await this.audit.record(tx, {
        action: 'catalog.option_group_deleted',
        resourceType: 'option_group',
        resourceId: groupId,
        before: { productId, key: current.key },
      });
      return { recreatedDefaultVariant };
    });
  }

  private getInTx(tx: ScopedTx, id: string): Promise<OptionGroupWithValues> {
    return tx.optionGroup
      .findUnique({
        where: { id },
        select: { ...G_SELECT, values: { orderBy: { sortOrder: 'asc' }, select: V_SELECT } },
      })
      .then((r) => {
        if (!r) throw new NotFoundError('option group');
        return r;
      });
  }
}

async function assertProductExists(tx: ScopedTx, productId: string): Promise<void> {
  const p = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!p) throw new NotFoundError('product');
}

async function lockProduct(
  tx: ScopedTx,
  id: string,
): Promise<{ id: string; status: string; nameEn: string; nameAr: string | null }> {
  const rows = await tx.$queryRaw<{ status: string; nameEn: string; nameAr: string | null }[]>`
    SELECT "status", "nameEn", "nameAr" FROM "product" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('product');
  return { id, ...rows[0]! };
}

async function lockGroup(tx: ScopedTx, id: string): Promise<LockedGroup> {
  const rows = await tx.$queryRaw<LockedGroup[]>`
    SELECT "version", "productId", "key" FROM "option_group" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('option group');
  return rows[0]!;
}
