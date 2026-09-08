import { Injectable } from '@nestjs/common';
import type { Prisma, ScopedTx } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import { assertVariantHasNoIdentifiers } from './identifier.repository.js';
import { UomRepository } from './uom.repository.js';
import {
  buildRegistry,
  isBuiltinUom,
  mapUomError,
  requireUomCode,
  toUomDef,
} from './uom.helpers.js';
import {
  deriveVariantName,
  resolveVariantCombination,
  type VariantOptionInput,
} from './variant.helpers.js';

export interface VariantOptionValueRow {
  optionGroupId: string;
  optionGroupKey: string;
  optionValueId: string;
  optionValue: string;
}

export interface VariantRow {
  id: string;
  productId: string;
  nameEn: string;
  nameAr: string | null;
  sortOrder: number;
  isDefault: boolean;
  optionSignature: string;
  status: string;
  baseUomCode: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VariantWithOptions extends VariantRow {
  options: VariantOptionValueRow[];
}

const V_SELECT = {
  id: true,
  productId: true,
  nameEn: true,
  nameAr: true,
  sortOrder: true,
  isDefault: true,
  optionSignature: true,
  status: true,
  baseUomCode: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateVariantInput {
  optionValues: VariantOptionInput[];
  nameEn?: string | undefined;
  nameAr?: string | null | undefined;
  sortOrder?: number | undefined;
}

export interface UpdateVariantInput {
  nameEn?: string | undefined;
  nameAr?: string | null | undefined;
  sortOrder?: number | undefined;
  /** a combination change — honoured ONLY while the variant is DRAFT and not the
   *  default (owner "variant identity immutability"). */
  optionValues?: VariantOptionInput[] | undefined;
}

interface LockedVariant {
  version: number;
  status: string;
  isDefault: boolean;
  optionSignature: string;
  productId: string;
  nameEn: string;
  baseUomCode: string | null;
}

interface ProductGroups {
  productId: string;
  productStatus: string;
  productNameEn: string;
  groups: { id: string; key: string; sortOrder: number; valueIds: Set<string> }[];
  valueLabel: Map<string, { labelEn: string; value: string }>;
}

/**
 * Tenant catalog variants + their option selections (task 3.4). A `variant`
 * carries NO price / currency / sku / base-UOM / stock column — ever (D2-2).
 * RLS-scoped. Optimistic concurrency: `version int`, `FOR UPDATE` + `If-Match`.
 * `tenant.businessTypeKey` is NEVER read (HG3-NO-BT-BRANCH) — behaviour is
 * `product.fulfilmentStrategy` + the `variants` capability + configured data.
 */
@Injectable()
export class VariantRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  listForProduct(productId: string): Promise<VariantRow[]> {
    return this.scoped(async (tx) => {
      await assertProductExists(tx, productId);
      return tx.variant.findMany({
        where: { productId },
        orderBy: [{ sortOrder: 'asc' }, { optionSignature: 'asc' }],
        select: V_SELECT,
      });
    });
  }

  get(id: string): Promise<VariantWithOptions> {
    return this.scoped((tx) => this.getInTx(tx, id));
  }

  async create(productId: string, input: CreateVariantInput): Promise<VariantWithOptions> {
    return this.scoped(async (tx) => {
      const ctx = await lockProductGroups(tx, productId);
      if (ctx.groups.length === 0) {
        throw new DomainError(
          'PRODUCT_HAS_NO_OPTION_GROUPS',
          'add option groups before creating explicit variants (a simple product has one default variant)',
          422,
        );
      }
      const { signature, pairs } = resolveVariantCombination(
        ctx.groups.map((g) => ({ id: g.id, valueIds: g.valueIds })),
        input.optionValues,
      );
      await assertSignatureFree(tx, productId, signature, null);

      const nameEn =
        input.nameEn && input.nameEn.length > 0
          ? input.nameEn
          : deriveVariantName(
              pairs.map((p) => {
                const g = ctx.groups.find((x) => x.id === p.optionGroupId)!;
                return {
                  groupSortOrder: g.sortOrder,
                  groupKey: g.key,
                  labelEn: ctx.valueLabel.get(p.optionValueId)!.labelEn,
                };
              }),
              ctx.productNameEn,
            );

      const created = await tx.variant.create({
        data: {
          tenantId: requireTenantContext().tenantId,
          productId,
          nameEn,
          nameAr: input.nameAr ?? null,
          sortOrder: input.sortOrder ?? 0,
          isDefault: false,
          optionSignature: signature,
          status: 'DRAFT',
        },
        select: { id: true },
      });
      await tx.variantOptionValue.createMany({
        data: pairs.map((p) => ({
          tenantId: requireTenantContext().tenantId,
          productId,
          variantId: created.id,
          optionGroupId: p.optionGroupId,
          optionValueId: p.optionValueId,
        })),
      });
      await this.audit.record(tx, {
        action: 'catalog.variant_created',
        resourceType: 'variant',
        resourceId: created.id,
        after: { productId, optionSignature: signature, status: 'DRAFT' },
      });
      return this.getInTx(tx, created.id);
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateVariantInput,
  ): Promise<VariantWithOptions> {
    return this.scoped(async (tx) => {
      const current = await lockVariant(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('variant', expectedVersion, current.version);
      }

      const changingCombination = input.optionValues !== undefined;
      let nextSignature = current.optionSignature;
      let derivedName: string | null = null;

      if (changingCombination) {
        if (current.status !== 'DRAFT') {
          throw new DomainError(
            'VARIANT_IDENTITY_LOCKED',
            'a variant option combination can only change while the variant is a DRAFT',
            409,
          );
        }
        if (current.isDefault) {
          throw new DomainError(
            'VARIANT_IDENTITY_LOCKED',
            'the default variant has no option combination',
            409,
          );
        }
        const ctx = await lockProductGroups(tx, current.productId);
        const { signature, pairs } = resolveVariantCombination(
          ctx.groups.map((g) => ({ id: g.id, valueIds: g.valueIds })),
          input.optionValues!,
        );
        await assertSignatureFree(tx, current.productId, signature, id);
        nextSignature = signature;
        derivedName = deriveVariantName(
          pairs.map((p) => {
            const g = ctx.groups.find((x) => x.id === p.optionGroupId)!;
            return {
              groupSortOrder: g.sortOrder,
              groupKey: g.key,
              labelEn: ctx.valueLabel.get(p.optionValueId)!.labelEn,
            };
          }),
          ctx.productNameEn,
        );
        await tx.variantOptionValue.deleteMany({ where: { variantId: id } });
        await tx.variantOptionValue.createMany({
          data: pairs.map((p) => ({
            tenantId: requireTenantContext().tenantId,
            productId: current.productId,
            variantId: id,
            optionGroupId: p.optionGroupId,
            optionValueId: p.optionValueId,
          })),
        });
      }

      const data: Prisma.VariantUncheckedUpdateInput = { version: { increment: 1 } };
      if (input.nameEn !== undefined && input.nameEn.length > 0) data.nameEn = input.nameEn;
      else if (changingCombination && derivedName !== null) data.nameEn = derivedName;
      if (input.nameAr !== undefined) data.nameAr = input.nameAr ?? null;
      if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
      if (changingCombination) data.optionSignature = nextSignature;

      await tx.variant.update({ where: { id }, data });
      await this.audit.record(tx, {
        action: 'catalog.variant_updated',
        resourceType: 'variant',
        resourceId: id,
        ...(changingCombination
          ? {
              before: { optionSignature: current.optionSignature },
              after: { optionSignature: nextSignature },
            }
          : {}),
      });
      return this.getInTx(tx, id);
    });
  }

  activate(id: string, expectedVersion: number): Promise<VariantWithOptions> {
    return this.transition(id, expectedVersion, 'ACTIVE');
  }

  archive(id: string, expectedVersion: number): Promise<VariantWithOptions> {
    return this.transition(id, expectedVersion, 'ARCHIVED');
  }

  private transition(
    id: string,
    expectedVersion: number,
    next: 'ACTIVE' | 'ARCHIVED',
  ): Promise<VariantWithOptions> {
    return this.scoped(async (tx) => {
      const current = await lockVariant(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('variant', expectedVersion, current.version);
      }
      if (current.status === next) return this.getInTx(tx, id);

      if (next === 'ACTIVE') {
        const product = await tx.product.findUnique({
          where: { id: current.productId },
          select: { status: true, fulfilmentStrategy: true },
        });
        if (!product) throw new NotFoundError('product');
        if (product.status !== 'ACTIVE') {
          throw new DomainError(
            'PRODUCT_NOT_ACTIVE',
            'the product must be ACTIVE before a variant can be activated',
            409,
          );
        }
        // task 3.6 (owner OD-G) — a STOCKED / BOM variant is quantity-tracked and
        // needs an authoritative base UOM before it can reach ACTIVE (covers both
        // DRAFT→ACTIVE and ARCHIVED→ACTIVE reactivation). CUSTOM may stay without
        // a base. This reads `product.fulfilmentStrategy`, NEVER
        // `tenant.businessTypeKey` (HG3-NO-BT-BRANCH).
        if (
          (product.fulfilmentStrategy === 'STOCKED' || product.fulfilmentStrategy === 'BOM') &&
          current.baseUomCode === null
        ) {
          throw new DomainError(
            'VARIANT_BASE_UOM_REQUIRED',
            'set the variant base UOM before activating a STOCKED / BOM variant',
            409,
          );
        }
        // owner L-7 — reactivating an archived variant whose combination is now
        // taken by another non-archived variant → 409, no mutation, no audit.
        await assertSignatureFree(tx, current.productId, current.optionSignature, id);
      }

      await tx.variant.update({
        where: { id },
        data: { status: next, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'catalog.variant_status_changed',
        resourceType: 'variant',
        resourceId: id,
        before: { status: current.status },
        after: { status: next },
      });
      return this.getInTx(tx, id);
    });
  }

  /**
   * Set / change the variant base UOM (task 3.6 §H). Lifecycle:
   *   - NULL → a valid code: one-time initialization — allowed for a DRAFT **or a
   *     legacy ACTIVE** variant, but ONLY while it has zero conversions and zero
   *     pack identifiers (ACTIVE or INACTIVE).
   *   - non-NULL → a different non-NULL code: only while DRAFT, zero conversions,
   *     zero pack identifiers of any status.
   *   - non-NULL → NULL: never (`VARIANT_BASE_UOM_LOCKED`).
   * A successful change bumps `variant.version` and emits
   * `catalog.variant_base_uom_set` (owner OD-F). Any tenant-custom `code` is
   * `FOR KEY SHARE`-locked (owner FINAL CORRECTION 2). The `multi_uom` gate for a
   * custom code lives in `VariantUomService`.
   */
  async setBaseUom(
    id: string,
    expectedVersion: number,
    rawCode: string,
  ): Promise<VariantWithOptions> {
    const code = requireUomCode(rawCode);
    return this.scoped(async (tx) => {
      const current = await lockVariant(tx, id);
      if (expectedVersion !== current.version) {
        throw versionConflict('variant', expectedVersion, current.version);
      }
      if (current.baseUomCode === code) return this.getInTx(tx, id); // idempotent no-op

      const [convCount, packCount, priceCount] = await Promise.all([
        tx.uomConversion.count({ where: { scopeKind: 'VARIANT', scopeId: id } }),
        tx.itemIdentifier.count({
          where: { targetKind: 'VARIANT', targetId: id, packUomCode: { not: null } },
        }),
        // task 3.7 (Inv-1) — a `company_variant_uom_price` row for this variant,
        // across ANY company. Once any company price exists, the base UOM is
        // frozen (existing prices must not be silently reinterpreted under a new
        // base). To change the base: `PUT …/prices []` for every pricing company,
        // then the rules below apply again. Only price ROWS block — the retained
        // empty `company_variant_price_set` aggregate does not.
        tx.companyVariantUomPrice.count({ where: { variantId: id } }),
      ]);

      if (priceCount > 0) {
        throw new DomainError(
          'VARIANT_BASE_UOM_LOCKED',
          'this variant has company prices — remove every company price row (PUT …/prices []) before changing its base UOM',
          409,
        );
      }

      if (current.baseUomCode === null) {
        // one-time initialization — DRAFT or legacy ACTIVE, but nothing may depend on it yet
        if (convCount > 0 || packCount > 0) {
          throw new DomainError(
            'VARIANT_BASE_UOM_LOCKED',
            'this variant already has conversions or pack identifiers — its base UOM can no longer be initialized',
            409,
          );
        }
      } else {
        // non-NULL → different non-NULL: DRAFT only, nothing depending on it
        if (current.status !== 'DRAFT' || convCount > 0 || packCount > 0) {
          throw new DomainError(
            'VARIANT_BASE_UOM_LOCKED',
            'the base UOM can only change while the variant is a DRAFT with no conversions and no pack identifiers',
            409,
          );
        }
      }

      // validate the code resolves — a built-in or a registered tenant unit
      if (!isBuiltinUom(code)) {
        await UomRepository.lockCustomUomRefs(tx, [code]);
      }
      try {
        const units = (await tx.uom.findMany({
          select: {
            code: true,
            family: true,
            perBaseNum: true,
            perBaseDen: true,
            maxDecimals: true,
          },
        })) as Array<{
          code: string;
          family: string;
          perBaseNum: bigint;
          perBaseDen: bigint;
          maxDecimals: number;
        }>;
        buildRegistry(units.map(toUomDef), []).get(code);
      } catch (e) {
        throw mapUomError(e);
      }

      await tx.variant.update({
        where: { id },
        data: { baseUomCode: code, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'catalog.variant_base_uom_set',
        resourceType: 'variant',
        resourceId: id,
        before: { baseUomCode: current.baseUomCode },
        after: { baseUomCode: code },
      });
      return this.getInTx(tx, id);
    });
  }

  private async getInTx(tx: ScopedTx, id: string): Promise<VariantWithOptions> {
    const row = await tx.variant.findUnique({ where: { id }, select: V_SELECT });
    if (!row) throw new NotFoundError('variant');
    const opts = await tx.variantOptionValue.findMany({
      where: { variantId: id },
      select: {
        optionGroupId: true,
        optionValueId: true,
        group: { select: { key: true } },
        value: { select: { value: true } },
      },
    });
    return {
      ...row,
      options: opts.map((o) => ({
        optionGroupId: o.optionGroupId,
        optionGroupKey: o.group.key,
        optionValueId: o.optionValueId,
        optionValue: o.value.value,
      })),
    };
  }
}

// ── shared helpers (consumed by product.repository / option-group.repository) ──

/** Create the internal default variant for a simple STOCKED/BOM product (owner
 *  L-2). `isDefault`, empty signature, zero option-value rows, status DRAFT. */
export async function createDefaultVariant(
  tx: ScopedTx,
  product: { id: string; nameEn: string; nameAr: string | null },
): Promise<void> {
  await tx.variant.create({
    data: {
      tenantId: requireTenantContext().tenantId,
      productId: product.id,
      nameEn: product.nameEn,
      nameAr: product.nameAr,
      isDefault: true,
      optionSignature: '',
      status: 'DRAFT',
    },
  });
}

/** Non-archived variant count for a product — the product-activation gate for a
 *  non-CUSTOM product (owner L-10). */
export function nonArchivedVariantCount(tx: ScopedTx, productId: string): Promise<number> {
  return tx.variant.count({ where: { productId, status: { not: 'ARCHIVED' } } });
}

/** Whether the product has any explicit (non-default) variant — blocks structural
 *  option-group changes (owner L-11). */
export async function nonDefaultVariantExists(tx: ScopedTx, productId: string): Promise<boolean> {
  return (await tx.variant.count({ where: { productId, isDefault: false } })) > 0;
}

/** Whether the product currently has a default variant. */
export async function hasDefaultVariant(tx: ScopedTx, productId: string): Promise<boolean> {
  return (await tx.variant.count({ where: { productId, isDefault: true } })) > 0;
}

/**
 * Remove the default variant when the product's option structure is about to
 * change (owner L-4). The default has no `variant_option_value` rows, so that is
 * always safe — but as of task 3.5 it MAY carry an `item_identifier`. In that
 * case the restructure is REFUSED (`VARIANT_HAS_IDENTIFIERS`, 409): identifiers
 * are never silently cascaded away (owner "TASK 3.4 DEFAULT-VARIANT RESTRUCTURE
 * GUARD"). The default variant row is locked `FOR UPDATE` first so a concurrent
 * `POST /catalog/identifiers` on it either wins (this call then sees the row and
 * 409s) or loses (this call deletes first, the identifier create then 404s).
 * The `item_identifier → variant` FK is `ON DELETE RESTRICT` — the DB is the
 * final backstop. Returns whether a row was removed.
 */
export async function removeDefaultVariantForRestructure(
  tx: ScopedTx,
  productId: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "variant"
     WHERE "productId" = ${productId}::uuid AND "isDefault" = true
     FOR UPDATE`;
  const def = locked[0];
  if (!def) return false;
  await assertVariantHasNoIdentifiers(tx, def.id);
  await tx.variant.delete({ where: { id: def.id } });
  return true;
}

async function assertProductExists(tx: ScopedTx, productId: string): Promise<void> {
  const p = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!p) throw new NotFoundError('product');
}

async function lockVariant(tx: ScopedTx, id: string): Promise<LockedVariant> {
  const rows = await tx.$queryRaw<LockedVariant[]>`
    SELECT "version", "status", "isDefault", "optionSignature", "productId", "nameEn", "baseUomCode"
      FROM "variant" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('variant');
  return rows[0]!;
}

/** Lock the product row (serialises variant creation vs. option-group changes)
 *  and load its option groups + value ids + labels. */
async function lockProductGroups(tx: ScopedTx, productId: string): Promise<ProductGroups> {
  const locked = await tx.$queryRaw<{ status: string; nameEn: string }[]>`
    SELECT "status", "nameEn" FROM "product" WHERE "id" = ${productId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError('product');
  const groups = await tx.optionGroup.findMany({
    where: { productId },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      key: true,
      sortOrder: true,
      values: { select: { id: true, value: true, labelEn: true } },
    },
  });
  const valueLabel = new Map<string, { labelEn: string; value: string }>();
  const shaped = groups.map((g) => {
    const valueIds = new Set<string>();
    for (const v of g.values) {
      valueIds.add(v.id);
      valueLabel.set(v.id, { labelEn: v.labelEn, value: v.value });
    }
    return { id: g.id, key: g.key, sortOrder: g.sortOrder, valueIds };
  });
  return {
    productId,
    productStatus: locked[0]!.status,
    productNameEn: locked[0]!.nameEn,
    groups: shaped,
    valueLabel,
  };
}

/** No OTHER non-archived variant of the product carries `signature` (owner L-7).
 *  The partial unique index is the backstop; this is the clean 409. */
async function assertSignatureFree(
  tx: ScopedTx,
  productId: string,
  signature: string,
  selfId: string | null,
): Promise<void> {
  const clash = await tx.variant.findFirst({
    where: {
      productId,
      optionSignature: signature,
      status: { not: 'ARCHIVED' },
      ...(selfId ? { id: { not: selfId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw new DomainError(
      'VARIANT_COMBINATION_DUPLICATE',
      'another non-archived variant already has this option combination',
      409,
    );
  }
}
