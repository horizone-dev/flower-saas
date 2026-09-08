import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { UomRegistry } from '@flower/uom';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import {
  buildRegistry,
  canonicalUomCode,
  effectiveConversions,
  isBuiltinUom,
  mapUomError,
  mergeUomList,
  requireUomCode,
  toUomDef,
  type TenantUomRow,
} from './uom.helpers.js';

export interface UomListEntry {
  code: string;
  family: string;
  perBaseNum: string;
  perBaseDen: string;
  maxDecimals: number;
  nameEn: string;
  nameAr: string | null;
  builtin: boolean;
  version: number | null;
}

export interface CreateUomInput {
  code: string;
  family: string;
  perBaseNum?: string | undefined;
  perBaseDen?: string | undefined;
  maxDecimals?: number | undefined;
  nameEn: string;
  nameAr?: string | null | undefined;
}

const CUSTOM_SELECT = {
  id: true,
  code: true,
  family: true,
  perBaseNum: true,
  perBaseDen: true,
  maxDecimals: true,
  nameEn: true,
  nameAr: true,
  version: true,
} as const;

/**
 * The tenant custom-UOM registry (task 3.6). Built-in units live in `@flower/uom`
 * (no DB row); a `uom` row is only ever a tenant-specific unit. Semantic fields
 * are immutable after create — only the display names are editable. RLS-scoped;
 * no method names a tenant id.
 *
 * ── Custom-UOM locking (owner FINAL CORRECTION 2) ───────────────────────────
 * A textual `baseUomCode` / `fromUomCode` / `toUomCode` / `packUomCode` has NO
 * DB FK (OD-5), so every mutation that PERSISTS a reference to a tenant-custom
 * `uom` first `SELECT … FOR KEY SHARE`s that row (canonicalized, de-duplicated,
 * ascending) — `lockCustomUomRefs`. A `DELETE` `SELECT … FOR UPDATE`s the target
 * row, THEN runs the dependency checks, THEN deletes only if still unreferenced.
 * `uom` is always the TERMINAL lock — no mutation holds a `uom` lock and then
 * requests a `variant` / `product` / `item_identifier` lock, so the lock graph
 * `{product|item_identifier} → variant → uom(KEY SHARE)` / `uom(UPDATE)` has no
 * cycle. Built-ins take no row lock.
 */
