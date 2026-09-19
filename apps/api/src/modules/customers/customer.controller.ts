import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { getContext } from '../../common/context/index.js';
import { assertUuid, parseIfMatch, requireIfMatch } from '../catalog/catalog-write.helpers.js';
import { CustomerService } from './customer.service.js';
import { CustomerCreateFingerprintProvider } from './customer-create-fingerprint.provider.js';
import type { CustomerCompanyAccountRow } from './customer.repository.js';
import { createCustomerSchema, type CreateCustomerDto } from './dto/create-customer.dto.js';
import { updateCustomerSchema, type UpdateCustomerDto } from './dto/update-customer.dto.js';
import { configureCreditSchema, type ConfigureCreditDto } from './dto/configure-credit.dto.js';

/**
 * Fastify's JSON serializer cannot encode a native `BigInt` (it throws at
 * response-serialization time, outside any handler-level try/catch) — no
 * existing HTTP-response Money precedent exists anywhere else in this
 * codebase to reuse (task 3b.1's Posting Engine has no HTTP-exposed
 * response). `creditLimitMinor` is converted to a decimal-digit STRING here,
 * mirroring the DTO's own input convention (`dto/configure-credit.dto.ts`) —
 * never a JS `number`, which cannot safely round-trip an arbitrary BigInt.
 */
function serializeCompanyAccount(
  row: CustomerCompanyAccountRow,
): Omit<CustomerCompanyAccountRow, 'creditLimitMinor'> & { creditLimitMinor: string | null } {
  return {
    ...row,
    creditLimitMinor: row.creditLimitMinor === null ? null : row.creditLimitMinor.toString(),
  };
}

/**
 * `/v1/companies/:companyId/customers` — task 3b.2. Every route here is
 * join-gated through `customer_company_account` (`CustomerRepository`'s
 * `*ForCompany` methods) — a Customer with no association row for `companyId`
 * is invisible through this controller, even if it exists under another
 * Company in the same Tenant (non-disclosing 404, never a different status).
 *
 * `customers:view`/`customers:manage`/`customers:credit:manage` are the only
 * three permissions any route here checks; `customers:credit:override` is
 * registered (task 3b.1-style, checkpoint A) but has NO route anywhere — its
 * execution belongs to task 3b.6. Permission is never sufficient authorization
 * on its own: `@ScopedParam({ company: 'companyId' })` additionally requires
 * the caller's session-derived company scope to cover `companyId` (task 3b.2
 * §2 — permission != data scope, no fifth Customer permission is introduced
 * for this).
 *
 * NO raw Journal/AR/Advance/Order/Invoice/Payment endpoint exists here or
 * anywhere in this module (task 3b.2 §21/§28).
 */
@Controller('companies/:companyId/customers')
export class CustomerController {
  constructor(private readonly customers: CustomerService) {}

  @Get()
  @RequirePermission('customers:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async list(
    @Param('companyId') companyId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('displayName') displayName: string | undefined,
    @Query('phone') phone: string | undefined,
    @Query('email') email: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    if (displayName || phone || email) {
      return this.customers.searchForCompany({
        companyId,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(displayName ? { displayNameQuery: displayName } : {}),
        ...(phone ? { phoneE164: phone } : {}),
        ...(email ? { emailNormalized: email.trim().toLowerCase() } : {}),
      });
    }
    return this.customers.listForCompany({
      companyId,
      ...(cursor !== undefined ? { cursor } : {}),
    });
  }

