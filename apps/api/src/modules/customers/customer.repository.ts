import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { currencyExponent, isKnownCurrency } from '@flower/money';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, ForbiddenError } from '../../common/errors/domain-error.js';
import { isPgError } from '../../common/errors/pg-error.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { normalizePhoneE164, normalizeEmail } from './normalization.js';

const PG_CHECK_VIOLATION = '23514';
const PG_FK_VIOLATION = '23503';

export interface CustomerRow {
  id: string;
  tenantId: string;
  displayName: string;
  phoneE164: string | null;
  emailNormalized: string | null;
  status: string;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerCompanyAccountRow {
  id: string;
  tenantId: string;
  companyId: string;
  customerId: string;
  creditEnabled: boolean;
  creditLimitMinor: bigint | null;
  creditLimitCurrencyCode: string | null;
  creditLimitCurrencyExponent: number | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Task 3b.2 — Customer + CustomerCompanyAccount domain repository.
 *
 * COMPANY PII ISOLATION (the core safety property, docs/phase-3/PHASE-3B-PLAN.md
 * task 3b.2 scope review §8-9): `Customer` is tenant-scoped identity, never
 * duplicated per company. A Company/Branch-scoped caller may ONLY reach a
 * Customer THROUGH an existing `customer_company_account` row for their
 * authorized company — every `*ForCompanyScoped`/`*ForCompany` method below
 * joins through that association table with no optional/skippable filter.
 * `*ForTenantScoped`/`*ForTenant` are the SEPARATE, explicitly-named tenant-
 * wide path — nothing in this file lets a Company-scoped caller reach it by
 * accident (no `includeAllCompanies`-shaped parameter exists anywhere here).
 */
@Injectable()
export class CustomerRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
    private readonly companyFinancialConfig: CompanyFinancialConfigRepository,
  ) {
    super(db);
  }

  // ── company-scoped entry points ──────────────────────────────────────────

