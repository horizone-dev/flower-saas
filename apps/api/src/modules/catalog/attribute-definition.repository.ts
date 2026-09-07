import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import type { AttributeValueType } from '@flower/shared-types';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import { assertAtMostOneScope, assertValidAttributeKey } from './attribute.helpers.js';

export interface AttributeOptionRow {
  id: string;
  value: string;
  labelEn: string;
  labelAr: string | null;
  sortOrder: number;
}

export interface AttributeDefinitionRow {
  id: string;
  key: string;
  nameEn: string;
  nameAr: string | null;
  valueType: string;
  appliesToCategoryId: string | null;
  appliesToProductTypeId: string | null;
  unitHint: string | null;
  isVariantOption: boolean;
  required: boolean;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttributeDefinitionWithOptions extends AttributeDefinitionRow {
  options: AttributeOptionRow[];
}

const DEF_SELECT = {
  id: true,
  key: true,
  nameEn: true,
  nameAr: true,
  valueType: true,
  appliesToCategoryId: true,
  appliesToProductTypeId: true,
  unitHint: true,
  isVariantOption: true,
  required: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const OPT_SELECT = {
  id: true,
  value: true,
  labelEn: true,
  labelAr: true,
  sortOrder: true,
} as const;

export interface CreateDefinitionInput {
  key: string;
  nameEn: string;
  nameAr?: string | null | undefined;
  valueType: AttributeValueType;
  appliesToCategoryId?: string | null | undefined;
  appliesToProductTypeId?: string | null | undefined;
  unitHint?: string | null | undefined;
  isVariantOption?: boolean | undefined;
  required?: boolean | undefined;
}

/** `key` + `valueType` are immutable (data-integrity rule 2) — not in the input. */
export interface UpdateDefinitionInput {
  nameEn?: string | undefined;
  nameAr?: string | null | undefined;
  unitHint?: string | null | undefined;
  isVariantOption?: boolean | undefined;
  required?: boolean | undefined;
  appliesToCategoryId?: string | null | undefined;
  appliesToProductTypeId?: string | null | undefined;
}

export interface OptionInput {
  value: string;
  labelEn: string;
  labelAr?: string | null | undefined;
  sortOrder?: number | undefined;
}

interface LockedDefinition {
  version: number;
  valueType: string;
  status: string;
  key: string;
  appliesToCategoryId: string | null;
  appliesToProductTypeId: string | null;
}

/**
 * Tenant typed attribute definitions + their ENUM options (task 3.3). Options are
 * a parent-controlled replace-set (owner K.4) — no standalone option lifecycle.
 * RLS-scoped; no method names a tenant id. Optimistic concurrency: `version int`,
 * `FOR UPDATE` + `If-Match`.
 */
@Injectable()
export class AttributeDefinitionRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  list(filter: {
    status?: string | undefined;
    appliesToCategoryId?: string | undefined;
    appliesToProductTypeId?: string | undefined;
    valueType?: string | undefined;
    isVariantOption?: boolean | undefined;
    q?: string | undefined;
  }): Promise<AttributeDefinitionRow[]> {
    return this.scoped((tx) =>
      tx.attributeDefinition.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.appliesToCategoryId
            ? { appliesToCategoryId: filter.appliesToCategoryId }
            : {}),
          ...(filter.appliesToProductTypeId
            ? { appliesToProductTypeId: filter.appliesToProductTypeId }
            : {}),
          ...(filter.valueType ? { valueType: filter.valueType } : {}),
          ...(filter.isVariantOption !== undefined
            ? { isVariantOption: filter.isVariantOption }
            : {}),
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
        select: DEF_SELECT,
      }),
    );
  }

  get(id: string): Promise<AttributeDefinitionWithOptions> {
    return this.scoped(async (tx) => {
      const row = await tx.attributeDefinition.findUnique({
        where: { id },
        select: { ...DEF_SELECT, options: { orderBy: { sortOrder: 'asc' }, select: OPT_SELECT } },
      });
      if (!row) throw new NotFoundError('attribute definition');
      return row;
    });
  }

  async create(input: CreateDefinitionInput): Promise<AttributeDefinitionWithOptions> {
    assertValidAttributeKey(input.key);
    assertAtMostOneScope(input.appliesToCategoryId, input.appliesToProductTypeId);
    const categoryId = input.appliesToCategoryId ?? null;
    const productTypeId = input.appliesToProductTypeId ?? null;

    return this.scoped(async (tx) => {
      const clash = await tx.attributeDefinition.findUnique({
        where: { tenantId_key: { tenantId: requireTenantContext().tenantId, key: input.key } },
        select: { id: true },
      });
      if (clash) {
        throw new DomainError(
          'ATTRIBUTE_KEY_TAKEN',
          `an attribute definition with key "${input.key}" already exists`,
          409,
        );
      }
      await assertScopeRefsActive(tx, categoryId, productTypeId);

      const created = await tx.attributeDefinition.create({
        data: {
          tenantId: requireTenantContext().tenantId,
          key: input.key,
          nameEn: input.nameEn,
          nameAr: input.nameAr ?? null,
          valueType: input.valueType,
          appliesToCategoryId: categoryId,
          appliesToProductTypeId: productTypeId,
          unitHint: input.unitHint ?? null,
          isVariantOption: input.isVariantOption ?? false,
          required: input.required ?? false,
        },
        select: { ...DEF_SELECT, options: { select: OPT_SELECT } },
      });
      await this.audit.record(tx, {
        action: 'catalog.attribute_definition_created',
        resourceType: 'attribute_definition',
        resourceId: created.id,
        after: { key: created.key, valueType: created.valueType },
      });
      return created;
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateDefinitionInput,
  ): Promise<AttributeDefinitionWithOptions> {
    return this.scoped(async (tx) => {
      const current = await lockDefinition(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('attribute_definition', expectedVersion, current.version);
      }

      const scopeGiven =
        input.appliesToCategoryId !== undefined || input.appliesToProductTypeId !== undefined;
      const nextCategoryId =
        input.appliesToCategoryId === undefined
          ? current.appliesToCategoryId
          : (input.appliesToCategoryId ?? null);
      const nextProductTypeId =
        input.appliesToProductTypeId === undefined
          ? current.appliesToProductTypeId
          : (input.appliesToProductTypeId ?? null);
      const scopeChanged =
        nextCategoryId !== current.appliesToCategoryId ||
        nextProductTypeId !== current.appliesToProductTypeId;

      if (scopeChanged) {
        // data-integrity rule 2: a scope change is rejected once any value exists
        const inUse = await tx.productAttributeValue.count({
          where: { attributeDefinitionId: id },
        });
        if (inUse > 0) {
          throw new DomainError(
            'ATTRIBUTE_SCOPE_LOCKED',
            'the attribute definition already has product values — its scope cannot change',
            409,
          );
        }
        assertAtMostOneScope(nextCategoryId, nextProductTypeId);
        await assertScopeRefsActive(tx, nextCategoryId, nextProductTypeId);
      }

      const updated = await tx.attributeDefinition.update({
        where: { id },
        data: {
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.nameAr !== undefined ? { nameAr: input.nameAr ?? null } : {}),
          ...(input.unitHint !== undefined ? { unitHint: input.unitHint ?? null } : {}),
          ...(input.isVariantOption !== undefined
            ? { isVariantOption: input.isVariantOption }
            : {}),
          ...(input.required !== undefined ? { required: input.required } : {}),
          ...(scopeGiven
            ? { appliesToCategoryId: nextCategoryId, appliesToProductTypeId: nextProductTypeId }
            : {}),
          version: { increment: 1 },
        },
        select: { ...DEF_SELECT, options: { orderBy: { sortOrder: 'asc' }, select: OPT_SELECT } },
      });
      await this.audit.record(tx, {
        action: 'catalog.attribute_definition_updated',
        resourceType: 'attribute_definition',
        resourceId: id,
        ...(scopeChanged
          ? {
              before: {
                appliesToCategoryId: current.appliesToCategoryId,
                appliesToProductTypeId: current.appliesToProductTypeId,
              },
              after: {
                appliesToCategoryId: nextCategoryId,
                appliesToProductTypeId: nextProductTypeId,
              },
            }
          : {}),
      });
      return updated;
    });
  }

  async setStatus(
    id: string,
    expectedVersion: number,
    next: 'ACTIVE' | 'ARCHIVED',
  ): Promise<AttributeDefinitionWithOptions> {
    return this.scoped(async (tx) => {
      const current = await lockDefinition(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('attribute_definition', expectedVersion, current.version);
      }
      if (current.status === next) return this.getInTx(tx, id);

      const updated = await tx.attributeDefinition.update({
        where: { id },
        data: { status: next, version: { increment: 1 } },
        select: { ...DEF_SELECT, options: { orderBy: { sortOrder: 'asc' }, select: OPT_SELECT } },
      });
      await this.audit.record(tx, {
        action: 'catalog.attribute_definition_status_changed',
        resourceType: 'attribute_definition',
        resourceId: id,
        before: { status: current.status },
        after: { status: next },
      });
      return updated;
    });
  }

  /** Hard delete — only an ACTIVE definition with zero product values (its ENUM
   *  options cascade). Otherwise archive (owner K.1). */
  async remove(id: string, expectedVersion: number): Promise<void> {
    await this.scoped(async (tx) => {
      const current = await lockDefinition(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('attribute_definition', expectedVersion, current.version);
      }
      if (current.status !== 'ACTIVE') {
        throw new DomainError(
          'ATTRIBUTE_DEFINITION_NOT_DELETABLE',
          'only an ACTIVE attribute definition can be hard-deleted; archive it instead',
          409,
        );
      }
      const inUse = await tx.productAttributeValue.count({ where: { attributeDefinitionId: id } });
      if (inUse > 0) {
        throw new DomainError(
          'ATTRIBUTE_DEFINITION_IN_USE',
          'the attribute definition has product values',
          409,
        );
      }
      await tx.attributeDefinition.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'catalog.attribute_definition_deleted',
        resourceType: 'attribute_definition',
        resourceId: id,
        before: { key: current.key, valueType: current.valueType },
      });
    });
  }

  /**
   * Replace the ENUM option-set (owner K.4). `If-Match` = the DEFINITION version;
   * a successful replace bumps it once. Removing an option still referenced by a
   * `product_attribute_value` fails with no partial mutation.
   */
  async replaceOptions(
    id: string,
    expectedVersion: number,
    options: OptionInput[],
  ): Promise<AttributeDefinitionWithOptions> {
    // dedupe check up front
    const seen = new Set<string>();
    for (const o of options) {
      if (seen.has(o.value)) {
        throw new DomainError(
          'DUPLICATE_ATTRIBUTE_OPTION',
          `option value "${o.value}" appears more than once`,
          422,
        );
      }
      seen.add(o.value);
    }

    return this.scoped(async (tx) => {
      const current = await lockDefinition(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('attribute_definition', expectedVersion, current.version);
      }
      if (current.valueType !== 'ENUM') {
        throw new DomainError(
          'ATTRIBUTE_NOT_ENUM',
          'only an ENUM attribute definition has options',
          422,
        );
      }
      if (current.status !== 'ACTIVE') {
        throw new DomainError(
          'ATTRIBUTE_DEFINITION_ARCHIVED',
          'activate the attribute definition before changing its option set',
          409,
        );
      }

      const existing = await tx.attributeOption.findMany({
        where: { attributeDefinitionId: id },
        select: { id: true, value: true },
      });
      const byValue = new Map(existing.map((e) => [e.value, e.id]));
      const desired = new Set(options.map((o) => o.value));
      const removedIds = existing.filter((e) => !desired.has(e.value)).map((e) => e.id);

      if (removedIds.length > 0) {
        const refs = await tx.productAttributeValue.count({
          where: { optionId: { in: removedIds } },
        });
        if (refs > 0) {
          throw new DomainError(
            'ATTRIBUTE_OPTION_IN_USE',
            'an option being removed is still referenced by a product value',
            409,
          );
        }
        await tx.attributeOption.deleteMany({ where: { id: { in: removedIds } } });
      }

      for (const o of options) {
        const existingId = byValue.get(o.value);
        if (existingId) {
          await tx.attributeOption.update({
            where: { id: existingId },
            data: {
              labelEn: o.labelEn,
              labelAr: o.labelAr ?? null,
              sortOrder: o.sortOrder ?? 0,
            },
          });
        } else {
          await tx.attributeOption.create({
            data: {
              tenantId: requireTenantContext().tenantId,
              attributeDefinitionId: id,
              value: o.value,
              labelEn: o.labelEn,
              labelAr: o.labelAr ?? null,
              sortOrder: o.sortOrder ?? 0,
            },
          });
        }
      }

      const updated = await tx.attributeDefinition.update({
        where: { id },
        data: { version: { increment: 1 } },
        select: { ...DEF_SELECT, options: { orderBy: { sortOrder: 'asc' }, select: OPT_SELECT } },
      });
      await this.audit.record(tx, {
        action: 'catalog.attribute_option_set_changed',
        resourceType: 'attribute_definition',
        resourceId: id,
        before: { optionCount: existing.length },
        after: { optionCount: options.length },
      });
      return updated;
    });
  }

  private getInTx(tx: ScopedTx, id: string): Promise<AttributeDefinitionWithOptions> {
    return tx.attributeDefinition
      .findUnique({
        where: { id },
        select: { ...DEF_SELECT, options: { orderBy: { sortOrder: 'asc' }, select: OPT_SELECT } },
      })
      .then((r) => {
        if (!r) throw new NotFoundError('attribute definition');
        return r;
      });
  }
}

