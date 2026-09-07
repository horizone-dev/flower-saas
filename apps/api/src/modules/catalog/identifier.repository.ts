import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import {
  ACTIVE_IDENTIFIER_TARGET_KINDS,
  canonicalizeSku,
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
 *
 * ── Lock order (owner "LOCKING REVIEW", task 3.5 remediation) ────────────────
 * Every identifier lifecycle method acquires `FOR UPDATE` row locks in the
 * documented order **`item_identifier` → `variant`**:
 *   - `create`             locks the target `variant`, then INSERTs a NEW
 *                          `item_identifier` row (the new row's lock is
 *                          uncontended — this is `variant → (new row)`, not
 *                          `variant → existing item_identifier`).
 *   - `deactivateOrDelete` locks the `item_identifier` row, then the target
 *                          `variant` — the hard-delete-vs-keep decision is made
 *                          while HOLDING the variant lock, so a concurrent
 *                          `variant` activate/archive cannot flip the status
 *                          out from under a stale read.
 *   - `reactivate`         same order: `item_identifier` then target `variant`.
 * The Task-3.4 restructure paths (`option-group.create` /
 * `product.update` strategy change → `removeDefaultVariantForRestructure`;
 * `product.remove`) lock `product` → `variant`. An identifier path (I→V) and a
 * restructure path (P→V) contend only on the `variant` row — never in a cycle:
 * an identifier path never holds a `product` lock, and a restructure path never
 * `FOR UPDATE`-locks an existing `item_identifier` row (it only `count`s them,
 * then bails with `VARIANT_HAS_IDENTIFIERS` before any child lock). `product`
 * hard-delete keeps its fast `count` pre-check but ALSO translates the DB
 * `item_identifier → variant` RESTRICT-FK conflict into `409
 * PRODUCT_HAS_VARIANT_IDENTIFIERS` (via `rethrowProductVariantIdentifierFkError`)
 * rather than adding a `product → variant` lock that would invert against
 * `variant.update`'s combination-edit `variant → product` order.
 */
@Injectable()
export class IdentifierRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  /**
   * Bare-value scan resolution (owner "SCAN RESOLUTION" / "B" / "C"):
   *   1. an EXACT ACTIVE lookup on the supplied value (bare-scanner determinism —
   *      a printed BARCODE / QR / canonical SKU resolves verbatim);
   *   2. only if the exact lookup MISSES, a fallback restricted to
   *      `codeType = 'SKU' AND value = canonicalizeSku(input)` — so a manually
   *      typed lowercase SKU still resolves, while a lowercase string can NEVER
   *      uppercase-fold into a BARCODE / QR (those stay exact / case-sensitive).
   *
   * A target that is not currently usable → 404 `IDENTIFIER_TARGET_UNAVAILABLE`:
   * the identifier is not ACTIVE, the target `variant` is ARCHIVED, or the
   * target `product` is ARCHIVED. `identifier.status` / `variant.status` are
   * NEVER mutated here — the row stays visible in the management / list-by-target
   * view, and product/variant reactivation restores resolution (subject to the
   * later sellability gates, which are NOT applied here).
   */
  resolveByValue(value: string): Promise<IdentifierResolution> {
    return this.scoped(async (tx) => {
      let row = (await tx.itemIdentifier.findFirst({
        where: { value, status: 'ACTIVE' },
        select: ID_SELECT,
      })) as ItemIdentifierRow | null;

      if (!row) {
        const canonicalSku = canonicalizeSku(value);
        if (canonicalSku !== value) {
          row = (await tx.itemIdentifier.findFirst({
            where: { value: canonicalSku, codeType: 'SKU', status: 'ACTIVE' },
            select: ID_SELECT,
          })) as ItemIdentifierRow | null;
        }
      }
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
      if (product.status === 'ARCHIVED') {
        throw new NotFoundError('identifier target', 'IDENTIFIER_TARGET_UNAVAILABLE');
      }
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
        rethrowUniqueViolation(e, value, input.codeType);
      }

      await this.audit.record(tx, {
        action: 'catalog.identifier_created',
        resourceType: 'item_identifier',
        resourceId: created.id,
        // owner "E" — record the immutable value that was actually persisted
        // (canonical SKU / verbatim barcode / server-generated opaque QR). A
        // catalog identifier is a printed code, not secret material.
        after: {
          targetKind: 'VARIANT',
          targetId: input.targetId,
          codeType: input.codeType,
          value: created.value,
        },
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
   *
   * The target `variant` is locked `FOR UPDATE` and its status re-read **while
   * holding that lock** (task 3.5 remediation, owner FIX 1): a concurrent
   * `variant` activation cannot flip DRAFT → ACTIVE between the check and the
   * hard-delete, so an identifier is never physically removed on a stale DRAFT
   * read. Lock order: `item_identifier` → `variant`.
   */
  deactivateOrDelete(id: string): Promise<{ status: 'deactivated' | 'deleted' }> {
    return this.scoped(async (tx) => {
      const row = await lockIdentifier(tx, id);
      if (!row) throw new NotFoundError('identifier');

      // lock the target variant, THEN decide — no stale-read hard delete
      const target = await lockVariant(tx, row.targetId);

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

      // lock order `item_identifier` → `variant`: hold the variant lock while
      // re-checking its lifecycle so a concurrent archive can't slip past.
      const target = await lockVariant(tx, row.targetId);
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
        rethrowUniqueViolation(e, row.value, row.codeType);
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

/**
 * Fast pre-check for a DRAFT-product hard-delete — a clean 409 in the common
 * (non-racing) case. It is a plain `count`, NOT a locking read: taking
 * `FOR UPDATE` on the product's variant rows here would establish a
 * `product → variant` order that inverts against `variant.update`'s
 * combination-edit `variant → product` order (deadlock). The race window
 * between this check and `product.delete` is instead closed by
 * `rethrowProductVariantIdentifierFkError` around the delete itself — the DB
 * `item_identifier → variant` RESTRICT FK is the integrity backstop and its
 * conflict is translated to the same `409 PRODUCT_HAS_VARIANT_IDENTIFIERS`
 * (owner FIX 2 / "LOCKING REVIEW").
 */
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

/**
 * Translate an `item_identifier → variant` RESTRICT foreign-key conflict raised
 * by a `product.delete` cascade (an identifier that was created after
 * `assertProductVariantsHaveNoIdentifiers` ran and before the delete) into the
 * documented `409 PRODUCT_HAS_VARIANT_IDENTIFIERS` — never a raw FK 500. Any
 * other error (including an unrelated RESTRICT FK, e.g. `product_attribute_value`
 * from task 3.3) is re-thrown unchanged.
 */
export function rethrowProductVariantIdentifierFkError(e: unknown): never {
  const err = e as { code?: string; meta?: Record<string, unknown>; message?: string } | null;
  // The `item_identifier → variant` RESTRICT FK fires on the `product.delete`
  // cascade for an identifier created in the race window. Recognise it by the
  // constraint name / FK column, regardless of how the driver surfaces it —
  // Prisma `P2003` (`meta.constraint` + message), a raw pg `23503`, or (belt &
  // braces) any error whose text says "foreign key". A `product_attribute_value`
  // RESTRICT (task 3.3) or anything else is re-thrown unchanged.
  const blob = `${err?.code ?? ''} ${JSON.stringify(err?.meta ?? {})} ${err?.message ?? ''}`;
  const looksLikeFk = err?.code === 'P2003' || err?.code === '23503' || /foreign key/i.test(blob);
  if (looksLikeFk && /item_identifier(_tenant_variant_fkey)?|targetVariantId/i.test(blob)) {
    throw new DomainError(
      'PRODUCT_HAS_VARIANT_IDENTIFIERS',
      'delete this product’s variant identifiers before hard-deleting the product',
      409,
    );
  }
  throw e as Error;
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

/** `FOR UPDATE` lock + status read of one variant — the shared primitive for
 *  every identifier lifecycle path (`create` / `deactivateOrDelete` /
 *  `reactivate`). Held for the rest of the transaction so a concurrent variant
 *  activate/archive serialises behind it. `null` if the variant does not exist
 *  in the request tenant (RLS-scoped). */
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

/**
 * Map a partial-unique-index race (a check-then-insert that lost) to a clean,
 * DETERMINISTIC 409; anything else is re-thrown unchanged. The winning index is
 * read from `meta.target` when Prisma provides it, but the partial indexes are
 * not in `schema.prisma`, so `meta.target` can be absent — `codeType` is the
 * fallback (only `SKU` / `QR` have a one-ACTIVE-per-target index; a `BARCODE`
 * P2002 can only be the `(tenantId, value)` unique).
 */
function rethrowUniqueViolation(e: unknown, value: string, codeType: IdentifierCodeType): never {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'P2002') {
    const target = String((e as { meta?: { target?: unknown } })?.meta?.target ?? '');
    const isSkuIdx = target.includes('one_active_sku') || (target === '' && codeType === 'SKU');
    const isQrIdx = target.includes('one_active_qr') || (target === '' && codeType === 'QR');
    if (isSkuIdx) {
      throw new DomainError(
        'IDENTIFIER_ACTIVE_SKU_EXISTS',
        'this variant already has an active SKU',
        409,
      );
    }
    if (isQrIdx) {
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
