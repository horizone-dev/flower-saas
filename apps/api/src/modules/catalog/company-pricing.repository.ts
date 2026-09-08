import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { Money, type MoneyDTO } from '@flower/money';
import { Quantity, type UomRegistry } from '@flower/uom';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import { isBuiltinUom } from './uom.helpers.js';
import { UomRepository, loadEffectiveVariantRegistry } from './uom.repository.js';
import {
  assertSellMoney,
  mapPricingDbError,
  requireUomCode,
  storedSellToDto,
  type CompanyPriceResolveReason,
  type PriceEntryInput,
} from './company-pricing.helpers.js';

/** GET `/prices` — the company's own stored rows + the current aggregate version. */
export interface CompanyPriceSetView {
  version: number;
  priceSetExists: boolean;
  prices: { uomCode: string; sell: MoneyDTO; resolvable: boolean }[];
}

/** GET `/prices/resolve` — a resolved company sell price, or an explicit no-price state. */
export interface ResolvedCompanyPrice {
  price: MoneyDTO | null;
  source: 'COMPANY' | null;
  reason: CompanyPriceResolveReason;
}

const SELL_SELECT = {
  uomCode: true,
  sellAmountMinor: true,
  sellCurrencyCode: true,
  sellCurrencyExponent: true,
} as const;

/**
 * Task 3.7 — company per-UOM SELL pricing (tenant-owned, company-scoped).
 *
 *  - `company_variant_price_set` is the per (tenant, company, variant) AGGREGATE
 *    — it carries the `version` that guards the replace-set (`If-Match`, D-7 —
 *    NEVER `variant.version`), and it exists independently of whether any price
 *    rows exist. `PUT []` deletes the price rows + bumps the version; Task 3.7
 *    NEVER deletes the aggregate row.
 *  - `company_variant_uom_price` holds the INDEPENDENT stored Money per selling
 *    UOM tier — never `base_price × factor` (ADR-0018 §5). A priced UOM must be
 *    the base OR resolvable to it via the Task 3.6 effective conversion model;
 *    that check validates legitimacy ONLY and never derives the amount.
 *
 * Lock order (extends the Task 3.6 proven order, no cycle):
 *   company (FOR SHARE) → variant (FOR SHARE) → company_variant_price_set
 *   (INSERT…ON CONFLICT DO NOTHING / FOR UPDATE) → uom (FOR KEY SHARE).
 * Every path takes `variant` before `uom` and `uom` last; `uom` is the terminal
 * lock. Company FOR SHARE serialises against a future `company.defaultCurrency`
 * change (Inv-3); the DB composite FKs are the hard backstop.
 */
