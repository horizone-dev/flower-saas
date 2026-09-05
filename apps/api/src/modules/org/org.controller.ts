import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { OrgRepository } from './org.repository.js';
import { OrgService } from './org.service.js';

const companySchema = z.object({
  legalNameEn: z.string().min(1).max(200),
  legalNameAr: z.string().max(200).optional(),
  crNumber: z.string().max(60).optional(),
  trn: z.string().max(60).optional(),
  registeredAddress: z.string().max(500).optional(),
  // The fiscal source of truth (correction 4) — required so no company is ever
  // created without a resolvable currency/tax profile (task 2.7).
  countryCode: z.string().length(2),
});
const branchSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1).max(120),
  timezone: z.string().max(64).optional(),
  weekendModel: z.enum(['FRI_SAT', 'SAT_SUN', 'SUN_ONLY']).optional(),
});
const posSchema = z.object({
  branchId: z.string().uuid(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
});
const licenseSchema = z.object({
  companyId: z.string().uuid(),
  number: z.string().min(1).max(80),
  issuedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});
// registered_device_required is deliberately absent — no Phase 1 API can set it (amendment 1)
const branchSettingSchema = z.object({
  key: z.enum(['pos_scope_default_terminal', 'weekend_override', 'notes']),
  value: z.unknown(),
});

@Controller('org')
export class OrgController {
  constructor(
    private readonly repo: OrgRepository,
    private readonly org: OrgService,
  ) {}

  @Get('companies')
  @RequirePermission('settings:tenant:manage')
  companies() {
    return this.repo.listCompanies();
  }

  @Post('companies')
  @RequirePermission('settings:tenant:manage')
  createCompany(@Body(new ZodBody(companySchema)) dto: z.infer<typeof companySchema>) {
    return this.org.createCompany(dto);
  }

  @Get('branches')
  @RequirePermission('settings:tenant:manage')
  branches() {
    return this.repo.listBranches();
  }

  @Post('branches')
  @RequirePermission('settings:tenant:manage')
  createBranch(@Body(new ZodBody(branchSchema)) dto: z.infer<typeof branchSchema>) {
    // `companyId` is a body field, not a route param — the repository re-checks
    // the company belongs to the caller's tenant inside the RLS transaction.
    return this.org.createBranch(dto);
  }

  @Get('branches/:branchId/settings')
  @RequirePermission('settings:branch:manage')
  @ScopedParam({ branch: 'branchId' })
  branchSettings(@Param('branchId') branchId: string) {
    return this.repo.branchSettings(branchId);
  }

  @Put('branches/:branchId/settings')
  @RequirePermission('settings:branch:manage')
  @ScopedParam({ branch: 'branchId' })
  async setBranchSetting(
    @Param('branchId') branchId: string,
    @Body(new ZodBody(branchSettingSchema)) dto: z.infer<typeof branchSettingSchema>,
  ) {
    // `registered_device_required` is not in the schema enum — no Phase 1 API can
    // set it (amendment 1); a request naming it fails validation with a 400.
    await this.repo.setBranchSetting(branchId, dto.key, dto.value);
    return { status: 'ok' };
  }

  @Get('pos-terminals')
  @RequirePermission('settings:tenant:manage')
  posTerminals() {
    return this.repo.listPosTerminals();
  }

  @Post('pos-terminals')
  @RequirePermission('settings:tenant:manage')
  createPos(@Body(new ZodBody(posSchema)) dto: z.infer<typeof posSchema>) {
    return this.org.createPosTerminal(dto);
  }

  @Post('trade-licenses')
  @RequirePermission('settings:tenant:manage')
  createLicense(@Body(new ZodBody(licenseSchema)) dto: z.infer<typeof licenseSchema>) {
    return this.repo.createTradeLicense({
      companyId: dto.companyId,
      number: dto.number,
      issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
  }

  @Get('licenses/expiring')
  @RequirePermission('settings:tenant:manage')
  expiring(@Query('withinDays') withinDays?: string) {
    const days = Math.min(365, Math.max(1, Number(withinDays) || 60));
    return this.repo.licensesExpiringBefore(new Date(Date.now() + days * 86_400_000));
  }
}
