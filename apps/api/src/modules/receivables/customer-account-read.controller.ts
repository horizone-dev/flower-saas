import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { CustomerAccountReadService } from './customer-account-read.service.js';
import type {
  CustomerAccountSummary,
  ReceivableRow,
  AdvanceRow,
  UnappliedReceiptRow,
  StatementLine,
  StatementOpeningState,
} from './customer-account-read.repository.js';

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new DomainError('INVALID_LIMIT', 'limit must be a positive integer', 400);
  }
  return n;
}

function serializeSummary(s: CustomerAccountSummary) {
  return {
    customerCompanyAccountId: s.customerCompanyAccountId,
    currencyCode: s.currencyCode,
    currencyExponent: s.currencyExponent,
    branchFinancials: {
      receivableOutstandingMinor: s.branchFinancials.receivableOutstandingMinor.toString(),
      advanceAvailableMinor: s.branchFinancials.advanceAvailableMinor.toString(),
      unappliedReceiptMinor: s.branchFinancials.unappliedReceiptMinor.toString(),
      openReceivableCount: s.branchFinancials.openReceivableCount,
      openAdvanceCount: s.branchFinancials.openAdvanceCount,
    },
    credit: {
      scope: s.credit.scope,
      creditEnabled: s.credit.creditEnabled,
      creditLimitMinor:
        s.credit.creditLimitMinor === null ? null : s.credit.creditLimitMinor.toString(),
      creditExposureMinor: s.credit.creditExposureMinor.toString(),
      availableCreditMinor:
        s.credit.availableCreditMinor === null ? null : s.credit.availableCreditMinor.toString(),
      projectionIntegrity: s.credit.projectionIntegrity,
    },
    asOf: s.asOf,
  };
}

function serializeReceivable(r: ReceivableRow) {
  return {
    customerReceivableId: r.customerReceivableId,
    sourceType: r.sourceType,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceNumber,
    cancellationChargeId: r.cancellationChargeId,
    cancellationChargeNumber: r.cancellationChargeNumber,
    sourceDate: r.sourceDate,
    originalAmountMinor: r.originalAmountMinor.toString(),
    paidByPaymentMinor: r.paidByPaymentMinor.toString(),
    paidByAdvanceMinor: r.paidByAdvanceMinor.toString(),
    outstandingMinor: r.outstandingMinor.toString(),
    currencyCode: r.currencyCode,
    currencyExponent: r.currencyExponent,
    createdAt: r.createdAt.toISOString(),
    openingEffectiveDate: r.openingEffectiveDate,
    openingNote: r.openingNote,
    ageDays: r.ageDays,
  };
}

function serializeAdvance(a: AdvanceRow) {
  return {
    customerAdvanceId: a.customerAdvanceId,
    sourceType: a.sourceType,
    sourcePaymentId: a.sourcePaymentId,
    originalAmountMinor: a.originalAmountMinor.toString(),
    appliedAmountMinor: a.appliedAmountMinor.toString(),
    refundedAmountMinor: a.refundedAmountMinor.toString(),
    reservedAmountMinor: a.reservedAmountMinor.toString(),
    availableAmountMinor: a.availableAmountMinor.toString(),
    currencyCode: a.currencyCode,
    currencyExponent: a.currencyExponent,
    openingEffectiveDate: a.openingEffectiveDate,
    createdAt: a.createdAt.toISOString(),
  };
}

/** G12 — never provider secrets/raw webhook payload/credential material;
 *  only the fields already safe on `Payment` itself. */
function serializeUnappliedReceipt(u: UnappliedReceiptRow) {
  return {
    paymentId: u.paymentId,
    method: u.method,
    receiptPurpose: u.receiptPurpose,
    originalAmountMinor: u.originalAmountMinor.toString(),
    consumedAmountMinor: u.consumedAmountMinor.toString(),
    unappliedAmountMinor: u.unappliedAmountMinor.toString(),
    currencyCode: u.currencyCode,
    currencyExponent: u.currencyExponent,
    createdAt: u.createdAt.toISOString(),
  };
}

