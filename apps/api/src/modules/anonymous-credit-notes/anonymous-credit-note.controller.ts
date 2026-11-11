import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { NoStepUp, ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import {
  addRefundSchema,
  executeRefundSchema,
  failRefundSchema,
  issueAnonymousCreditNoteSchema,
  type AddRefundDto,
  type ExecuteRefundDto,
  type FailRefundDto,
  type IssueAnonymousCreditNoteDto,
} from './anonymous-credit-note.dto.js';
import { AnonymousCreditNoteService } from './anonymous-credit-note.service.js';

/**
 * `/v1/companies/:companyId/branches/:branchId/…` — RB-1 A2 (owner decision 2026-11-11): credit notes and refunds for an ANONYMOUS
 * issued sale. Branch-nested (Branch is THE operational scope): `@ScopedParam` gives a non-disclosing 404 outside the caller's company /
 * branch, and every repository query ALSO carries tenant, company and branch predicates.
 *
 * AUTHORITY (owner decision 2): a cashier can neither issue nor execute — the keys are the EXISTING `credit_notes:issue` and
 * `refunds:execute` (owner / admin / manager / accountant, both step-up gated). Issuing a credit note creates refund lines, so it
 * needs BOTH keys (the route declares `credit_notes:issue`; the service then requires `refunds:execute` through the same `PolicyEngine`,
 * with step-up, before any work — the frozen 3b.8 cancel path's own composite-authority pattern); attesting or failing a refund's tender execution needs `refunds:execute`. A GET needs `credit_notes:view`.
 * Mutations require an `Idempotency-Key` (the shared interceptor): a replay returns the stored response and runs nothing again.
 *
 * No financial logic lives here: the controller parses, validates and delegates. The order, the invoice and the original sale journal
 * are never modified by any of these routes.
 */
@Controller('companies/:companyId/branches/:branchId')
export class AnonymousCreditNoteController {
  constructor(private readonly service: AnonymousCreditNoteService) {}

  @Post('invoices/:invoiceId/anonymous-credit-notes')
  @RequirePermission('credit_notes:issue')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'orders.anonymous_credit_note.issue' })
  async issue(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('invoiceId') invoiceId: string,
    @Body(new ZodBody(issueAnonymousCreditNoteSchema)) dto: IssueAnonymousCreditNoteDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(invoiceId, 'invoice');
    return this.service.issue({ companyId, branchId, invoiceId }, dto);
  }

  @Get('anonymous-credit-notes/:creditNoteId')
  @RequirePermission('credit_notes:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async get(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('creditNoteId') creditNoteId: string,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(creditNoteId, 'credit_note');
    return this.service.get({ companyId, branchId, creditNoteId });
  }

  /** a replacement refund line for the amount a FAILED line left unallocated (never above the credit total or a tender's cap) */
  @Post('anonymous-credit-notes/:creditNoteId/refunds')
  @RequirePermission('credit_notes:issue')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'orders.anonymous_credit_note.refund_add' })
  async addRefund(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('creditNoteId') creditNoteId: string,
    @Body(new ZodBody(addRefundSchema)) dto: AddRefundDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(creditNoteId, 'credit_note');
    return this.service.addRefund({ companyId, branchId, creditNoteId }, dto);
  }

  /** attest that the tender execution really happened — only then is the refund EXECUTED (and cash / bank leave the in-flight account) */
  @Post('anonymous-credit-notes/:creditNoteId/refunds/:refundId/execute')
  @HttpCode(200)
  @RequirePermission('refunds:execute')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'orders.anonymous_credit_note.refund_execute' })
  async executeRefund(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('creditNoteId') creditNoteId: string,
    @Param('refundId') refundId: string,
    @Body(new ZodBody(executeRefundSchema)) dto: ExecuteRefundDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(creditNoteId, 'credit_note');
    assertUuid(refundId, 'refund');
    return this.service.executeRefund({ companyId, branchId, creditNoteId, refundId }, dto);
  }

  /** attest that the tender execution FAILED — no posting; the amount needs a replacement refund line */
  @Post('anonymous-credit-notes/:creditNoteId/refunds/:refundId/fail')
  @HttpCode(200)
  @RequirePermission('refunds:execute')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'orders.anonymous_credit_note.refund_fail' })
  async failRefund(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('creditNoteId') creditNoteId: string,
    @Param('refundId') refundId: string,
    @Body(new ZodBody(failRefundSchema)) dto: FailRefundDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(creditNoteId, 'credit_note');
    assertUuid(refundId, 'refund');
    return this.service.failRefund({ companyId, branchId, creditNoteId, refundId }, dto);
  }
}