@Injectable()
export class CompanyPricingRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  /** GET `/prices` — stored rows for this company + the aggregate version. */
  getForCompanyVariant(companyId: string, variantId: string): Promise<CompanyPriceSetView> {
    return this.scoped(async (tx) => {
      const { variant } = await this.loadCompanyVariant(tx, companyId, variantId);
      const [agg, rows] = await Promise.all([
        tx.companyVariantPriceSet.findUnique({
          where: { tenantId_companyId_variantId: this.scopeKey(companyId, variantId) },
          select: { version: true },
        }),
        tx.companyVariantUomPrice.findMany({
          where: { companyId, variantId },
          orderBy: { uomCode: 'asc' },
          select: SELL_SELECT,
        }),
      ]);
      const reachable = await this.reachabilityFn(tx, variant);
      return {
        version: agg?.version ?? 0,
        priceSetExists: agg != null,
        prices: rows.map((r) => ({
          uomCode: r.uomCode,
          sell: storedSellToDto({
            uomCode: r.uomCode,
            sellAmountMinor: r.sellAmountMinor,
            sellCurrencyCode: r.sellCurrencyCode,
            sellCurrencyExponent: r.sellCurrencyExponent,
          }),
          resolvable: reachable(r.uomCode),
        })),
      };
    });
  }

  /**
   * GET `/prices/resolve?uomCode=` — the effective company SELL price for one
   * UOM, or an explicit no-price state (never a 422 for absence — D-13). NO
   * branch fallback, NO cross-company fallback, NO price multiplication.
   */
  resolve(companyId: string, variantId: string, rawUomCode: string): Promise<ResolvedCompanyPrice> {
    const uomCode = requireUomCode(rawUomCode); // 422 UOM_INVALID_CODE on a malformed code only
    return this.scoped(async (tx) => {
      const { variant } = await this.loadCompanyVariant(tx, companyId, variantId);
      const agg = await tx.companyVariantPriceSet.findUnique({
        where: { tenantId_companyId_variantId: this.scopeKey(companyId, variantId) },
        select: { version: true },
      });
      if (!agg) return { price: null, source: null, reason: 'NO_PRICE_SET' as const };

      const [row, reachable] = await Promise.all([
        tx.companyVariantUomPrice.findUnique({
          where: {
            tenantId_companyId_variantId_uomCode: {
              ...this.scopeKey(companyId, variantId),
              uomCode,
            },
          },
          select: SELL_SELECT,
        }),
        this.reachabilityFn(tx, variant).then((fn) => fn(uomCode)),
      ]);

      if (row && reachable) {
        return {
          price: storedSellToDto({
            uomCode,
            sellAmountMinor: row.sellAmountMinor,
            sellCurrencyCode: row.sellCurrencyCode,
            sellCurrencyExponent: row.sellCurrencyExponent,
          }),
          source: 'COMPANY' as const,
          reason: null,
        };
      }
      if (row && !reachable) {
        return { price: null, source: null, reason: 'UOM_UNRESOLVABLE' as const };
      }
      if (!row && reachable) {
        return { price: null, source: null, reason: 'UOM_NOT_PRICED' as const };
      }
      return { price: null, source: null, reason: 'UOM_UNRESOLVABLE' as const };
    });
  }

  /**
   * PUT `/prices` — replace the full set of company SELL prices for a variant.
   * `[]` unprices (deletes every price row, keeps the aggregate, bumps version).
   * Frozen transaction algorithm (scope freeze rev.3 §4.2).
   */
  async replace(
    companyId: string,
    variantId: string,
    entries: readonly PriceEntryInput[],
    ifMatch: number,
  ): Promise<CompanyPriceSetView> {
    const tenantId = requireTenantContext().tenantId;
    try {
      await this.scoped(async (tx) => {
        // 1. company FOR SHARE — serialises against a future defaultCurrency change (Inv-3)
        const companyRows = await tx.$queryRaw<{ id: string; defaultCurrency: string | null }[]>`
          SELECT "id", "defaultCurrency" FROM "company" WHERE "id" = ${companyId}::uuid FOR SHARE`;
        const company = companyRows[0];
        if (!company) throw new NotFoundError('company');
        if (company.defaultCurrency === null) {
          throw new DomainError(
            'COMPANY_CURRENCY_UNSET',
            'this company has no default currency configured — it cannot price its catalog',
            409,
          );
        }

        // 2. variant FOR SHARE — serialises against setBaseUom's FOR UPDATE (Inv-1)
        const variantRows = await tx.$queryRaw<
          { id: string; productId: string; baseUomCode: string | null }[]
        >`SELECT "id", "productId", "baseUomCode" FROM "variant" WHERE "id" = ${variantId}::uuid FOR SHARE`;
        const variant = variantRows[0];
        if (!variant) throw new NotFoundError('variant');
        if (variant.baseUomCode === null) {
          throw new DomainError(
            'VARIANT_BASE_UOM_REQUIRED',
            'set the variant base UOM before pricing this variant (standard company pricing needs a base)',
            409,
          );
        }
        const base = variant.baseUomCode;

        // 3. get-or-create + lock the aggregate (no raw P2002, no 500)
        const inserted = await tx.$queryRaw<{ id: string; version: number }[]>`
          INSERT INTO "company_variant_price_set" ("id","tenantId","companyId","variantId","version","updatedAt")
          VALUES (uuidv7(), ${tenantId}::uuid, ${companyId}::uuid, ${variantId}::uuid, 1, now())
          ON CONFLICT ("tenantId","companyId","variantId") DO NOTHING
          RETURNING "id","version"`;

        let aggId: string;
        let existedBefore: boolean;
        let previousVersion: number;
        let nextVersion: number;
        if (inserted.length > 0) {
          aggId = inserted[0]!.id;
          existedBefore = false;
          previousVersion = 0;
          nextVersion = 1; // the row is ALREADY at version 1 — do NOT bump it again
        } else {
          // may have BLOCKED above until a concurrent uncommitted insert resolved
          const locked = await tx.$queryRaw<{ id: string; version: number }[]>`
            SELECT "id","version" FROM "company_variant_price_set"
            WHERE "tenantId" = ${tenantId}::uuid
              AND "companyId" = ${companyId}::uuid
              AND "variantId" = ${variantId}::uuid
            FOR UPDATE`;
          if (locked.length === 0) throw versionConflict('price_set', ifMatch, 0);
          aggId = locked[0]!.id;
          existedBefore = true;
          previousVersion = locked[0]!.version;
          nextVersion = previousVersion + 1;
        }

        // 4. If-Match precondition, validated against previousVersion
        if (ifMatch === 0) {
          if (existedBefore) throw versionConflict('price_set', 0, previousVersion);
        } else if (!existedBefore || previousVersion !== ifMatch) {
          throw versionConflict('price_set', ifMatch, existedBefore ? previousVersion : 0);
        }

        // 5. validate every entry (legitimacy only — NEVER derive the price)
        const registry = await loadEffectiveVariantRegistry(tx, {
          id: variantId,
          productId: variant.productId,
          baseUomCode: base,
        });
        const seen = new Set<string>();
        const normalized: { uomCode: string; money: Money }[] = [];
        for (const e of entries) {
          const uomCode = requireUomCode(e.uomCode);
          if (!isBuiltinUom(uomCode)) {
            const existing = await tx.uom.count({ where: { code: uomCode } });
            if (existing === 0) {
              throw new DomainError(
                'PRICE_UOM_NOT_REGISTERED',
                `unit "${uomCode}" is not a built-in and is not registered for this tenant`,
                422,
                [{ field: 'uomCode', issue: 'unknown UOM code' }],
              );
            }
          }
          if (uomCode !== base) {
            assertReachable(registry, uomCode, base);
          }
          if (seen.has(uomCode)) {
            throw new DomainError(
              'PRICE_UOM_DUPLICATE',
              `unit "${uomCode}" appears more than once`,
              422,
            );
          }
          seen.add(uomCode);
          normalized.push({ uomCode, money: assertSellMoney(e.sell, company.defaultCurrency) });
        }

        // 6. lock every tenant-custom code this write references (FOR KEY SHARE)
        await UomRepository.lockCustomUomRefs(
          tx,
          normalized.map((n) => n.uomCode),
        );

        // before-snapshot for the audit
        const beforeRows = await tx.companyVariantUomPrice.findMany({
          where: { companyId, variantId },
          select: { uomCode: true, sellAmountMinor: true, sellCurrencyCode: true },
        });

        // 7. replace existing price rows
        await tx.companyVariantUomPrice.deleteMany({ where: { companyId, variantId } });
        // 8. write the new price rows
        if (normalized.length > 0) {
          await tx.companyVariantUomPrice.createMany({
            data: normalized.map((n) => ({
              tenantId,
              companyId,
              variantId,
              uomCode: n.uomCode,
              sellAmountMinor: n.money.amountMinor,
              sellCurrencyCode: n.money.currency,
              sellCurrencyExponent: n.money.exponent,
            })),
          });
        }

        // 9. bump the aggregate version ONLY when it already existed
        //    (a newly created row is already at version 1 == nextVersion)
        if (existedBefore) {
          await tx.companyVariantPriceSet.update({
            where: { id: aggId },
            data: { version: nextVersion },
          });
        }

        // 10. one audit row per replace-set mutation (D2-10) — sell map only (D-6)
        await this.audit.record(tx, {
          action: 'catalog.company_price_changed',
          resourceType: 'company_variant_price_set',
          resourceId: aggId,
          before: { companyId, variantId, prices: sellMapFromRows(beforeRows) },
          after: {
            companyId,
            variantId,
            count: normalized.length,
            prices: sellMapFromNormalized(normalized),
          },
        });
      });
    } catch (e) {
      if (e instanceof DomainError) throw e;
      mapPricingDbError(e); // throws — a known FK/unique race → deterministic; else re-thrown as-is
    }
    // 11. return the fresh view + version
    return this.getForCompanyVariant(companyId, variantId);
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  private scopeKey(companyId: string, variantId: string) {
    return { tenantId: requireTenantContext().tenantId, companyId, variantId };
  }

  /** Load the company + variant a read targets, or 404. Company scope is the
   *  guard-pipeline `@ScopedParam` step; RLS scopes to the tenant. */
  private async loadCompanyVariant(
    tx: ScopedTx,
    companyId: string,
    variantId: string,
  ): Promise<{
    company: { id: string; defaultCurrency: string | null };
    variant: { id: string; productId: string; baseUomCode: string | null };
  }> {
    const [company, variant] = await Promise.all([
      tx.company.findUnique({
        where: { id: companyId },
        select: { id: true, defaultCurrency: true },
      }),
      tx.variant.findUnique({
        where: { id: variantId },
        select: { id: true, productId: true, baseUomCode: true },
      }),
    ]);
    if (!company) throw new NotFoundError('company');
    if (!variant) throw new NotFoundError('variant');
    return { company, variant };
  }

  /** A `(code) => boolean` "does this UOM currently resolve to the variant base"
   *  predicate. `false` for every code when the variant has no base. Builds the
   *  effective registry once. NEVER used to derive a price. */
  private async reachabilityFn(
    tx: ScopedTx,
    variant: { id: string; productId: string; baseUomCode: string | null },
  ): Promise<(code: string) => boolean> {
    if (variant.baseUomCode === null) return () => false;
    const base = variant.baseUomCode;
    const registry = await loadEffectiveVariantRegistry(tx, {
      id: variant.id,
      productId: variant.productId,
      baseUomCode: base,
    });
    return (code: string) => {
      if (code === base) return true;
      try {
        registry.convert(Quantity.parse('1'), code, base);
        return true;
      } catch {
        return false;
      }
    };
  }
}