  @Post()
  @RequirePermission('customers:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  @Idempotent({
    scope: 'customers.create',
    // task 3b.2 owner review round — semantic (normalized) fingerprint, not
    // the raw HTTP body, so equivalent phone/email input under the same key
    // replays instead of conflicting. See CustomerCreateFingerprintProvider.
    semanticFingerprintProvider: CustomerCreateFingerprintProvider,
  })
  async create(
    @Param('companyId') companyId: string,
    @Body(new ZodBody(createCustomerSchema)) dto: CreateCustomerDto,
  ) {
    assertUuid(companyId, 'company');
    const createdByUserId = getContext()?.userId ?? null;
    const { customer } = await this.customers.createForCompany({
      companyId,
      displayName: dto.displayName,
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      createdByUserId,
    });
    return customer;
  }

  @Get(':id')
  @RequirePermission('customers:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async get(@Param('companyId') companyId: string, @Param('id') id: string) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'customer');
    return this.customers.getForCompany({ companyId, customerId: id });
  }

  @Patch(':id')
  @RequirePermission('customers:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async update(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateCustomerSchema)) dto: UpdateCustomerDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'customer');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const updated = await this.customers.updateForCompany({
      companyId,
      customerId: id,
      expectedVersion,
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
    });
    return updated;
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('customers:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async archive(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'customer');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    return this.customers.archiveForCompany({ companyId, customerId: id, expectedVersion });
  }

  /**
   * task 3b.2 §10 — restricted to a tenant-wide-scoped caller (Owner today) at
   * the repository layer (`CustomerRepository.associateWithCompanyScoped`'s
   * `requireTenantWideScope`), on top of the ordinary `customers:manage` +
   * `@ScopedParam({ company: 'companyId' })` checks on the TARGET company.
   * Never a raw UUID-enumeration path for a Company-scoped-only caller.
   */
  @Post(':id/associate')
  @HttpCode(200)
  @RequirePermission('customers:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async associate(@Param('companyId') companyId: string, @Param('id') id: string) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'customer');
    const { companyAccount } = await this.customers.associateWithCompany({
      companyId,
      customerId: id,
    });
    return serializeCompanyAccount(companyAccount);
  }

  @Get(':id/account')
  @RequirePermission('customers:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  async getAccount(@Param('companyId') companyId: string, @Param('id') id: string) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'customer');
    // getForCompanyScoped join-proves the association before any credit-config
    // fields are ever returned — no fabricated 3b.6 projection field exists on
    // CustomerCompanyAccountRow (task 3b.2 §11).
    await this.customers.getForCompany({ companyId, customerId: id });
    const account = await this.customers.getCompanyAccount({ companyId, customerId: id });
    return serializeCompanyAccount(account);
  }

  /**
   * task 3b.2 §12-§14 credit-config PATCH semantics, applied exactly:
   *   A. creditEnabled=true + creditLimitMinor supplied  -> validate against
   *      current Company currency, store, enable.
   *   B. creditEnabled=true + creditLimitMinor omitted   -> reuse the stored
   *      limit ONLY if complete/positive/current-currency, else fail closed
   *      (`CustomerRepository.configureCredit`'s re-enable revalidation).
   *   C. creditEnabled=false + creditLimitMinor omitted  -> disable, RETAIN
   *      any existing stored limit (never silently cleared).
   *   D. creditEnabled=false + creditLimitMinor supplied -> validate and
   *      store while remaining disabled (configure-before-enable).
   *   E. There is NO explicit-clear verb in Task 3b.2 (owner review round —
   *      `creditLimitMinor` is a plain optional positive-decimal string; no
   *      `null` is accepted by the DTO at all, so "clear" and "not provided"
   *      can never be conflated, and no authoritative plan text requires an
   *      explicit clear operation here).
   */
  @Patch(':id/account/credit')
  @RequirePermission('customers:credit:manage')
  @ScopedParam({ company: 'companyId' })
  async configureCredit(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(configureCreditSchema)) dto: ConfigureCreditDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(id, 'customer');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const updated = await this.customers.configureCredit({
      companyId,
      customerId: id,
      expectedVersion,
      creditEnabled: dto.creditEnabled,
      ...(dto.creditLimitMinor !== undefined
        ? { creditLimitMinor: BigInt(dto.creditLimitMinor) }
        : {}),
    });
    return serializeCompanyAccount(updated);
  }
}

/**
 * `/v1/customers` — task 3b.2 §19. Genuinely tenant-wide (no `companyId` in
 * the path at all, so `@ScopedParam` does not apply — there is no per-request
 * company target to check). Authorization is `customers:view` PLUS a
 * tenant-wide company data scope, enforced at
 * `CustomerRepository.requireTenantWideScope` (reuses the existing
 * `companyScope === 'ALL'` concept Owner's session already carries —
 * `policy.service.ts`'s "Owner short-circuits scope to ALL/ALL"). No new
 * permission key was introduced to express this (task 3b.2 §2/§19 explicit
 * instruction).
 */
@Controller('customers')
export class CustomerTenantController {
  constructor(private readonly customers: CustomerService) {}

  @Get()
  @RequirePermission('customers:view')
  @NoStepUp()
  async list(@Query('cursor') cursor: string | undefined) {
    return this.customers.listForTenant(cursor !== undefined ? { cursor } : {});
  }

  @Get(':id')
  @RequirePermission('customers:view')
  @NoStepUp()
  async get(@Param('id') id: string) {
    assertUuid(id, 'customer');
    return this.customers.getForTenant({ customerId: id });
  }
}
