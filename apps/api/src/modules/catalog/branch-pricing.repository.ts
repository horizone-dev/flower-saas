import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { Money, type MoneyDTO } from '@flower/money';
import { Quantity, type UomRegistry } from '@flower/uom';
import type {
  BranchVariantPriceSetView,
  ResolvedBranchPrice,
  BranchAvailabilityView,
  BranchAvailabilitySetResult,
  BranchEffectiveCatalogEntry,
} from '@flower/shared-types';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext, type ScopeSet } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { versionConflict } from './catalog-write.helpers.js';
import { isBuiltinUom } from './uom.helpers.js';
import { UomRepository, loadEffectiveVariantRegistry } from './uom.repository.js';
import {
  assertBranchOverrideMoney,
  mapBranchPricingDbError,
  requireUomCode,
  storedOverrideToDto,
  type BranchPriceEntryInput,
} from './branch-pricing.helpers.js';

const OVERRIDE_SELECT = {
  uomCode: true,
  overrideAmountMinor: true,
  overrideCurrencyCode: true,
  overrideCurrencyExponent: true,
} as const;

/**
 * Task 3.8 — branch price override + branch availability (tenant + company +
 * BRANCH scoped). Scope-freeze rev.5.
 *
 *  - `branch_variant_price_set` is the branch-price concurrency aggregate — it
 *    carries the `version` (`If-Match` — NEVER `variant.version`, BD-3), is
 *    INDEPENDENTLY MONOTONIC (created at 1, only incremented, never reset/deleted
 *    — there is NO `DELETE …/prices`, BD-4), and MAY exist with zero override
 *    rows and zero company pricing (a first `PUT { prices: [] } If-Match "0"`
 *    creates it — Correction 2). `PUT []` deletes the rows + bumps the version.
 *  - `branch_variant_uom_price` holds the INDEPENDENT stored SELL override Money
 *    per selling UOM tier — never `company_price × factor` (ADR-0018 §5). A
 *    priced UOM must be the base OR reachable to it via the Task 3.6 effective
 *    model AND must have a matching `company_variant_uom_price` row (BD-1).
 *  - Company↔branch price-ROW integrity is synchronized through the Task 3.7
 *    `company_variant_price_set` aggregate as the SHARED LOCK (branch write:
 *    `FOR SHARE`; Task 3.7 company `replace()`: `FOR UPDATE`).
 *
 * Lock order (extends Task 3.7 / 3.6, no cycle):
 *   [step 0 unlocked branch pre-read] → company (FOR SHARE) → branch (FOR SHARE)
 *   → variant (FOR SHARE) → company_variant_price_set (FOR SHARE)
 *   → branch_variant_price_set (INSERT…ON CONFLICT / FOR UPDATE) → uom (FOR KEY SHARE).
 * `companyId` is DERIVED from the authorized branch — never a client value.
 */