@Injectable()
export class UomRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  list(): Promise<UomListEntry[]> {
    return this.scoped(async (tx) => {
      const rows = await tx.uom.findMany({ orderBy: { code: 'asc' }, select: CUSTOM_SELECT });
      return mergeUomList(rows);
    });
  }

  get(rawCode: string): Promise<UomListEntry> {
    const code = requireUomCode(rawCode);
    return this.scoped(async (tx) => {
      const merged = mergeUomList(
        await tx.uom.findMany({ orderBy: { code: 'asc' }, select: CUSTOM_SELECT }),
      );
      const found = merged.find((u) => u.code === code);
      if (!found) throw new NotFoundError('unit of measure', 'UOM_NOT_FOUND');
      return found;
    });
  }

  async create(input: CreateUomInput): Promise<UomListEntry> {
    const code = requireUomCode(input.code);
    if (isBuiltinUom(code)) {
      throw new DomainError(
        'UOM_BUILTIN_SHADOW',
        `"${code}" is a built-in unit — register a tenant unit under a different code`,
        422,
        [{ field: 'code', issue: 'shadows a built-in unit' }],
      );
    }
    const perBaseNum = parsePositiveBigInt(input.perBaseNum ?? '1', 'perBaseNum');
    const perBaseDen = parsePositiveBigInt(input.perBaseDen ?? '1', 'perBaseDen');
    const maxDecimals = input.maxDecimals ?? 0;

    // eager validation via `@flower/uom` (perBase > 0, maxDecimals 0..4, COUNT
    // discrete, EACH perBase 1/1) — surfaced as UOM_INVALID_DEFINITION (422).
    validateUomDef({ code, family: input.family, perBaseNum, perBaseDen, maxDecimals });

    return this.scoped(async (tx) => {
      const clash = await tx.uom.findUnique({
        where: { tenantId_code: { tenantId: requireTenantContext().tenantId, code } },
        select: { id: true },
      });
      if (clash) {
        throw new DomainError('UOM_CODE_TAKEN', `a unit with code "${code}" already exists`, 409);
      }
      const created = await tx.uom
        .create({
          data: {
            tenantId: requireTenantContext().tenantId,
            code,
            family: input.family,
            perBaseNum,
            perBaseDen,
            maxDecimals,
            nameEn: input.nameEn,
            nameAr: input.nameAr ?? null,
          },
          select: CUSTOM_SELECT,
        })
        .catch((e: unknown) => {
          // a concurrent create of the SAME brand-new code lost the
          // `UNIQUE (tenantId, code)` race — map it to the same deterministic
          // 409 the pre-check raises (never a raw Prisma error → 500).
          if ((e as { code?: string } | null)?.code === 'P2002') {
            throw new DomainError(
              'UOM_CODE_TAKEN',
              `a unit with code "${code}" already exists`,
              409,
            );
          }
          throw e;
        });
      await this.audit.record(tx, {
        action: 'catalog.uom_created',
        resourceType: 'uom',
        resourceId: created.id,
        after: {
          code: created.code,
          family: created.family,
          perBaseNum: created.perBaseNum.toString(),
          perBaseDen: created.perBaseDen.toString(),
          maxDecimals: created.maxDecimals,
        },
      });
      return mergeUomList([created]).find((u) => u.code === code)!;
    });
  }

  /** Display-name edit only — semantic fields are immutable (owner MC-8). */
  async updateNames(
    rawCode: string,
    expectedVersion: number,
    input: { nameEn?: string | undefined; nameAr?: string | null | undefined },
  ): Promise<UomListEntry> {
    const code = requireUomCode(rawCode);
    return this.scoped(async (tx) => {
      const current = await lockUom(tx, code);
      if (!current) throw new NotFoundError('unit of measure', 'UOM_NOT_FOUND');
      if (expectedVersion !== current.version) {
        throw versionConflict('uom', expectedVersion, current.version);
      }
      const data: { nameEn?: string; nameAr?: string | null; version: { increment: number } } = {
        version: { increment: 1 },
      };
      if (input.nameEn !== undefined) data.nameEn = input.nameEn;
      if (input.nameAr !== undefined) data.nameAr = input.nameAr ?? null;
      const updated = await tx.uom.update({
        where: { tenantId_code: { tenantId: requireTenantContext().tenantId, code } },
        data,
        select: CUSTOM_SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.uom_updated',
        resourceType: 'uom',
        resourceId: updated.id,
        before: { nameEn: current.nameEn, nameAr: current.nameAr },
        after: { nameEn: updated.nameEn, nameAr: updated.nameAr },
      });
      return mergeUomList([updated]).find((u) => u.code === code)!;
    });
  }

  /**
   * Hard-delete a tenant unit — only while COMPLETELY unreferenced (owner FINAL
   * CORRECTION 2 / 6). Lock the target `FOR UPDATE`, THEN run every dependency
   * check (all statuses count), THEN delete. A concurrent reference writer that
   * acquired its `FOR KEY SHARE` first makes this wait, then this sees the
   * reference and 409s (`UOM_IN_USE`); a writer that acquires its lock AFTER this
   * commits finds the row gone and fails cleanly.
   */
  async remove(rawCode: string, expectedVersion: number): Promise<void> {
    const code = requireUomCode(rawCode);
    await this.scoped(async (tx) => {
      const current = await lockUom(tx, code); // FOR UPDATE
      if (!current) throw new NotFoundError('unit of measure', 'UOM_NOT_FOUND');
      if (expectedVersion !== current.version) {
        throw versionConflict('uom', expectedVersion, current.version);
      }

      const [inBase, inConv, inPack, inPrice] = await Promise.all([
        tx.variant.count({ where: { baseUomCode: code } }),
        tx.uomConversion.count({ where: { OR: [{ fromUomCode: code }, { toUomCode: code }] } }),
        // ACTIVE **and** INACTIVE pack identifiers count — an INACTIVE row is a
        // historical printed identity that may be reactivated.
        tx.itemIdentifier.count({ where: { packUomCode: code } }),
        // task 3.7 (D-5) — a `company_variant_uom_price` row for this code, across
        // ANY company. Textual reference, no FK. Counts EVERY row, even one whose
        // conversion is currently deleted (`resolvable: false`) — the code is
        // still referenced. `company_variant_uom_price (tenantId, uomCode)` index.
        tx.companyVariantUomPrice.count({ where: { uomCode: code } }),
      ]);
      if (inBase + inConv + inPack + inPrice > 0) {
        throw new DomainError(
          'UOM_IN_USE',
          `unit "${code}" is referenced by ${inBase} variant base UOM(s), ${inConv} conversion(s), ` +
            `${inPack} pack identifier(s) and ${inPrice} company price(s) — remove them first`,
          409,
        );
      }

      await tx.uom.delete({
        where: { tenantId_code: { tenantId: requireTenantContext().tenantId, code } },
      });
      await this.audit.record(tx, {
        action: 'catalog.uom_deleted',
        resourceType: 'uom',
        resourceId: current.id,
        before: { code: current.code, family: current.family },
      });
    });
  }

  /**
   * `SELECT … FOR KEY SHARE` every tenant-custom code in `rawCodes`
   * (canonicalized → de-duplicated → ascending → locked in that order) so a
   * concurrent `DELETE` of one of them either loses (this write persists the
   * reference, the delete then 409s) or wins (this write then finds the row
   * gone and fails cleanly). Built-in codes are skipped (no row). Returns the
   * canonical codes. Throws `UOM_NOT_REGISTERED` (422) for a non-built-in code
   * with no `uom` row in this tenant.
   */
  static async lockCustomUomRefs(tx: ScopedTx, rawCodes: readonly string[]): Promise<void> {
    const custom = [...new Set(rawCodes.map(canonicalUomCode))]
      .filter((c) => c.length > 0 && !isBuiltinUom(c))
      .sort();
    for (const code of custom) {
      const rows = await tx.$queryRaw<{ code: string }[]>`
        SELECT "code" FROM "uom" WHERE "code" = ${code} FOR KEY SHARE`;
      if (rows.length === 0) {
        throw new DomainError(
          'UOM_NOT_REGISTERED',
          `unit "${code}" is not a built-in and is not registered for this tenant`,
          422,
          [{ field: 'code', issue: 'unknown UOM code' }],
        );
      }
    }
  }
}