function serializeStatementLine(l: StatementLine) {
  return {
    customerAccountEntryId: l.customerAccountEntryId,
    entryKind: l.entryKind,
    financialDate: l.financialDate,
    occurredAt: l.occurredAt.toISOString(),
    receivableEffectMinor: l.receivableEffectMinor.toString(),
    advanceEffectMinor: l.advanceEffectMinor.toString(),
    unappliedReceiptEffectMinor: l.unappliedReceiptEffectMinor.toString(),
    refs: l.refs,
  };
}

function serializeOpeningState(o: StatementOpeningState | null) {
  if (o === null) return null;
  return {
    asOfDate: o.asOfDate,
    receivableOutstandingMinor: o.receivableOutstandingMinor.toString(),
    advanceAvailableMinor: o.advanceAvailableMinor.toString(),
    unappliedReceiptMinor: o.unappliedReceiptMinor.toString(),
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/customers/:customerId/account/*`
 * — task 3b.6 Checkpoint G. READ ONLY — no route here ever mutates a
 * Payment/Receivable/Advance/Application/CustomerAccountEntry/Journal/Audit/
 * Outbox row or the `CustomerCompanyAccount` projection (G39).
 *
 * `receivables:view` (frozen 3b.6 permission, owner/admin/manager/cashier/
 * sales) is the ONLY permission any route here checks — it is NOT in
 * `STEP_UP_PERMISSIONS` (`packages/permissions/src/index.ts`), so every
 * route here is `@NoStepUp()` (G36).
 *
 * SCOPE (see `CustomerAccountReadRepository`'s own header doc for the full
 * rationale, corrected in the Absolute Final Freeze Gate pass): `summary`'s
 * `branchFinancials` are THIS route's `:branchId` ONLY — never another
 * branch's operational totals. `summary`'s `credit` block is a SEPARATE,
 * explicitly-labelled (`scope: "COMPANY"`) concept, since
 * `CustomerCompanyAccount` credit configuration/exposure is frozen
 * company-scoped and must never be confused with branch financials.
 * `receivables`/`advances`/`unapplied-receipts`/`statement` are likewise
 * filtered to THIS route's `:branchId` — every individual source row is
 * genuinely branch-scoped.
 */
@Controller('companies/:companyId/branches/:branchId/customers/:customerId/account')
export class CustomerAccountReadController {
  constructor(private readonly account: CustomerAccountReadService) {}

  @Get('summary')
  @RequirePermission('receivables:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async summary(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    const result = await this.account.getSummary({ companyId, branchId, customerId });
    return serializeSummary(result);
  }

  @Get('receivables')
  @RequirePermission('receivables:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async receivables(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('asOf') asOf: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    const result = await this.account.listReceivables({
      companyId,
      branchId,
      customerId,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: parseLimit(limit) } : {}),
      ...(asOf !== undefined ? { asOf } : {}),
    });
    return { data: result.data.map(serializeReceivable), nextCursor: result.nextCursor };
  }

  @Get('advances')
  @RequirePermission('receivables:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async advances(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    const result = await this.account.listAdvances({
      companyId,
      branchId,
      customerId,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: parseLimit(limit) } : {}),
    });
    return { data: result.data.map(serializeAdvance), nextCursor: result.nextCursor };
  }

  @Get('unapplied-receipts')
  @RequirePermission('receivables:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async unappliedReceipts(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    const result = await this.account.listUnappliedReceipts({
      companyId,
      branchId,
      customerId,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: parseLimit(limit) } : {}),
    });
    return { data: result.data.map(serializeUnappliedReceipt), nextCursor: result.nextCursor };
  }

  @Get('statement')
  @RequirePermission('receivables:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async statement(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    const result = await this.account.getStatement({
      companyId,
      branchId,
      customerId,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: parseLimit(limit) } : {}),
    });
    return {
      data: result.data.map(serializeStatementLine),
      nextCursor: result.nextCursor,
      openingState: serializeOpeningState(result.openingState),
    };
  }
}
