import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { NotFoundError } from '../../common/errors/domain-error.js';

/**
 * F-3 — the SELLER IDENTITY printed on a VAT receipt. A deliberately NARROW read: explicit `select` of non-secret fields only (never
 * `fiscalConfig`, `crNumber`, provider credentials or any tenant internals). Runs inside the RLS-scoped transaction, and requires the branch
 * to belong to the company, so a company / branch / tenant mismatch is a plain 404 that leaks nothing.
 */
export interface ReceiptIdentity {
  companyId: string;
  branchId: string;
  branchName: string;
  legalNameEn: string;
  legalNameAr: string | null;
  trn: string | null;
  registeredAddress: string | null;
  countryCode: string | null;
  currency: string | null;
}

@Injectable()
export class ReceiptIdentityRepository extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }

  async getForBranchScoped(input: {
    companyId: string;
    branchId: string;
  }): Promise<ReceiptIdentity> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, tenantId, companyId: input.companyId },
        select: { id: true, name: true },
      });
      const company = branch
        ? await tx.company.findFirst({
            where: { id: input.companyId, tenantId },
            select: {
              id: true,
              legalNameEn: true,
              legalNameAr: true,
              trn: true,
              registeredAddress: true,
              countryCode: true,
              defaultCurrency: true,
            },
          })
        : null;
      if (!branch || !company) throw new NotFoundError('branch', 'BRANCH_NOT_FOUND');
      return {
        companyId: company.id,
        branchId: branch.id,
        branchName: branch.name,
        legalNameEn: company.legalNameEn,
        legalNameAr: company.legalNameAr,
        trn: company.trn,
        registeredAddress: company.registeredAddress,
        countryCode: company.countryCode,
        currency: company.defaultCurrency,
      };
    });
  }
}
