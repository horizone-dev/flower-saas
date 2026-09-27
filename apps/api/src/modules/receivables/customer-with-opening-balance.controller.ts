import { Body, Controller, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { CustomerWithOpeningBalanceService } from './customer-with-opening-balance.service.js';
import type { CreateCustomerWithOpeningBalanceResult } from './customer-with-opening-balance.repository.js';
import { CustomerWithOpeningBalanceFingerprintProvider } from './customer-with-opening-balance-fingerprint.provider.js';
import {
  createCustomerWithOpeningBalanceSchema,
  type CreateCustomerWithOpeningBalanceDto,
} from './dto/create-customer-with-opening-balance.dto.js';

function serializeResult(result: CreateCustomerWithOpeningBalanceResult): unknown {
  return {
    ...result.customer,
    openingBalance: result.openingBalance
      ? {
          type: result.openingBalance.type,
          sourceId: result.openingBalance.sourceId,
          customerCompanyAccountId: result.openingBalance.customerCompanyAccountId,
          amountMinor: result.openingBalance.amountMinor.toString(),
          currencyCode: result.openingBalance.currencyCode,
          effectiveDate: result.openingBalance.effectiveDate,
          note: result.openingBalance.note,
          currentOutstandingMinor:
            result.openingBalance.currentOutstandingMinor?.toString() ?? null,
          advanceBalanceMinor: result.openingBalance.advanceBalanceMinor?.toString() ?? null,
        }
      : null,
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/customers` — task 3b.6
 * Checkpoint F (F19/F20/F21). A WHOLLY SEPARATE, additive route from the
 * frozen 3b.2 `/companies/:companyId/customers` (`CustomerController.create`)
 * — that route is completely untouched, still reachable, still behaves
 * identically. This route exists ONLY so a trusted `:branchId` is available
 * (via `@ScopedParam`, never the request body — CLAUDE.md rule 5) for the
 * optional embedded `openingBalance`.
 *
 * Guard-declared permission is `customers:manage` ONLY — a caller with just
 * this permission may create a plain Customer through this route with no
 * `openingBalance` (F21 "normal Customer create... unchanged"). The SECOND,
 * step-up-gated `receivables:opening_balance:manage` permission is checked
 * manually inside `CustomerWithOpeningBalanceRepository`, ONLY when
 * `openingBalance` is present in the body, BEFORE any transaction opens.
 */
@Controller('companies/:companyId/branches/:branchId/customers')
export class CustomerWithOpeningBalanceController {
  constructor(private readonly customers: CustomerWithOpeningBalanceService) {}

  @Post()
  @RequirePermission('customers:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({
    scope: 'customers.create_with_opening_balance',
    semanticFingerprintProvider: CustomerWithOpeningBalanceFingerprintProvider,
  })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Body(new ZodBody(createCustomerWithOpeningBalanceSchema))
    dto: CreateCustomerWithOpeningBalanceDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    const result = await this.customers.create({
      companyId,
      branchId,
      displayName: dto.displayName,
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      openingBalance: dto.openingBalance
        ? {
            type: dto.openingBalance.type,
            amountMinor: BigInt(dto.openingBalance.amountMinor),
            effectiveDate: dto.openingBalance.effectiveDate,
            ...(dto.openingBalance.note !== undefined ? { note: dto.openingBalance.note } : {}),
          }
        : null,
    });
    return serializeResult(result);
  }
}
