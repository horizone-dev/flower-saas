import { Injectable } from '@nestjs/common';
import { runScoped, type ScopedTx } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { NotFoundError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';

/** RLS scopes reads to the tenant, but a foreign-key still resolves across
 *  tenants — so a write keyed by a branch id must first confirm the branch is
 *  visible in this tenant (else a caller could attach rows to another tenant's
 *  branch). Cross-tenant probe suite, task 1.13. */
async function assertBranchInTenant(tx: ScopedTx, branchId: string): Promise<void> {
  const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { id: true } });
  if (!branch) throw new NotFoundError('branch');
}

/** Org data — companies, trade licenses, branches, branch settings, POS
 *  terminals. Tenant-scoped through RLS. */
@Injectable()
export class OrgRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditWriter,
  ) {}

  private run<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    const { tenantId } = requireTenantContext();
    return runScoped(this.db.appClient(), { tenantId }, fn);
  }

  // ── companies ──────────────────────────────────────────────────────────
  listCompanies() {
    return this.run((tx) =>
      tx.company.findMany({
        orderBy: { legalNameEn: 'asc' },
        select: {
          id: true,
          legalNameEn: true,
          legalNameAr: true,
          crNumber: true,
          trn: true,
          status: true,
        },
      }),
    );
  }

  async createCompany(input: {
    legalNameEn: string;
    legalNameAr?: string | null | undefined;
    crNumber?: string | null | undefined;
    trn?: string | null | undefined;
    registeredAddress?: string | null | undefined;
  }): Promise<{ id: string }> {
    return this.run(async (tx) => {
      const c = await tx.company.create({
        data: {
          tenantId: requireTenantContext().tenantId,
          legalNameEn: input.legalNameEn,
          legalNameAr: input.legalNameAr ?? null,
          crNumber: input.crNumber ?? null,
          trn: input.trn ?? null,
          registeredAddress: input.registeredAddress ?? null,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'company.created',
        resourceType: 'company',
        resourceId: c.id,
        companyId: c.id,
      });
      return c;
    });
  }

  // ── branches ───────────────────────────────────────────────────────────
  listBranches() {
    return this.run((tx) =>
      tx.branch.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          companyId: true,
          name: true,
          timezone: true,
          weekendModel: true,
          status: true,
        },
      }),
    );
  }

  async createBranch(input: {
    companyId: string;
    name: string;
    timezone?: string | undefined;
    weekendModel?: string | undefined;
  }): Promise<{ id: string }> {
    return this.run(async (tx) => {
      const tenantId = requireTenantContext().tenantId;
      const company = await tx.company.findUnique({
        where: { id: input.companyId },
        select: { id: true },
      });
      if (!company) throw new NotFoundError('company');
      const b = await tx.branch.create({
        data: {
          tenantId,
          companyId: input.companyId,
          name: input.name,
          timezone: input.timezone ?? 'Asia/Dubai',
          weekendModel: input.weekendModel ?? 'FRI_SAT',
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'branch.created',
        resourceType: 'branch',
        resourceId: b.id,
        companyId: input.companyId,
        branchId: b.id,
      });
      return b;
    });
  }

  countBranches(): Promise<number> {
    return this.run((tx) => tx.branch.count());
  }
  countCompanies(): Promise<number> {
    return this.run((tx) => tx.company.count());
  }
  countPosTerminals(): Promise<number> {
    return this.run((tx) => tx.posTerminal.count());
  }

  // ── branch settings (registered_device_required is NOT writable — amendment 1) ──
  branchSettings(branchId: string): Promise<{ key: string; value: unknown }[]> {
    return this.run(async (tx) => {
      await assertBranchInTenant(tx, branchId);
      return tx.branchSetting.findMany({ where: { branchId }, select: { key: true, value: true } });
    });
  }

  async setBranchSetting(branchId: string, key: string, value: unknown): Promise<void> {
    await this.run(async (tx) => {
      const tenantId = requireTenantContext().tenantId;
      await assertBranchInTenant(tx, branchId);
      await tx.branchSetting.upsert({
        where: { branchId_key: { branchId, key } },
        create: { tenantId, branchId, key, value: value as object },
        update: { value: value as object },
      });
      await this.audit.record(tx, {
        action: 'branch_setting.changed',
        resourceType: 'branch_setting',
        resourceId: `${branchId}/${key}`,
        branchId,
      });
    });
  }

  // ── POS terminals ──────────────────────────────────────────────────────
  listPosTerminals() {
    return this.run((tx) =>
      tx.posTerminal.findMany({
        orderBy: { code: 'asc' },
        select: { id: true, companyId: true, branchId: true, code: true, name: true, status: true },
      }),
    );
  }

  async createPosTerminal(input: {
    branchId: string;
    code: string;
    name: string;
  }): Promise<{ id: string }> {
    return this.run(async (tx) => {
      const tenantId = requireTenantContext().tenantId;
      const branch = await tx.branch.findUnique({
        where: { id: input.branchId },
        select: { companyId: true },
      });
      if (!branch) throw new NotFoundError('branch');
      const p = await tx.posTerminal.create({
        data: {
          tenantId,
          companyId: branch.companyId,
          branchId: input.branchId,
          code: input.code,
          name: input.name,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'pos_terminal.created',
        resourceType: 'pos_terminal',
        resourceId: p.id,
        branchId: input.branchId,
      });
      return p;
    });
  }

  // ── trade licenses ─────────────────────────────────────────────────────
  async createTradeLicense(input: {
    companyId: string;
    number: string;
    issuedAt?: Date | null;
    expiresAt?: Date | null;
  }): Promise<{ id: string }> {
    return this.run(async (tx) => {
      const tenantId = requireTenantContext().tenantId;
      const company = await tx.company.findUnique({
        where: { id: input.companyId },
        select: { id: true },
      });
      if (!company) throw new NotFoundError('company');
      const l = await tx.tradeLicense.create({
        data: {
          tenantId,
          companyId: input.companyId,
          number: input.number,
          issuedAt: input.issuedAt ?? null,
          expiresAt: input.expiresAt ?? null,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'trade_license.created',
        resourceType: 'trade_license',
        resourceId: l.id,
        companyId: input.companyId,
      });
      return l;
    });
  }

  licensesExpiringBefore(when: Date) {
    return this.run((tx) =>
      tx.tradeLicense.findMany({
        where: { status: 'ACTIVE', expiresAt: { not: null, lte: when } },
        orderBy: { expiresAt: 'asc' },
        select: { id: true, companyId: true, number: true, expiresAt: true },
      }),
    );
  }
}