// ── shared helpers ─────────────────────────────────────────────────────────

function parsePositiveBigInt(raw: string, field: string): bigint {
  if (!/^\d{1,19}$/.test(raw.trim())) {
    throw new DomainError('UOM_INVALID_DEFINITION', `${field} must be a positive integer`, 422, [
      { field, issue: 'not a positive integer' },
    ]);
  }
  const v = BigInt(raw.trim());
  if (v <= 0n) {
    throw new DomainError('UOM_INVALID_DEFINITION', `${field} must be > 0`, 422, [
      { field, issue: 'must be > 0' },
    ]);
  }
  return v;
}

function validateUomDef(row: TenantUomRow): void {
  try {
    // constructing a registry with the unit runs `@flower/uom`'s eager
    // `assertValidUomDef` (perBase > 0, maxDecimals range, COUNT discrete) plus
    // our EACH perBase 1/1 rule.
    if (row.family === 'EACH' && (row.perBaseNum !== 1n || row.perBaseDen !== 1n)) {
      throw new DomainError(
        'UOM_INVALID_DEFINITION',
        'an EACH unit has no generic ratio — perBaseNum and perBaseDen must both be 1',
        422,
      );
    }
    buildRegistry([toUomDef(row)], []);
  } catch (e) {
    throw mapUomError(e);
  }
}

/**
 * A variant's effective `UomRegistry` inside a scoped transaction — the shared
 * primitive for a conversion write AND a pack-identifier snapshot. The variant's
 * `baseUomCode` must already be set. Precedence (VARIANT overrides matching
 * PRODUCT) is resolved before the registry is constructed (owner §F).
 */
export async function loadEffectiveVariantRegistry(
  tx: ScopedTx,
  variant: { id: string; productId: string; baseUomCode: string },
): Promise<UomRegistry> {
  const [units, variantRows, productRows] = await Promise.all([
    tx.uom.findMany({
      select: { code: true, family: true, perBaseNum: true, perBaseDen: true, maxDecimals: true },
    }),
    tx.uomConversion.findMany({
      where: { scopeKind: 'VARIANT', scopeId: variant.id },
      select: { fromUomCode: true, toUomCode: true, num: true, den: true },
    }),
    tx.uomConversion.findMany({
      where: { scopeKind: 'PRODUCT', scopeId: variant.productId },
      select: { fromUomCode: true, toUomCode: true, num: true, den: true },
    }),
  ]);
  return buildRegistry(
    (units as TenantUomRow[]).map(toUomDef),
    effectiveConversions(variantRows, productRows, variant.baseUomCode),
  );
}

async function lockUom(
  tx: ScopedTx,
  code: string,
): Promise<{
  id: string;
  version: number;
  nameEn: string;
  nameAr: string | null;
  code: string;
  family: string;
} | null> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      version: number;
      nameEn: string;
      nameAr: string | null;
      code: string;
      family: string;
    }[]
  >`SELECT "id", "version", "nameEn", "nameAr", "code", "family" FROM "uom" WHERE "code" = ${code} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Re-export so the conversion / identifier repos can build a bare registry. */
export { UomRegistry };