async function lockDefinition(tx: ScopedTx, id: string): Promise<LockedDefinition> {
  const rows = await tx.$queryRaw<LockedDefinition[]>`
    SELECT "version", "valueType", "status", "key",
           "appliesToCategoryId", "appliesToProductTypeId"
      FROM "attribute_definition" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('attribute definition');
  return rows[0]!;
}

async function assertScopeRefsActive(
  tx: ScopedTx,
  categoryId: string | null,
  productTypeId: string | null,
): Promise<void> {
  if (categoryId !== null) {
    const c = await tx.category.findUnique({ where: { id: categoryId }, select: { status: true } });
    if (!c) throw new NotFoundError('category');
    if (c.status !== 'ACTIVE') {
      throw new DomainError('CATEGORY_ARCHIVED', 'the scope category is archived', 409);
    }
  }
  if (productTypeId !== null) {
    const p = await tx.productType.findUnique({
      where: { id: productTypeId },
      select: { status: true },
    });
    if (!p) throw new NotFoundError('product type');
    if (p.status !== 'ACTIVE') {
      throw new DomainError('PRODUCT_TYPE_ARCHIVED', 'the scope product type is archived', 409);
    }
  }
}

/**
 * The ACTIVE, in-scope attribute definitions for a product — global (both scope
 * refs null) ∪ exact category match ∪ exact product-type match. EXACT category
 * match only — no descendant inheritance (owner K.7). Used by the product
 * attribute replace-set + the required-completeness check.
 */
export function inScopeActiveDefinitions(
  tx: ScopedTx,
  categoryId: string,
  productTypeId: string | null,
): Promise<{ id: string; key: string; valueType: string; required: boolean }[]> {
  return tx.attributeDefinition.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { appliesToCategoryId: null, appliesToProductTypeId: null },
        { appliesToCategoryId: categoryId },
        ...(productTypeId ? [{ appliesToProductTypeId: productTypeId }] : []),
      ],
    },
    select: { id: true, key: true, valueType: true, required: true },
  });
}

/**
 * Keys of ACTIVE, in-scope, `required` attribute definitions that the product
 * has no `product_attribute_value` for (owner K.2). Empty ⇒ complete.
 */
export async function requiredAttributeGap(
  tx: ScopedTx,
  productId: string,
  categoryId: string,
  productTypeId: string | null,
): Promise<string[]> {
  const inScope = await inScopeActiveDefinitions(tx, categoryId, productTypeId);
  const required = inScope.filter((d) => d.required);
  if (required.length === 0) return [];
  const present = await tx.productAttributeValue.findMany({
    where: { productId, attributeDefinitionId: { in: required.map((d) => d.id) } },
    select: { attributeDefinitionId: true },
  });
  const have = new Set(present.map((p) => p.attributeDefinitionId));
  return required.filter((d) => !have.has(d.id)).map((d) => d.key);
}