/** Reachability check — legitimacy only. The conversion result is discarded;
 *  Task 3.7 NEVER prices a UOM by `base_price × ratio` (ADR-0018 §5 / D-4). */
function assertReachable(registry: UomRegistry, uomCode: string, base: string): void {
  try {
    registry.convert(Quantity.parse('1'), uomCode, base);
  } catch {
    throw new DomainError(
      'PRICE_UOM_UNREACHABLE',
      `unit "${uomCode}" cannot be resolved to the variant base UOM "${base}" — ` +
        `add an explicit scoped conversion or model one side as an EACH unit`,
      422,
      [{ field: 'uomCode', issue: 'not reachable to the base UOM' }],
    );
  }
}

function sellMapFromRows(
  rows: { uomCode: string; sellAmountMinor: bigint; sellCurrencyCode: string }[],
): Record<string, { sellAmountMinor: string; sellCurrencyCode: string }> {
  const out: Record<string, { sellAmountMinor: string; sellCurrencyCode: string }> = {};
  for (const r of rows) {
    out[r.uomCode] = {
      sellAmountMinor: r.sellAmountMinor.toString(),
      sellCurrencyCode: r.sellCurrencyCode,
    };
  }
  return out;
}

function sellMapFromNormalized(
  normalized: { uomCode: string; money: Money }[],
): Record<string, { sellAmountMinor: string; sellCurrencyCode: string }> {
  const out: Record<string, { sellAmountMinor: string; sellCurrencyCode: string }> = {};
  for (const n of normalized) {
    out[n.uomCode] = {
      sellAmountMinor: n.money.amountMinor.toString(),
      sellCurrencyCode: n.money.currency,
    };
  }
  return out;
}