@Injectable()
export class BranchPricingRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  private scopeKey(companyId: string, branchId: string, variantId: string) {
    return { tenantId: requireTenantContext().tenantId, companyId, branchId, variantId };
  }

  private companyScope(): ScopeSet {
    return requireTenantContext().companyScope;
  }

  /**
   * Load the branch (→ its owning `companyId`) + the variant a request targets,
   * enforcing that the branch belongs to a company the caller is scoped to
   * (`@ScopedParam` already checked branch scope; the guard does not check
   * company scope for a branch-only route — §3.0 step 3, defence-in-depth).
   */
  private async loadBranchVariant(
    tx: ScopedTx,
    branchId: string,
    variantId: string,
  ): Promise<{
    companyId: string;
    company: { defaultCurrency: string | null };
    variant: { id: string; productId: string; baseUomCode: string | null };
  }> {
    const branch = await tx.branch.findUnique({
      where: { id: branchId },
      select: { id: true, companyId: true },
    });
    if (!branch) throw new NotFoundError('resource');
    if (!scopeAllows(this.companyScope(), branch.companyId)) throw new NotFoundError('resource');
    const [company, variant] = await Promise.all([
      tx.company.findUnique({ where: { id: branch.companyId }, select: { defaultCurrency: true } }),
      tx.variant.findUnique({
        where: { id: variantId },
        select: { id: true, productId: true, baseUomCode: true },
      }),
    ]);
    if (!company) throw new NotFoundError('company');
    if (!variant) throw new NotFoundError('variant');
    return { companyId: branch.companyId, company, variant };
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
    return reachablePredicate(registry, base);
  }

  private async branchAvailable(
    tx: ScopedTx,
    companyId: string,
    branchId: string,
    variantId: string,
  ): Promise<boolean> {
    const row = await tx.branchVariantAvailability.findUnique({
      where: {
        tenantId_companyId_branchId_variantId: this.scopeKey(companyId, branchId, variantId),
      },
      select: { available: true },
    });
    return row?.available ?? true;
  }

  // ── GET /branches/:branchId/variants/:variantId/prices ────────────────────
  getForBranchVariant(branchId: string, variantId: string): Promise<BranchVariantPriceSetView> {
    return this.scoped(async (tx) => {
      const { companyId, variant } = await this.loadBranchVariant(tx, branchId, variantId);
      const [agg, rows] = await Promise.all([
        tx.branchVariantPriceSet.findUnique({
          where: {
            tenantId_companyId_branchId_variantId: this.scopeKey(companyId, branchId, variantId),
          },
          select: { version: true },
        }),
        tx.branchVariantUomPrice.findMany({
          where: { companyId, branchId, variantId },
          orderBy: { uomCode: 'asc' },
          select: OVERRIDE_SELECT,
        }),
      ]);
      const reachable = await this.reachabilityFn(tx, variant);
      return {
        version: agg?.version ?? 0,
        priceSetExists: agg != null,
        prices: rows.map((r) => ({
          uomCode: r.uomCode,
          sell: storedOverrideToDto(r),
          resolvable: reachable(r.uomCode),
        })),
      };
    });
  }

  // ── GET /branches/:branchId/variants/:variantId/prices/resolve?uomCode= ───
  resolve(branchId: string, variantId: string, rawUomCode: string): Promise<ResolvedBranchPrice> {
    const uomCode = requireUomCode(rawUomCode); // 422 UOM_INVALID_CODE on a malformed code, BEFORE any DB access
    return this.scoped(async (tx) => {
      const { companyId, variant } = await this.loadBranchVariant(tx, branchId, variantId);
      const branchAvailable = await this.branchAvailable(tx, companyId, branchId, variantId);

      const companyAgg = await tx.companyVariantPriceSet.findUnique({
        where: { tenantId_companyId_variantId: this.companyScopeKey(companyId, variantId) },
        select: { version: true },
      });
      if (!companyAgg) {
        return { price: null, source: null, reason: 'NO_PRICE_SET' as const, branchAvailable };
      }

      const [branchRow, companyRow, reachable] = await Promise.all([
        tx.branchVariantUomPrice.findUnique({
          where: {
            tenantId_companyId_branchId_variantId_uomCode: {
              ...this.scopeKey(companyId, branchId, variantId),
              uomCode,
            },
          },
          select: OVERRIDE_SELECT,
        }),
        tx.companyVariantUomPrice.findUnique({
          where: {
            tenantId_companyId_variantId_uomCode: {
              ...this.companyScopeKey(companyId, variantId),
              uomCode,
            },
          },
          select: {
            sellAmountMinor: true,
            sellCurrencyCode: true,
            sellCurrencyExponent: true,
          },
        }),
        this.reachabilityFn(tx, variant).then((fn) => fn(uomCode)),
      ]);

      if (branchRow) {
        return reachable
          ? {
              price: storedOverrideToDto(branchRow),
              source: 'BRANCH' as const,
              reason: null,
              branchAvailable,
            }
          : { price: null, source: null, reason: 'UOM_UNRESOLVABLE' as const, branchAvailable };
      }
      if (companyRow) {
        return reachable
          ? {
              price: Money.ofMinor(companyRow.sellAmountMinor, companyRow.sellCurrencyCode).toDTO(),
              source: 'COMPANY' as const,
              reason: null,
              branchAvailable,
            }
          : { price: null, source: null, reason: 'UOM_UNRESOLVABLE' as const, branchAvailable };
      }
      return reachable
        ? { price: null, source: null, reason: 'UOM_NOT_PRICED' as const, branchAvailable }
        : { price: null, source: null, reason: 'UOM_UNRESOLVABLE' as const, branchAvailable };
    });
  }

  private companyScopeKey(companyId: string, variantId: string) {
    return { tenantId: requireTenantContext().tenantId, companyId, variantId };
  }

  // ── PUT /branches/:branchId/variants/:variantId/prices ────────────────────
  async replace(
    branchId: string,
    variantId: string,
    entries: readonly BranchPriceEntryInput[],
    ifMatch: number,
  ): Promise<BranchVariantPriceSetView> {
    const tenantId = requireTenantContext().tenantId;
    const empty = entries.length === 0;
    try {
      return await this.scoped(async (tx): Promise<BranchVariantPriceSetView> => {
        // ── step 0 — unlocked, RLS-scoped pre-read to derive companyId (NOT a
        //    lock; does not participate in lock ordering, Correction B).
        const preRows = await tx.$queryRaw<{ companyId: string }[]>`
          SELECT "companyId" FROM "branch" WHERE "id" = ${branchId}::uuid`;
        if (preRows.length === 0) throw new NotFoundError('resource');
        const candidateCompanyId = preRows[0]!.companyId;

        // ── step 1 — company FOR SHARE (candidate). Serialises against a future
        //    company.defaultCurrency change.
        const companyRows = await tx.$queryRaw<{ id: string; defaultCurrency: string | null }[]>`
          SELECT "id", "defaultCurrency" FROM "company" WHERE "id" = ${candidateCompanyId}::uuid FOR SHARE`;
        const company = companyRows[0];
        if (!company) throw new NotFoundError('company');

        // ── step 2 — branch FOR SHARE.
        const branchRows = await tx.$queryRaw<{ id: string; companyId: string }[]>`
          SELECT "id", "companyId" FROM "branch" WHERE "id" = ${branchId}::uuid FOR SHARE`;
        const branch = branchRows[0];
        if (!branch) throw new NotFoundError('resource');

        // ── step 3 — revalidate under the branch lock (Correction B).
        if (branch.companyId !== candidateCompanyId) {
          throw new DomainError(
            'BRANCH_COMPANY_CHANGED',
            'the branch was reassigned to a different company mid-request — retry',
            409,
          );
        }
        if (!scopeAllows(this.companyScope(), branch.companyId))
          throw new NotFoundError('resource');
        const companyId = branch.companyId;

        // ── step 4 — variant FOR SHARE. `baseUomCode` read here, under this
        //    transaction's own lock, is authoritative (Correction 3).
        const variantRows = await tx.$queryRaw<
          { id: string; productId: string; baseUomCode: string | null }[]
        >`SELECT "id", "productId", "baseUomCode" FROM "variant" WHERE "id" = ${variantId}::uuid FOR SHARE`;
        const variant = variantRows[0];
        if (!variant) throw new NotFoundError('variant');

        // non-empty preconditions (Correction 2 — an empty PUT needs neither).
        if (!empty) {
          if (company.defaultCurrency === null) {
            throw new DomainError(
              'COMPANY_CURRENCY_UNSET',
              'this company has no default currency configured — it cannot price its catalog',
              409,
            );
          }
          if (variant.baseUomCode === null) {
            throw new DomainError(
              'VARIANT_BASE_UOM_REQUIRED',
              'set the variant base UOM before pricing this variant',
              409,
            );
          }
        }

        // ── step 5 — company_variant_price_set FOR SHARE — the SYNCHRONIZATION
        //    point with Task 3.7 company `replace()` (which takes it FOR UPDATE).
        //    0 rows + empty ⇒ nothing to protect; 0 rows + non-empty ⇒ step 6
        //    422s; ≥1 row ⇒ the SHARE lock is held through commit.
        await tx.$queryRaw`
          SELECT "id" FROM "company_variant_price_set"
           WHERE "tenantId" = ${tenantId}::uuid
             AND "companyId" = ${companyId}::uuid
             AND "variantId" = ${variantId}::uuid
           FOR SHARE`;

        // ── step 6 — validate every entry (legitimacy only — NEVER derive the
        //    price) + BD-1 (a matching company UOM price must exist).
        let registry: UomRegistry | null = null;
        const normalized: { uomCode: string; money: Money }[] = [];
        if (!empty) {
          const base = variant.baseUomCode!;
          registry = await loadEffectiveVariantRegistry(tx, {
            id: variantId,
            productId: variant.productId,
            baseUomCode: base,
          });
          const seen = new Set<string>();
          for (const e of entries) {
            const uomCode = requireUomCode(e.uomCode);
            if (!isBuiltinUom(uomCode)) {
              const existing = await tx.uom.count({ where: { code: uomCode } });
              if (existing === 0) {
                throw new DomainError(
                  'BRANCH_PRICE_UOM_NOT_REGISTERED',
                  `unit "${uomCode}" is not a built-in and is not registered for this tenant`,
                  422,
                  [{ field: 'uomCode', issue: 'unknown UOM code' }],
                );
              }
            }
            if (uomCode !== base) assertReachable(registry, uomCode, base);
            if (seen.has(uomCode)) {
              throw new DomainError(
                'BRANCH_PRICE_UOM_DUPLICATE',
                `unit "${uomCode}" appears more than once`,
                422,
              );
            }
            seen.add(uomCode);
            const companyPriced = await tx.companyVariantUomPrice.count({
              where: { companyId, variantId, uomCode },
            });
            if (companyPriced === 0) {
              throw new DomainError(
                'BRANCH_PRICE_NO_COMPANY_PRICE',
                `unit "${uomCode}" has no company price — a branch override requires a company price for that UOM`,
                422,
                [{ field: 'uomCode', issue: 'no matching company price' }],
              );
            }
            normalized.push({
              uomCode,
              money: assertBranchOverrideMoney(e.sell, company.defaultCurrency!),
            });
          }
        }

        // ── step 7 — get-or-create + lock the branch aggregate (no raw P2002).
        const inserted = await tx.$queryRaw<{ id: string; version: number }[]>`
          INSERT INTO "branch_variant_price_set" ("id","tenantId","companyId","branchId","variantId","version","updatedAt")
          VALUES (uuidv7(), ${tenantId}::uuid, ${companyId}::uuid, ${branchId}::uuid, ${variantId}::uuid, 1, now())
          ON CONFLICT ("tenantId","companyId","branchId","variantId") DO NOTHING
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
          const locked = await tx.$queryRaw<{ id: string; version: number }[]>`
            SELECT "id","version" FROM "branch_variant_price_set"
             WHERE "tenantId" = ${tenantId}::uuid
               AND "companyId" = ${companyId}::uuid
               AND "branchId" = ${branchId}::uuid
               AND "variantId" = ${variantId}::uuid
             FOR UPDATE`;
          if (locked.length === 0) throw versionConflict('branch_price_set', ifMatch, 0);
          aggId = locked[0]!.id;
          existedBefore = true;
          previousVersion = locked[0]!.version;
          nextVersion = previousVersion + 1;
        }

        // ── step 8 — If-Match vs previousVersion. Once the aggregate has ever
        //    existed, `If-Match: "0"` can never succeed again (BD-4 — monotonic,
        //    no ABA window).
        if (ifMatch === 0) {
          if (existedBefore) throw versionConflict('branch_price_set', 0, previousVersion);
        } else if (!existedBefore || previousVersion !== ifMatch) {
          throw versionConflict('branch_price_set', ifMatch, existedBefore ? previousVersion : 0);
        }

        // ── step 9 — lock every tenant-custom code this write references.
        if (!empty) {
          await UomRepository.lockCustomUomRefs(
            tx,
            normalized.map((n) => n.uomCode),
          );
        }

        // before-snapshot for the audit
        const beforeRows = await tx.branchVariantUomPrice.findMany({
          where: { companyId, branchId, variantId },
          select: { uomCode: true, overrideAmountMinor: true, overrideCurrencyCode: true },
        });

        // ── step 10 — replace the override rows.
        await tx.branchVariantUomPrice.deleteMany({ where: { companyId, branchId, variantId } });
        if (normalized.length > 0) {
          await tx.branchVariantUomPrice.createMany({
            data: normalized.map((n) => ({
              tenantId,
              companyId,
              branchId,
              variantId,
              uomCode: n.uomCode,
              overrideAmountMinor: n.money.amountMinor,
              overrideCurrencyCode: n.money.currency,
              overrideCurrencyExponent: n.money.exponent,
            })),
          });
        }

        // ── step 11 — bump the aggregate version ONLY when it already existed.
        if (existedBefore) {
          await tx.branchVariantPriceSet.update({
            where: { id: aggId },
            data: { version: nextVersion },
          });
        }

        // ── step 12 — one audit row per replace-set mutation. THIS branch's
        //    SELL-override map only — no sibling branch data, no purchase.
        await this.audit.record(tx, {
          action: 'catalog.branch_price_changed',
          resourceType: 'branch_variant_price_set',
          resourceId: aggId,
          before: { companyId, branchId, variantId, prices: overrideMapFromRows(beforeRows) },
          after: {
            companyId,
            branchId,
            variantId,
            count: normalized.length,
            prices: overrideMapFromNormalized(normalized),
          },
        });

        // ── step 13 — build THIS mutation's result FROM THE TRANSACTION (never
        //    a post-commit GET — Task 3.7 FIX 1 precedent).
        const reachable = (code: string): boolean => {
          if (registry === null) return true; // empty PUT — no rows
          if (code === variant.baseUomCode) return true;
          try {
            registry.convert(Quantity.parse('1'), code, variant.baseUomCode!);
            return true;
          } catch {
            return false;
          }
        };
        return {
          version: nextVersion,
          priceSetExists: true,
          prices: normalized
            .map((n) => ({
              uomCode: n.uomCode,
              sell: n.money.toDTO(),
              resolvable: reachable(n.uomCode),
            }))
            .sort((a, b) => a.uomCode.localeCompare(b.uomCode)),
        };
      });
    } catch (e) {
      if (e instanceof DomainError) throw e;
      return mapBranchPricingDbError(e);
    }
  }

  // ── PUT /branches/:branchId/availability (bulk, atomic) ───────────────────
  async setAvailability(
    branchId: string,
    entries: readonly { variantId: string; available: boolean }[],
  ): Promise<BranchAvailabilitySetResult> {
    const tenantId = requireTenantContext().tenantId;
    return this.scoped(async (tx): Promise<BranchAvailabilitySetResult> => {
      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true, companyId: true },
      });
      if (!branch) throw new NotFoundError('resource');
      if (!scopeAllows(this.companyScope(), branch.companyId)) throw new NotFoundError('resource');
      const companyId = branch.companyId;

      // validate EVERY entry BEFORE any mutation (all-or-nothing).
      const wanted = entries.map((e) => e.variantId);
      const found = await tx.variant.findMany({
        where: { id: { in: wanted } },
        select: { id: true },
      });
      const foundSet = new Set(found.map((v) => v.id));
      for (const e of entries) {
        if (!foundSet.has(e.variantId)) {
          throw new DomainError(
            'BRANCH_AVAILABILITY_VARIANT_NOT_FOUND',
            `variant "${e.variantId}" does not exist in this tenant`,
            422,
            [{ field: 'variantId', issue: 'unknown variant' }],
          );
        }
      }

      const beforeRows = await tx.branchVariantAvailability.findMany({
        where: { companyId, branchId, variantId: { in: wanted } },
        select: { variantId: true, available: true },
      });
      const beforeMap = new Map(beforeRows.map((r) => [r.variantId, r.available]));

      for (const e of entries) {
        await tx.branchVariantAvailability.upsert({
          where: {
            tenantId_companyId_branchId_variantId: {
              tenantId,
              companyId,
              branchId,
              variantId: e.variantId,
            },
          },
          create: { tenantId, companyId, branchId, variantId: e.variantId, available: e.available },
          update: { available: e.available },
        });
      }

      await this.audit.record(tx, {
        action: 'catalog.branch_availability_changed',
        resourceType: 'branch',
        resourceId: branchId,
        before: {
          companyId,
          branchId,
          variants: Object.fromEntries(
            entries.map((e) => [
              e.variantId,
              {
                available: beforeMap.get(e.variantId) ?? true,
                explicit: beforeMap.has(e.variantId),
              },
            ]),
          ),
        },
        after: {
          companyId,
          branchId,
          variants: Object.fromEntries(
            entries.map((e) => [e.variantId, { available: e.available, explicit: true }]),
          ),
        },
      });

      return {
        entries: entries
          .map((e) => ({ variantId: e.variantId, available: e.available, explicit: true }))
          .sort((a, b) => a.variantId.localeCompare(b.variantId)),
      };
    });
  }

  // ── GET /branches/:branchId/availability[?variantId=] ─────────────────────
  getAvailability(branchId: string, variantId?: string): Promise<BranchAvailabilityView[]> {
    return this.scoped(async (tx): Promise<BranchAvailabilityView[]> => {
      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true, companyId: true },
      });
      if (!branch) throw new NotFoundError('resource');
      if (!scopeAllows(this.companyScope(), branch.companyId)) throw new NotFoundError('resource');
      const companyId = branch.companyId;

      if (variantId !== undefined) {
        const variant = await tx.variant.findUnique({
          where: { id: variantId },
          select: { id: true },
        });
        if (!variant) throw new NotFoundError('variant'); // unknown / cross-tenant → 404 (Correction E)
        const row = await tx.branchVariantAvailability.findUnique({
          where: {
            tenantId_companyId_branchId_variantId: this.scopeKey(companyId, branchId, variantId),
          },
          select: { available: true },
        });
        return [
          row
            ? { variantId, available: row.available, explicit: true }
            : { variantId, available: true, explicit: false },
        ];
      }

      const rows = await tx.branchVariantAvailability.findMany({
        where: { companyId, branchId },
        orderBy: { variantId: 'asc' },
        select: { variantId: true, available: true },
      });
      return rows.map((r) => ({ variantId: r.variantId, available: r.available, explicit: true }));
    });
  }

  // ── GET /branches/:branchId/catalog (cursor paginated) ────────────────────
  effectiveCatalog(
    branchId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: BranchEffectiveCatalogEntry[]; nextCursor: string | null }> {
    return this.scoped(async (tx) => {
      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true, companyId: true },
      });
      if (!branch) throw new NotFoundError('resource');
      if (!scopeAllows(this.companyScope(), branch.companyId)) throw new NotFoundError('resource');
      const companyId = branch.companyId;

      // one entry per variant for which THIS company has ≥ 1 current company
      // price row — there is no "company-owned variant" concept; this is purely
      // "the branch's company has priced this variant" (BD-14 / effective-catalog
      // wording). Ordered + cursored by variantId for a stable page.
      const distinctRows = await tx.companyVariantUomPrice.findMany({
        where: {
          companyId,
          ...(cursor !== undefined ? { variantId: { gt: cursor } } : {}),
        },
        distinct: ['variantId'],
        orderBy: { variantId: 'asc' },
        take: limit + 1,
        select: { variantId: true },
      });
      const page = distinctRows.slice(0, limit);
      const nextCursor =
        distinctRows.length > limit ? (page[page.length - 1]?.variantId ?? null) : null;
      if (page.length === 0) return { entries: [], nextCursor: null };

      const variantIds = page.map((p) => p.variantId);
      const [variants, companyRows, branchRows, availRows] = await Promise.all([
        tx.variant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, productId: true, baseUomCode: true },
        }),
        tx.companyVariantUomPrice.findMany({
          where: { companyId, variantId: { in: variantIds } },
          select: {
            variantId: true,
            uomCode: true,
            sellAmountMinor: true,
            sellCurrencyCode: true,
          },
        }),
        tx.branchVariantUomPrice.findMany({
          where: { companyId, branchId, variantId: { in: variantIds } },
          select: {
            variantId: true,
            uomCode: true,
            overrideAmountMinor: true,
            overrideCurrencyCode: true,
          },
        }),
        tx.branchVariantAvailability.findMany({
          where: { companyId, branchId, variantId: { in: variantIds } },
          select: { variantId: true, available: true },
        }),
      ]);

      const branchMap = groupByVariant(
        branchRows.map((r) => ({
          variantId: r.variantId,
          uomCode: r.uomCode,
          amt: r.overrideAmountMinor,
          cur: r.overrideCurrencyCode,
        })),
      );
      const companyMap = groupByVariant(
        companyRows.map((r) => ({
          variantId: r.variantId,
          uomCode: r.uomCode,
          amt: r.sellAmountMinor,
          cur: r.sellCurrencyCode,
        })),
      );
      const availMap = new Map(availRows.map((r) => [r.variantId, r.available]));
      const variantById = new Map(variants.map((v) => [v.id, v]));

      const entries: BranchEffectiveCatalogEntry[] = [];
      for (const vid of variantIds) {
        const v = variantById.get(vid);
        if (!v) continue;
        const reachable =
          v.baseUomCode === null
            ? (): boolean => false
            : reachablePredicate(
                await loadEffectiveVariantRegistry(tx, {
                  id: v.id,
                  productId: v.productId,
                  baseUomCode: v.baseUomCode,
                }),
                v.baseUomCode,
              );
        const cMap = companyMap.get(vid) ?? new Map<string, { amt: bigint; cur: string }>();
        const bMap = branchMap.get(vid) ?? new Map<string, { amt: bigint; cur: string }>();
        const uomCodes = [...new Set([...cMap.keys(), ...bMap.keys()])].sort();
        const prices = uomCodes.map((uomCode) => {
          const b = bMap.get(uomCode);
          const chosen = b ?? cMap.get(uomCode)!;
          return {
            uomCode,
            sell: Money.ofMinor(chosen.amt, chosen.cur).toDTO() as MoneyDTO,
            source: (b ? 'BRANCH' : 'COMPANY') as 'BRANCH' | 'COMPANY',
            resolvable: reachable(uomCode),
          };
        });
        entries.push({
          variantId: vid,
          productId: v.productId,
          available: availMap.get(vid) ?? true,
          prices,
        });
      }
      return { entries, nextCursor };
    });
  }
}

// ── shared helpers ─────────────────────────────────────────────────────────

const scopeAllows = (scope: ScopeSet, id: string): boolean => scope === 'ALL' || scope.includes(id);

function groupByVariant(
  rows: readonly { variantId: string; uomCode: string; amt: bigint; cur: string }[],
): Map<string, Map<string, { amt: bigint; cur: string }>> {
  const out = new Map<string, Map<string, { amt: bigint; cur: string }>>();
  for (const r of rows) {
    let m = out.get(r.variantId);
    if (!m) {
      m = new Map();
      out.set(r.variantId, m);
    }
    m.set(r.uomCode, { amt: r.amt, cur: r.cur });
  }
  return out;
}

function reachablePredicate(registry: UomRegistry, base: string): (code: string) => boolean {
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

/** Reachability check — legitimacy only. The conversion result is discarded;
 *  Task 3.8 NEVER prices a UOM by `company_price × ratio` (ADR-0018 §5). */
function assertReachable(registry: UomRegistry, uomCode: string, base: string): void {
  try {
    registry.convert(Quantity.parse('1'), uomCode, base);
  } catch {
    throw new DomainError(
      'BRANCH_PRICE_UOM_UNREACHABLE',
      `unit "${uomCode}" cannot be resolved to the variant base UOM "${base}" — ` +
        `add an explicit scoped conversion or model one side as an EACH unit`,
      422,
      [{ field: 'uomCode', issue: 'not reachable to the base UOM' }],
    );
  }
}

function overrideMapFromRows(
  rows: { uomCode: string; overrideAmountMinor: bigint; overrideCurrencyCode: string }[],
): Record<string, { amountMinor: string; currencyCode: string }> {
  const out: Record<string, { amountMinor: string; currencyCode: string }> = {};
  for (const r of rows) {
    out[r.uomCode] = {
      amountMinor: r.overrideAmountMinor.toString(),
      currencyCode: r.overrideCurrencyCode,
    };
  }
  return out;
}

function overrideMapFromNormalized(
  normalized: { uomCode: string; money: Money }[],
): Record<string, { amountMinor: string; currencyCode: string }> {
  const out: Record<string, { amountMinor: string; currencyCode: string }> = {};
  for (const n of normalized) {
    out[n.uomCode] = {
      amountMinor: n.money.amountMinor.toString(),
      currencyCode: n.money.currency,
    };
  }
  return out;
}
