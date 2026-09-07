import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import {
  ACTIVE_IDENTIFIER_TARGET_KINDS,
  type IdentifierCodeType,
  type IdentifierStatus,
} from '@flower/shared-types';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { canonicalIdentifierValue, generateQrValue } from './identifier.helpers.js';

export interface ItemIdentifierRow {
  id: string;
  targetKind: 'VARIANT';
  targetId: string;
  codeType: IdentifierCodeType;
  value: string;
  status: IdentifierStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdentifierResolution {
  identifier: ItemIdentifierRow;
  target: { kind: 'VARIANT'; id: string };
  variant: { id: string; productId: string; nameEn: string; status: string };
  product: { id: string; slug: string; nameEn: string; status: string };
}

export interface CreateIdentifierInput {
  targetKind: string;
  targetId: string;
  codeType: IdentifierCodeType;
  /** required for SKU / BARCODE; must be absent for QR */
  value?: string | undefined;
}

const ID_SELECT = {
  id: true,
  targetKind: true,
  targetId: true,
  codeType: true,
  value: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface LockedIdentifier {
  status: IdentifierStatus;
  codeType: IdentifierCodeType;
  targetKind: string;
  targetId: string;
  value: string;
}

/**
 * The scannable-code registry (task 3.5). Tenant-scoped through RLS +
 * `runScoped`; company / branch / price / stock-neutral (D2-2). Identity fields
 * are immutable — there is no `PUT` and no `version` column; lifecycle races use
 * a `FOR UPDATE` row lock + a status predicate + the global unique constraint +
 * idempotency (owner "CONCURRENCY"). `tenant.businessTypeKey` is NEVER read
 * (HG3-NO-BT-BRANCH) — behaviour comes only from `codeType` + the configured
 * data. All audit rows are ordinary catalog events (`security: false`).
 */
@Injectable()
export class IdentifierRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  /** Bare-value scan resolution (owner "SCAN RESOLUTION"): at most one ACTIVE
   *  identifier per value (owner decision 3). An ARCHIVED target variant is NOT
   *  a currently usable scan target — 404 (the identifier row + history stay
   *  intact; a later variant reactivation makes the still-ACTIVE identifier
   *  resolvable again). */
  resolveByValue(value: string): Promise<IdentifierResolution> {
    return this.scoped(async (tx) => {
      const row = (await tx.itemIdentifier.findFirst({
        where: { value, status: 'ACTIVE' },
        select: ID_SELECT,
      })) as ItemIdentifierRow | null;
      if (!row) throw new NotFoundError('identifier', 'IDENTIFIER_NOT_FOUND');

      const variant = await tx.variant.findUnique({
        where: { id: row.targetId },
        select: { id: true, productId: true, nameEn: true, status: true },
      });
      if (!variant || variant.status === 'ARCHIVED') {
        throw new NotFoundError('identifier target', 'IDENTIFIER_TARGET_UNAVAILABLE');
      }
      const product = await tx.product.findUnique({
        where: { id: variant.productId },
        select: { id: true, slug: true, nameEn: true, status: true },
      });
      if (!product) throw new NotFoundError('identifier target');
      return {
        identifier: row,
        target: { kind: 'VARIANT', id: row.targetId },
        variant,
        product,
      };
    });
  }

  /** Management / audit view — ACTIVE **and** INACTIVE identifiers of one
   *  variant (owner "SCAN RESOLUTION"). */
  listForTarget(targetKind: string, targetId: string): Promise<ItemIdentifierRow[]> {
    return this.scoped(async (tx) => {
      assertVariantTargetKind(targetKind);
      const variant = await tx.variant.findUnique({
        where: { id: targetId },
        select: { id: true },
      });
      if (!variant) throw new NotFoundError('variant');
      return tx.itemIdentifier.findMany({
        where: { targetKind, targetId },
        orderBy: [{ codeType: 'asc' }, { status: 'asc' }, { createdAt: 'asc' }],
        select: ID_SELECT,
      }) as Promise<ItemIdentifierRow[]>;
    });
  }

  async create(input: CreateIdentifierInput): Promise<ItemIdentifierRow> {
    // owner decision 1 — VARIANT is the only legal target kind in Phase 3a.
    assertVariantTargetKind(input.targetKind);
    const resolved = canonicalIdentifierValue(input.codeType, input.value);

    return this.scoped(async (tx) => {
      const target = await lockVariant(tx, input.targetId);
      if (!target) throw new NotFoundError('variant');
      if (target.status === 'ARCHIVED') {
        throw new DomainError(
          'IDENTIFIER_TARGET_UNAVAILABLE',
          'an identifier cannot be added to an archived variant',
          409,
        );
      }

      await this.assertSingleActive(tx, input.codeType, input.targetKind, input.targetId);

      let value: string;
      if (resolved.generateQr) {
        value = await this.mintUniqueQr(tx);
      } else {
        value = resolved.value;
        await this.assertValueFree(tx, value);
      }

      let created: ItemIdentifierRow;
      try {
        created = (await tx.itemIdentifier.create({
          data: {
            tenantId: requireTenantContext().tenantId,
            targetKind: 'VARIANT',
            targetId: input.targetId,
            codeType: input.codeType,
            value,
            status: 'ACTIVE',
          },
          select: ID_SELECT,
        })) as ItemIdentifierRow;
      } catch (e) {
        rethrowUniqueViolation(e, value);
      }

      await this.audit.record(tx, {
        action: 'catalog.identifier_created',
        resourceType: 'item_identifier',
        resourceId: created.id,
        after: { targetKind: 'VARIANT', targetId: input.targetId, codeType: input.codeType },
      });
      return created;
    });
  }

  /**
   * The public "remove" (owner "DELETE"): normally a soft deactivate
   * (`ACTIVE → INACTIVE`, row + value preserved). A DRAFT-target identifier is
   * instead HARD-deleted — nothing downstream references it and it was never
   * externally committed, so this is the narrow, explicit, audited correction
   * path that also lets the owner clear an identifier before a Task-3.4
   * default-variant restructure. Never an automatic side effect of a
   * variant/product change (owner decision 5).
   */
  deactivateOrDelete(id: string): Promise<{ status: 'deactivated' | 'deleted' }> {
    return this.scoped(async (tx) => {
      const row = await lockIdentifier(tx, id);
      if (!row) throw new NotFoundError('identifier');

      const target = await tx.variant.findUnique({
        where: { id: row.targetId },
        select: { status: true },
      });

      if (target && target.status === 'DRAFT') {
        await tx.itemIdentifier.delete({ where: { id } });
        await this.audit.record(tx, {
          action: 'catalog.identifier_deleted',
          resourceType: 'item_identifier',
          resourceId: id,
          before: { codeType: row.codeType, value: row.value, targetId: row.targetId },
        });
        return { status: 'deleted' };
      }

      if (row.status === 'INACTIVE') return { status: 'deactivated' }; // idempotent no-op
      await tx.itemIdentifier.update({ where: { id }, data: { status: 'INACTIVE' } });
      await this.audit.record(tx, {
        action: 'catalog.identifier_deactivated',
        resourceType: 'item_identifier',
        resourceId: id,
        before: { status: 'ACTIVE' },
        after: { status: 'INACTIVE' },
      });
      return { status: 'deactivated' };
    });
  }

  /** The `codeType` of an identifier — the service peeks it to decide whether
   *  the `identifiers.barcode_qr` capability gate applies to a reactivate. */
  peekCodeType(id: string): Promise<IdentifierCodeType> {
    return this.scoped(async (tx) => {
      const row = await tx.itemIdentifier.findUnique({
        where: { id },
        select: { codeType: true },
      });
      if (!row) throw new NotFoundError('identifier');
      return row.codeType as IdentifierCodeType;
    });
  }

  /** `INACTIVE → ACTIVE` on the SAME row (owner decision 5 — never a new row,
   *  never a value reassignment). Re-checks the target lifecycle + the
   *  one-ACTIVE-SKU / one-ACTIVE-QR invariants that may have changed while the
   *  row was INACTIVE. */
  reactivate(id: string): Promise<ItemIdentifierRow> {
    return this.scoped(async (tx) => {
      const row = await lockIdentifier(tx, id);
      if (!row) throw new NotFoundError('identifier');
      if (row.status === 'ACTIVE') return this.getInTx(tx, id); // idempotent no-op

      const target = await tx.variant.findUnique({
        where: { id: row.targetId },
        select: { status: true },
      });
      if (!target || target.status === 'ARCHIVED') {
        throw new DomainError(
          'IDENTIFIER_TARGET_UNAVAILABLE',
          'the identifier target variant is archived or no longer exists',
          409,
        );
      }
      await this.assertSingleActive(tx, row.codeType, row.targetKind, row.targetId);

      try {
        await tx.itemIdentifier.update({ where: { id }, data: { status: 'ACTIVE' } });
      } catch (e) {
        rethrowUniqueViolation(e, row.value);
      }
      await this.audit.record(tx, {
        action: 'catalog.identifier_reactivated',
        resourceType: 'item_identifier',
        resourceId: id,
        before: { status: 'INACTIVE' },
        after: { status: 'ACTIVE' },
      });
      return this.getInTx(tx, id);
    });
  }

  private getInTx(tx: ScopedTx, id: string): Promise<ItemIdentifierRow> {
    return tx.itemIdentifier.findUnique({ where: { id }, select: ID_SELECT }).then((r) => {
      if (!r) throw new NotFoundError('identifier');
      return r as ItemIdentifierRow;
    });
  }

  private async assertSingleActive(
    tx: ScopedTx,
    codeType: IdentifierCodeType,
    targetKind: string,
    targetId: string,
  ): Promise<void> {
    if (codeType === 'BARCODE') return; // many ACTIVE BARCODE rows per target
    const existing = await tx.itemIdentifier.count({
      where: { targetKind, targetId, codeType, status: 'ACTIVE' },
    });
    if (existing > 0) {
      throw new DomainError(
        codeType === 'SKU' ? 'IDENTIFIER_ACTIVE_SKU_EXISTS' : 'IDENTIFIER_ACTIVE_QR_EXISTS',
        `this variant already has an active ${codeType}`,
        409,
      );
    }
  }

  private async assertValueFree(tx: ScopedTx, value: string): Promise<void> {
    const clash = await tx.itemIdentifier.findFirst({ where: { value }, select: { id: true } });
    if (clash) {
      throw new DomainError(
        'IDENTIFIER_VALUE_TAKEN',
        `the identifier value "${value}" is already registered in this tenant`,
        409,
      );
    }
  }

  private async mintUniqueQr(tx: ScopedTx): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateQrValue();
      const clash = await tx.itemIdentifier.findFirst({
        where: { value: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    // 160 bits of entropy — reaching here is astronomically unlikely.
    throw new DomainError(
      'IDENTIFIER_QR_GENERATION_FAILED',
      'could not mint a unique QR value; please retry',
      503,
    );
  }
}

// ── shared helpers (consumed by option-group / product / variant repositories) ─

/**
 * The Task 3.4 default-variant restructure guard (owner "TASK 3.4 DEFAULT-VARIANT
 * RESTRUCTURE GUARD"). Throw `VARIANT_HAS_IDENTIFIERS` (409) if the variant
 * carries ANY identifier (ACTIVE or INACTIVE) — the caller must not silently
 * cascade them away. The `item_identifier → variant` FK is ON DELETE RESTRICT,
 * so the DB is the final backstop if this check is ever bypassed.
 */
export async function assertVariantHasNoIdentifiers(
  tx: ScopedTx,
  variantId: string,
): Promise<void> {
  const n = await tx.itemIdentifier.count({
    where: { targetKind: 'VARIANT', targetId: variantId },
  });
  if (n > 0) {
    throw new DomainError(
      'VARIANT_HAS_IDENTIFIERS',
      'remove or deactivate this variant’s identifiers before restructuring it',
      409,
    );
  }
}

/** Product-level guard for a DRAFT-product hard-delete — a clean 409 instead of
 *  a raw `item_identifier → variant` RESTRICT FK error. */
export async function assertProductVariantsHaveNoIdentifiers(
  tx: ScopedTx,
  productId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n
      FROM "item_identifier" ii
      JOIN "variant" v ON v."id" = ii."targetId" AND ii."targetKind" = 'VARIANT'
     WHERE v."productId" = ${productId}::uuid`;
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new DomainError(
      'PRODUCT_HAS_VARIANT_IDENTIFIERS',
      'delete this product’s variant identifiers before hard-deleting the product',
      409,
    );
  }
}

function assertVariantTargetKind(targetKind: string): void {
  if (!(ACTIVE_IDENTIFIER_TARGET_KINDS as readonly string[]).includes(targetKind)) {
    throw new DomainError(
      'IDENTIFIER_TARGET_KIND_NOT_SUPPORTED',
      `identifier target kind "${targetKind}" is not supported (only VARIANT)`,
      422,
      [{ field: 'targetKind', issue: 'unsupported' }],
    );
  }
}

async function lockVariant(tx: ScopedTx, id: string): Promise<{ status: string } | null> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status" FROM "variant" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

async function lockIdentifier(tx: ScopedTx, id: string): Promise<LockedIdentifier | null> {
  const rows = await tx.$queryRaw<LockedIdentifier[]>`
    SELECT "status", "codeType", "targetKind", "targetId", "value"
      FROM "item_identifier" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** Map a partial-unique-index race (a check-then-insert that lost) to a clean
 *  409; anything else is re-thrown unchanged. */
function rethrowUniqueViolation(e: unknown, value: string): never {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'P2002') {
    const target = String((e as { meta?: { target?: unknown } })?.meta?.target ?? '');
    if (target.includes('one_active_sku')) {
      throw new DomainError(
        'IDENTIFIER_ACTIVE_SKU_EXISTS',
        'this variant already has an active SKU',
        409,
      );
    }
    if (target.includes('one_active_qr')) {
      throw new DomainError(
        'IDENTIFIER_ACTIVE_QR_EXISTS',
        'this variant already has an active QR',
        409,
      );
    }
    throw new DomainError(
      'IDENTIFIER_VALUE_TAKEN',
      `the identifier value "${value}" is already registered in this tenant`,
      409,
    );
  }
  throw e;
}
