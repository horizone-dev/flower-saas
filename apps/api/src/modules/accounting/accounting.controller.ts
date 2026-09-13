import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { getContext } from '../../common/context/index.js';
import { assertUuid, parseIfMatch, requireIfMatch } from '../catalog/catalog-write.helpers.js';
import { AccountService } from './account.service.js';
import { AccountingPeriodService } from './accounting-period.service.js';
import { CompanyFinancialConfigRepository } from './company-financial-config.repository.js';
import {
  createAccountingPeriodSchema,
  type CreateAccountingPeriodDto,
} from './dto/create-accounting-period.dto.js';
import {
  updateAccountDisplaySchema,
  type UpdateAccountDisplayDto,
} from './dto/update-account-display.dto.js';
import {
  configureAccountingTimezoneSchema,
  type ConfigureAccountingTimezoneDto,
} from './dto/configure-accounting-timezone.dto.js';
import { accountingSetupSchema, type AccountingSetupDto } from './dto/accounting-setup.dto.js';

function parseIfMatchTimestamp(raw: string | undefined): Date {
  if (raw === undefined) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      'If-Match (the current resource updatedAt) is required',
      428,
    );
  }
  const cleaned = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const ms = Date.parse(cleaned);
  if (Number.isNaN(ms)) {
    throw new DomainError('PRECONDITION_REQUIRED', 'If-Match is not a valid timestamp', 428);
  }
  return new Date(ms);
}

function civilDateToUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * `/v1/companies/:companyId/accounting` — task 3b.1. CoA read + account
 * display-metadata edit + Accounting Period create/list/close + Company.
 * accountingTimezone configuration + the existing-company Accounting Setup
 * bootstrap (`POST .../setup` — owner-approved §P; NOT a raw accounting/
 * journal-posting endpoint, and it never creates an AccountingPeriod). NO
 * journal-list/read endpoint and NO HTTP-exposed posting endpoint —
 * `PostingEngineService` is an internal primitive only, with no domain-event
 * producer yet (docs/phase-3/PHASE-3B-PLAN.md §D — this task's API row lists
 * exactly this surface).
 */
@Controller('companies/:companyId/accounting')
export class AccountingController {
  constructor(
    private readonly accounts: AccountService,
    private readonly periods: AccountingPeriodService,
    private readonly companyConfig: CompanyFinancialConfigRepository,
  ) {}

  @Get('accounts')
  @RequirePermission('accounting:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async listAccounts(@Param('companyId') companyId: string) {
    assertUuid(companyId, 'company');
    return this.accounts.list({ companyId });
  }

  @Patch('accounts/:id')
  @RequirePermission('accounting:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async updateAccountDisplay(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateAccountDisplaySchema)) dto: UpdateAccountDisplayDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'account');
    const expectedUpdatedAt = parseIfMatchTimestamp(ifMatch);
    const updated = await this.accounts.updateDisplay({
      companyId,
      id,
      ...(dto.displayCode !== undefined ? { displayCode: dto.displayCode } : {}),
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
      expectedUpdatedAt,
    });
    void reply.header('etag', `"${updated.updatedAt.toISOString()}"`);
    return updated;
  }

  @Get('periods')
  @RequirePermission('accounting:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async listPeriods(@Param('companyId') companyId: string) {
    assertUuid(companyId, 'company');
    return this.periods.list({ companyId });
  }

  @Post('periods')
  @RequirePermission('accounting:period:manage')
  @ScopedParam({ company: 'companyId' })
  @Idempotent({ scope: 'accounting.period.create' })
  async createPeriod(
    @Param('companyId') companyId: string,
    @Body(new ZodBody(createAccountingPeriodSchema)) dto: CreateAccountingPeriodDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(companyId, 'company');
    const created = await this.periods.create({
      companyId,
      startDate: civilDateToUtc(dto.startDate),
      endDate: civilDateToUtc(dto.endDate),
    });
    void reply.header('etag', `"${created.version}"`);
    return created;
  }

  @Post('periods/:id/close')
  @HttpCode(200)
  @RequirePermission('accounting:period:manage')
  @ScopedParam({ company: 'companyId' })
  async closePeriod(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'accounting period');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const closedByUserId = getContext()?.userId ?? null;
    const closed = await this.periods.close({ companyId, id, expectedVersion, closedByUserId });
    void reply.header('etag', `"${closed.version}"`);
    return closed;
  }

  @Patch('config/timezone')
  @RequirePermission('accounting:manage')
  @ScopedParam({ company: 'companyId' })
  async configureTimezone(
    @Param('companyId') companyId: string,
    @Body(new ZodBody(configureAccountingTimezoneSchema))
    dto: ConfigureAccountingTimezoneDto,
  ): Promise<{ companyId: string; accountingTimezone: string }> {
    assertUuid(companyId, 'company');
    await this.companyConfig.setAccountingTimezoneScoped(companyId, dto.accountingTimezone);
    return { companyId, accountingTimezone: dto.accountingTimezone };
  }

  /**
   * Existing-company bootstrap (docs/phase-3/PHASE-3B-PLAN.md §J/§P) — how a
   * pre-3b.1 company becomes financially configurable. NOT a raw accounting or
   * journal-posting endpoint: it only sets `Company.accountingTimezone`
   * (explicit, never inferred) and idempotently backfills any of the 14 frozen
   * CoA accounts not yet present, preserving any already-customized
   * `displayCode`/`displayName`. Never creates an `AccountingPeriod` — that
   * stays a separate, explicit `POST .../periods` call. Retry-safe: calling
   * this twice with the same timezone is a no-op past the first call; calling
   * it with a new timezone re-applies `setAccountingTimezone`'s own semantics
   * (timezone stays changeable after financial history exists, unlike currency).
   */
  @Post('setup')
  @RequirePermission('accounting:manage')
  @ScopedParam({ company: 'companyId' })
  async bootstrapAccounting(
    @Param('companyId') companyId: string,
    @Body(new ZodBody(accountingSetupSchema)) dto: AccountingSetupDto,
  ): Promise<{ companyId: string; accountingTimezone: string; accountsCreated: number }> {
    assertUuid(companyId, 'company');
    const result = await this.companyConfig.bootstrapExistingCompanyScoped(
      companyId,
      dto.accountingTimezone,
    );
    return { companyId, ...result };
  }
}
