import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { OpeningBalanceService } from './opening-balance.service.js';
import type { CreateOpeningBalanceResult } from './opening-balance.repository.js';
import {
  createOpeningBalanceSchema,
  type CreateOpeningBalanceDto,
} from './dto/create-opening-balance.dto.js';

/** BigInt -> decimal-digit string, mirroring every other Money-response
 *  serializer in this module exactly. Never exposes an internal account key
 *  or journal id. */
function serializeOpeningBalanceResult(result: CreateOpeningBalanceResult): {
  type: 'RECEIVABLE' | 'ADVANCE';
  sourceId: string;
  customerCompanyAccountId: string;
  amountMinor: string;
  currencyCode: string;
  effectiveDate: string;
  note: string | null;
  currentOutstandingMinor: string | null;
  advanceBalanceMinor: string | null;
} {
  return {
    type: result.type,
    sourceId: result.sourceId,
    customerCompanyAccountId: result.customerCompanyAccountId,
    amountMinor: result.amountMinor.toString(),
    currencyCode: result.currencyCode,
    effectiveDate: result.effectiveDate,
    note: result.note,
    currentOutstandingMinor: result.currentOutstandingMinor?.toString() ?? null,
    advanceBalanceMinor: result.advanceBalanceMinor?.toString() ?? null,
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/customers/:customerId/opening-balance`
 * — task 3b.6 Checkpoint F (F8). Explicit-only: a Customer never gains an
 * opening balance automatically (F4) — this and the customer-create
 * embedded path (`customer-with-opening-balance.controller.ts`) are the ONLY
 * two ways one can ever be created.
 *
 * `receivables:opening_balance:manage` is the frozen Checkpoint B permission
 * (owner/admin ONLY — confirmed via `system-roles.ts`'s
 * `RECEIVABLES_OPENING_BALANCE_MANAGE` grant, never manager/cashier/sales).
 * It is registered in `STEP_UP_PERMISSIONS` (`packages/permissions/src/
 * index.ts` — "fabricates a financial balance from nothing, the same
 * money-exposure tier as `customers:credit:manage`") — this route
 * deliberately has NO `@NoStepUp()`, unlike every other 3b.6 receivables
 * route in this module (F7).
 */
@Controller('companies/:companyId/branches/:branchId/customers/:customerId/opening-balance')
export class OpeningBalanceController {
  constructor(private readonly openingBalance: OpeningBalanceService) {}

  @Post()
  @RequirePermission('receivables:opening_balance:manage')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'receivables.opening_balance' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createOpeningBalanceSchema)) dto: CreateOpeningBalanceDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    if (!idempotencyKeyHeader) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const result = await this.openingBalance.create({
      companyId,
      branchId,
      customerId,
      type: dto.type,
      amountMinor: BigInt(dto.amountMinor),
      effectiveDate: dto.effectiveDate,
      ...(dto.note !== undefined ? { note: dto.note } : {}),
    });
    return serializeOpeningBalanceResult(result);
  }
}