  /**
   * Standalone, transaction-independent read of `Company.countryCode`, tenant
   * + company scoped — the exact same query shape `createForCompany`/
   * `updateForCompany` already run inside their own domain transaction (lines
   * below), extracted as its own entry point for `CustomerCreateFingerprintProvider`
   * (task 3b.2 owner review round §3), which runs INSIDE the idempotency
   * interceptor — before any domain transaction opens. Read-only, cheap, uses
   * the same RLS-safe scoped-connection convention as every other read here.
   */
  async getCompanyCountryCodeScoped(companyId: string): Promise<string | null> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const rows = await tx.$queryRaw<{ countryCode: string | null }[]>`
        SELECT "countryCode" FROM "company" WHERE "id" = ${companyId}::uuid AND "tenantId" = ${tenantId}::uuid`;
      return rows[0]?.countryCode ?? null;
    });
  }

  async createForCompanyScoped(input: {
    companyId: string;
    displayName: string;
    phone?: string | null;
    email?: string | null;
    createdByUserId?: string | null;
  }): Promise<{ customer: CustomerRow; companyAccount: CustomerCompanyAccountRow }> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const result = await this.createForCompany(tx, { tenantId, ...input });
      await this.audit.record(tx, {
        action: 'customer.created',
        resourceType: 'customer',
        resourceId: result.customer.id,
        tenantId,
        companyId: input.companyId,
      });
      await this.audit.record(tx, {
        action: 'customer.company_account_created',
        resourceType: 'customer_company_account',
        resourceId: result.companyAccount.id,
        tenantId,
        companyId: input.companyId,
      });
      return result;
    });
  }

  async listForCompanyScoped(input: {
    companyId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.listForCompany(tx, { tenantId, ...input }));
  }

  async searchForCompanyScoped(input: {
    companyId: string;
    cursor?: string;
    limit?: number;
    displayNameQuery?: string;
    phoneE164?: string;
    emailNormalized?: string;
  }): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.searchForCompany(tx, { tenantId, ...input }));
  }

  async getForCompanyScoped(input: {
    companyId: string;
    customerId: string;
  }): Promise<CustomerRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.getForCompany(tx, { tenantId, ...input }));
  }

  async updateForCompanyScoped(input: {
    companyId: string;
    customerId: string;
    expectedVersion: number;
    displayName?: string;
    phone?: string | null;
    email?: string | null;
  }): Promise<CustomerRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const { updated, changedFields } = await this.updateForCompany(tx, { tenantId, ...input });
      await this.audit.record(tx, {
        action: 'customer.updated',
        resourceType: 'customer',
        resourceId: updated.id,
        tenantId,
        companyId: input.companyId,
        after: { changedFields },
      });
      return updated;
    });
  }

  async archiveForCompanyScoped(input: {
    companyId: string;
    customerId: string;
    expectedVersion: number;
  }): Promise<CustomerRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const archived = await this.archiveForCompany(tx, { tenantId, ...input });
      await this.audit.record(tx, {
        action: 'customer.archived',
        resourceType: 'customer',
        resourceId: archived.id,
        tenantId,
        companyId: input.companyId,
      });
      return archived;
    });
  }

  /**
   * Task 3b.2 §10 — restricted to a genuinely tenant-wide-scoped caller
   * (`companyScope === 'ALL'`, i.e. Owner today — the same `ScopeSet` concept
   * `PolicyEngine`/`inScope` already use for Owner's company-scope
   * short-circuit, ARCHITECTURE §6). This is deliberate, not incidental: a
   * Company-A-only-scoped caller has no legitimate way to have already learned
   * an arbitrary `customerId` belonging to Company B or to no company at all
   * (every one of their own read paths is join-gated to their own company) —
   * so this endpoint would otherwise be a UUID-enumeration oracle. Requiring
   * the same tenant-wide scope that already gates `listForTenant`/`getForTenant`
   * means the only caller who can legitimately identify an arbitrary tenant
   * Customer to associate is the same caller who could already see it.
   */
  async associateWithCompanyScoped(input: {
    companyId: string;
    customerId: string;
  }): Promise<{ companyAccount: CustomerCompanyAccountRow; created: boolean }> {
    const { tenantId, companyScope } = requireTenantContext();
    this.requireTenantWideScope(companyScope);
    return this.scoped(async (tx) => {
      const result = await this.associateWithCompany(tx, { tenantId, ...input });
      if (result.created) {
        await this.audit.record(tx, {
          action: 'customer.company_account_created',
          resourceType: 'customer_company_account',
          resourceId: result.companyAccount.id,
          tenantId,
          companyId: input.companyId,
        });
      }
      return result;
    });
  }

  /** Join-gated CustomerCompanyAccount read — task 3b.2 §11. Only the real
   *  3b.2 fields; no fabricated `currentOutstanding`/`availableCredit`/
   *  `advanceBalance` (those columns do not exist until 3b.6 adds them). */
  async getCompanyAccountScoped(input: {
    companyId: string;
    customerId: string;
  }): Promise<CustomerCompanyAccountRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.getCompanyAccount(tx, { tenantId, ...input }));
  }

  private async getCompanyAccount(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; customerId: string },
  ): Promise<CustomerCompanyAccountRow> {
    const row = await tx.customerCompanyAccount.findFirst({
      where: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        customerId: input.customerId,
      },
    });
    if (!row)
      throw new DomainError('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND', 'association not found', 404);
    return row as CustomerCompanyAccountRow;
  }

  async configureCreditScoped(input: {
    companyId: string;
    customerId: string;
    expectedVersion: number;
    creditEnabled: boolean;
    creditLimitMinor?: bigint;
  }): Promise<CustomerCompanyAccountRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const updated = await this.configureCredit(tx, { tenantId, ...input });
      await this.audit.record(tx, {
        action: 'customer.credit_config_updated',
        resourceType: 'customer_company_account',
        resourceId: updated.id,
        tenantId,
        companyId: input.companyId,
        after: { creditEnabled: updated.creditEnabled },
      });
      return updated;
    });
  }

  // ── tenant-wide entry points (SEPARATE, explicitly named — never reachable
  //    from a Company-scoped caller by accident) ──────────────────────────────

  /**
   * `customers:view` alone is NOT sufficient authorization for a tenant-wide
   * read — permission and data scope are independent axes (task 3b.2 §2, no
   * fifth Customer permission is ever introduced for this). Reuses the exact
   * `ScopeSet`/`'ALL'` concept `PolicyEngine.inScope`/Owner's session already
   * establish (`policy.service.ts`'s "Owner short-circuits scope to ALL/ALL",
   * `session.service.ts`'s platform-session `companyScope: 'ALL'`) — no new
   * authorization architecture, no new permission key.
   */
  private requireTenantWideScope(companyScope: 'ALL' | readonly string[]): void {
    if (companyScope !== 'ALL') {
      throw new ForbiddenError(
        'this operation requires tenant-wide company data scope',
        'TENANT_WIDE_SCOPE_REQUIRED',
      );
    }
  }

  async listForTenantScoped(input: {
    cursor?: string;
    limit?: number;
  }): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    const { tenantId, companyScope } = requireTenantContext();
    this.requireTenantWideScope(companyScope);
    return this.scoped((tx) => this.listForTenant(tx, { tenantId, ...input }));
  }

  async getForTenantScoped(input: { customerId: string }): Promise<CustomerRow> {
    const { tenantId, companyScope } = requireTenantContext();
    this.requireTenantWideScope(companyScope);
    return this.scoped((tx) => this.getForTenant(tx, { tenantId, ...input }));
  }

  // ── tx-level implementations ─────────────────────────────────────────────

  /**
   * Atomic Customer + initial CustomerCompanyAccount creation (task 3b.2 §7).
   * Both inserts happen in the ONE caller-supplied `tx` — if either fails, the
   * whole transaction rolls back (no independent nested commit). The initial
   * CompanyAccount is always financially neutral: `creditEnabled=false`, no
   * stored limit. NEVER looks up an existing customer by normalized contact
   * (task 3b.2 §3) — every call produces a brand-new Customer id.
   */
  async createForCompany(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      displayName: string;
      phone?: string | null;
      email?: string | null;
      createdByUserId?: string | null;
    },
  ): Promise<{ customer: CustomerRow; companyAccount: CustomerCompanyAccountRow }> {
    const companyRows = await tx.$queryRaw<{ countryCode: string | null }[]>`
      SELECT "countryCode" FROM "company" WHERE "id" = ${input.companyId}::uuid AND "tenantId" = ${input.tenantId}::uuid`;
    if (!companyRows[0]) throw new DomainError('NOT_FOUND', 'company not found', 404);

    const phoneE164 = normalizePhoneE164(input.phone ?? null, companyRows[0].countryCode);
    const emailNormalized = normalizeEmail(input.email ?? null);

    const customer = await tx.customer.create({
      data: {
        tenantId: input.tenantId,
        displayName: input.displayName,
        phoneE164,
        emailNormalized,
        createdByUserId: input.createdByUserId ?? null,
      },
    });

    const companyAccount = await tx.customerCompanyAccount.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        customerId: customer.id,
        creditEnabled: false,
      },
    });

    return {
      customer: customer as CustomerRow,
      companyAccount: companyAccount as CustomerCompanyAccountRow,
    };
  }

  /** Join-gated read — cannot return a customer with no association to `companyId`. */
  async listForCompany(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; cursor?: string; limit?: number },
  ): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    return this.searchForCompany(tx, input);
  }

  /**
   * Join-gated exact/prefix search — same isolation guarantee as `listForCompany`.
   * Every filter parameter is always bound (never string-concatenated); an
   * absent filter passes `NULL` and the `($n::type IS NULL OR ...)` clause
   * makes it a no-op — this avoids composing SQL fragments dynamically
   * (no `Prisma.sql`/`Prisma.join` precedent exists elsewhere in this
   * codebase), with zero injection surface since every value is parameterized.
   */
  async searchForCompany(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      cursor?: string;
      limit?: number;
      displayNameQuery?: string;
      phoneE164?: string;
      emailNormalized?: string;
    },
  ): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? null;
    const displayNamePrefix = input.displayNameQuery ? `${input.displayNameQuery}%` : null;
    const phoneE164 = input.phoneE164 ?? null;
    const emailNormalized = input.emailNormalized ?? null;
    const rows = await tx.$queryRaw<CustomerRow[]>`
      SELECT c."id", c."tenantId", c."displayName", c."phoneE164", c."emailNormalized",
             c."status", c."version", c."createdByUserId", c."createdAt", c."updatedAt"
        FROM "customer" c
        INNER JOIN "customer_company_account" cca
          ON cca."tenantId" = c."tenantId" AND cca."customerId" = c."id"
       WHERE c."tenantId" = ${input.tenantId}::uuid
         AND cca."companyId" = ${input.companyId}::uuid
         AND (${cursor}::uuid IS NULL OR c."id" > ${cursor}::uuid)
         AND (${displayNamePrefix}::text IS NULL OR c."displayName" ILIKE ${displayNamePrefix}::text)
         AND (${phoneE164}::text IS NULL OR c."phoneE164" = ${phoneE164}::text)
         AND (${emailNormalized}::text IS NULL OR c."emailNormalized" = ${emailNormalized}::text)
       ORDER BY c."id" ASC
       LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
  }

  /** Join-gated single read — 404s (never leaks existence) for a Customer with
   *  no association to `companyId`, even if it exists under another company. */
  async getForCompany(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; customerId: string },
  ): Promise<CustomerRow> {
    const rows = await tx.$queryRaw<CustomerRow[]>`
      SELECT c."id", c."tenantId", c."displayName", c."phoneE164", c."emailNormalized",
             c."status", c."version", c."createdByUserId", c."createdAt", c."updatedAt"
        FROM "customer" c
        INNER JOIN "customer_company_account" cca
          ON cca."tenantId" = c."tenantId" AND cca."customerId" = c."id"
       WHERE c."tenantId" = ${input.tenantId}::uuid
         AND cca."companyId" = ${input.companyId}::uuid
         AND c."id" = ${input.customerId}::uuid`;
    const row = rows[0];
    if (!row) throw new DomainError('CUSTOMER_NOT_FOUND', 'customer not found', 404);
    return row;
  }

  /**
   * Join-gated `FOR UPDATE` read — used by every mutation path (update,
   * archive) instead of a plain `getForCompany` read, exactly mirroring task
   * 3b.1's `AccountingPeriod.close()` lock-then-check-then-plain-update
   * pattern: holding the row lock for the rest of the transaction makes a
   * subsequent `update({where: {id}})` safe without needing `version` in the
   * Prisma `where` clause (which isn't expressible — `version` isn't part of
   * a unique index) — no other transaction can concurrently mutate this row
   * until this one commits.
   */
  private async getForCompanyLocked(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; customerId: string },
  ): Promise<CustomerRow> {
    const rows = await tx.$queryRaw<CustomerRow[]>`
      SELECT c."id", c."tenantId", c."displayName", c."phoneE164", c."emailNormalized",
             c."status", c."version", c."createdByUserId", c."createdAt", c."updatedAt"
        FROM "customer" c
        INNER JOIN "customer_company_account" cca
          ON cca."tenantId" = c."tenantId" AND cca."customerId" = c."id"
       WHERE c."tenantId" = ${input.tenantId}::uuid
         AND cca."companyId" = ${input.companyId}::uuid
         AND c."id" = ${input.customerId}::uuid
       FOR UPDATE OF c`;
    const row = rows[0];
    if (!row) throw new DomainError('CUSTOMER_NOT_FOUND', 'customer not found', 404);
    return row;
  }

  async updateForCompany(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      customerId: string;
      expectedVersion: number;
      displayName?: string;
      phone?: string | null;
      email?: string | null;
    },
  ): Promise<{ updated: CustomerRow; changedFields: string[] }> {
    const current = await this.getForCompanyLocked(tx, input); // 404s if not associated with companyId
    if (current.status === 'ARCHIVED') {
      throw new DomainError('CUSTOMER_ARCHIVED', 'cannot update an archived customer', 409);
    }
    if (current.version !== input.expectedVersion) {
      throw new DomainError(
        'CUSTOMER_VERSION_CONFLICT',
        `customer changed elsewhere (expected version ${input.expectedVersion}, now ${current.version})`,
        409,
      );
    }

    const changedFields: string[] = [];
    const data: Record<string, unknown> = {};
    if (input.displayName !== undefined && input.displayName !== current.displayName) {
      data['displayName'] = input.displayName;
      changedFields.push('displayName');
    }
    if (input.phone !== undefined) {
      const companyRows = await tx.$queryRaw<{ countryCode: string | null }[]>`
        SELECT "countryCode" FROM "company" WHERE "id" = ${input.companyId}::uuid AND "tenantId" = ${input.tenantId}::uuid`;
      const nextPhone = normalizePhoneE164(input.phone, companyRows[0]?.countryCode ?? null);
      if (nextPhone !== current.phoneE164) {
        data['phoneE164'] = nextPhone;
        changedFields.push('phoneE164');
      }
    }
    if (input.email !== undefined) {
      const nextEmail = normalizeEmail(input.email);
      if (nextEmail !== current.emailNormalized) {
        data['emailNormalized'] = nextEmail;
        changedFields.push('emailNormalized');
      }
    }

    const updated = await tx.customer.update({
      where: { id: input.customerId },
      data: { ...data, version: { increment: 1 } },
    });
    return { updated: updated as CustomerRow, changedFields };
  }

  async archiveForCompany(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; customerId: string; expectedVersion: number },
  ): Promise<CustomerRow> {
    const current = await this.getForCompanyLocked(tx, input);
    if (current.status === 'ARCHIVED') {
      return current; // idempotent replay of an already-applied archive
    }
    if (current.version !== input.expectedVersion) {
      throw new DomainError(
        'CUSTOMER_VERSION_CONFLICT',
        `customer changed elsewhere (expected version ${input.expectedVersion}, now ${current.version})`,
        409,
      );
    }
    const updated = await tx.customer.update({
      where: { id: input.customerId },
      data: { status: 'ARCHIVED', version: { increment: 1 } },
    });
    return updated as CustomerRow;
  }

  /**
   * Get-or-create association — the ONLY DB-level primitive for "does this
   * customer have a relationship with this company." Uses `ON CONFLICT DO
   * NOTHING RETURNING id` (never catches a unique-violation from a poisoned
   * transaction, task 3b.2 §8 explicit instruction, mirroring task 3b.1's
   * `journal_entry` idempotent-insert pattern). No GL/AR/Advance/credit-
   * enabling side effect — a fresh row is always `creditEnabled=false`.
   */
  async associateWithCompany(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; customerId: string },
  ): Promise<{ companyAccount: CustomerCompanyAccountRow; created: boolean }> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "customer_company_account" ("id", "tenantId", "companyId", "customerId", "updatedAt")
      VALUES (uuidv7(), ${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.customerId}::uuid, now())
      ON CONFLICT ("tenantId", "companyId", "customerId") DO NOTHING
      RETURNING "id"`.catch((err: unknown) => {
      if (isPgError(err, PG_FK_VIOLATION)) {
        throw new DomainError('CUSTOMER_NOT_FOUND', 'customer not found', 404);
      }
      throw err;
    });

    if (inserted[0]) {
      const row = await tx.customerCompanyAccount.findUniqueOrThrow({
        where: { id: inserted[0].id },
      });
      return { companyAccount: row as CustomerCompanyAccountRow, created: true };
    }

    const existing = await tx.customerCompanyAccount.findFirst({
      where: { tenantId: input.tenantId, companyId: input.companyId, customerId: input.customerId },
    });
    if (!existing)
      throw new DomainError('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND', 'association not found', 404);
    return { companyAccount: existing as CustomerCompanyAccountRow, created: false };
  }

  /**
   * Credit configuration domain rules (task 3b.2 §10-12): the currency lock
   * uses `CompanyFinancialConfigRepository.lockCurrencyOnly` — deliberately
   * NOT `lockForPosting`, which would spuriously require `accountingTimezone`/
   * posting-readiness that credit configuration has no business depending on.
   * Exponent is resolved SERVER-SIDE from `@flower/money`'s authoritative
   * table — the method signature has no parameter through which a caller
   * could supply one. `creditEnabled=true` requires a complete, positive,
   * current-currency Money snapshot; `creditEnabled=false` may retain a
   * previously-valid stored limit. Re-enabling with a stored limit whose
   * currency no longer matches the CURRENT `Company.defaultCurrency` fails
   * closed (`CUSTOMER_CREDIT_CURRENCY_MISMATCH`) — the minor value is never
   * reinterpreted.
   */
  async configureCredit(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      customerId: string;
      expectedVersion: number;
      creditEnabled: boolean;
      creditLimitMinor?: bigint;
    },
  ): Promise<CustomerCompanyAccountRow> {
    // proves the customer/company association exists (join-gated 404) AND
    // locks the customer_company_account row (via the customer join) for the
    // rest of this transaction, so the later plain `update({where: {id}})`
    // is safe without needing `version` in a Prisma where clause.
    await this.getForCompanyLocked(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerId: input.customerId,
    });

    const lockedRows = await tx.$queryRaw<
      {
        id: string;
        version: number;
        creditLimitMinor: bigint | null;
        creditLimitCurrencyCode: string | null;
        creditLimitCurrencyExponent: number | null;
      }[]
    >`SELECT "id", "version", "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent"
        FROM "customer_company_account"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "customerId" = ${input.customerId}::uuid
       FOR UPDATE`;
    const current = lockedRows[0];
    if (!current)
      throw new DomainError('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND', 'association not found', 404);
    if (current.version !== input.expectedVersion) {
      throw new DomainError(
        'CUSTOMER_CREDIT_VERSION_CONFLICT',
        `customer company account changed elsewhere (expected version ${input.expectedVersion}, now ${current.version})`,
        409,
      );
    }

    let nextMinor: bigint | null = current.creditLimitMinor;
    let nextCode: string | null = current.creditLimitCurrencyCode;
    let nextExponent: number | null = current.creditLimitCurrencyExponent;

    // task 3b.2 owner review round — `creditLimitMinor` omitted leaves any
    // previously-stored limit untouched; when supplied it is always a
    // positive replacement value. No client-facing clear-limit verb exists in
    // Task 3b.2 (never `null` — that ambiguity was explicitly rejected, since
    // no authoritative plan text requires explicit clearing here).
    if (input.creditLimitMinor !== undefined) {
      if (input.creditLimitMinor <= 0n) {
        throw new DomainError(
          'CUSTOMER_CREDIT_LIMIT_INVALID',
          'creditLimitMinor must be a positive value',
          422,
        );
      }
      const { defaultCurrency } = await this.companyFinancialConfig.lockCurrencyOnly(
        tx,
        input.companyId,
      );
      if (!isKnownCurrency(defaultCurrency)) {
        throw new DomainError('CUSTOMER_CREDIT_CONFIG_INVALID', 'unknown company currency', 422);
      }
      nextMinor = input.creditLimitMinor;
      nextCode = defaultCurrency;
      nextExponent = currencyExponent(defaultCurrency);
    }

    if (input.creditEnabled) {
      if (nextMinor === null || nextMinor <= 0n) {
        throw new DomainError(
          'CUSTOMER_CREDIT_CONFIG_INVALID',
          'creditEnabled=true requires a configured positive credit limit',
          422,
        );
      }
      // re-enabling with a RETAINED (not just-configured) limit must revalidate
      // against the CURRENT company currency — never reinterpret a stale minor.
      const { defaultCurrency } = await this.companyFinancialConfig.lockCurrencyOnly(
        tx,
        input.companyId,
      );
      if (nextCode !== defaultCurrency) {
        throw new DomainError(
          'CUSTOMER_CREDIT_CURRENCY_MISMATCH',
          "the stored credit-limit currency no longer matches the company's current currency — reconfigure explicitly",
          409,
        );
      }
    }

    try {
      const updated = await tx.customerCompanyAccount.update({
        where: { id: current.id },
        data: {
          creditEnabled: input.creditEnabled,
          creditLimitMinor: nextMinor,
          creditLimitCurrencyCode: nextCode,
          creditLimitCurrencyExponent: nextExponent,
          version: { increment: 1 },
        },
      });
      return updated as CustomerCompanyAccountRow;
    } catch (err) {
      if (isPgError(err, PG_CHECK_VIOLATION)) {
        throw new DomainError(
          'CUSTOMER_CREDIT_CONFIG_INVALID',
          'the requested credit configuration violates a database invariant',
          422,
        );
      }
      throw err;
    }
  }

  // ── tenant-wide implementations ──────────────────────────────────────────

  async listForTenant(
    tx: ScopedTx,
    input: { tenantId: string; cursor?: string; limit?: number },
  ): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    const limit = input.limit ?? 50;
    const rows = await tx.customer.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows) as CustomerRow[];
    return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
  }

  async getForTenant(
    tx: ScopedTx,
    input: { tenantId: string; customerId: string },
  ): Promise<CustomerRow> {
    const row = await tx.customer.findFirst({
      where: { id: input.customerId, tenantId: input.tenantId },
    });
    if (!row) throw new DomainError('CUSTOMER_NOT_FOUND', 'customer not found', 404);
    return row as CustomerRow;
  }
}
