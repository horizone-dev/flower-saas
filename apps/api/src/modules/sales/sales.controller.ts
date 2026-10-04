import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid, parseIfMatch, requireIfMatch } from '../catalog/catalog-write.helpers.js';
import { CompleteSaleAuthorityGuard } from './complete-sale-authority.guard.js';
import { CompleteSaleFingerprintProvider } from './complete-sale-fingerprint.provider.js';
import { completeSaleSchema, type CompleteSaleDto } from './dto/complete-sale.dto.js';
import { OrderTotalsPreviewService } from './order-totals-preview.service.js';
import { SalesApplicationService } from './sales-application.service.js';

/**
 * `/v1/companies/:companyId/branches/:branchId/orders/:orderId/…` — task 3b.9 Checkpoint E,
 * the public surface of the atomic walk-in sale. Branch-nested throughout (Branch is THE
 * operational scope, CLAUDE.md rule 8): `@ScopedParam({ company: 'companyId', branch:
 * 'branchId' })` means a caller outside the company / branch can never reach an order here —
 * the guard pipeline answers a non-disclosing 404 before this controller runs — and the
 * repositories ALSO carry company / branch as explicit predicates (DB RLS on orders / invoices /
 * payments / journals is tenant-only, never the branch boundary). The tenant comes ONLY from the
 * authenticated `RequestContext`. A POS terminal is attribution only and is never read here.
 *
 * This controller holds NO financial logic: no tax, money, credit, payment, receivable or advance
 * rule. It parses headers, validates the body, delegates, and returns.
 */
@Controller('companies/:companyId/branches/:branchId/orders')
export class SalesController {
  constructor(
    private readonly sales: SalesApplicationService,
    private readonly totals: OrderTotalsPreviewService,
  ) {}

  /**
   * The read-only canonical totals preview (OD-4). Advisory and version-bound: it reports the
   * order `version` it was computed for, never authorizes or freezes anything, and completion
   * recomputes under the order lock.
   */
  @Get(':orderId/totals')
  @RequirePermission('orders:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async preview(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('orderId') orderId: string,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(orderId, 'order');
    return this.totals.preview({ companyId, branchId, orderId });
  }

  /**
   * Complete a DRAFT order as one atomic sale (OD-5). The ORDER's persisted customer decides
   * whether it is the anonymous PAY_NOW path or the identified-customer path — there is no
   * client mode flag.
   *
   * Authorization, in order, all BEFORE any idempotent replay can happen (guards run before
   * interceptors): the global pipeline (`orders:manage`, entitlement, company / branch scope);
   * then `CompleteSaleAuthorityGuard` (`payments:collect` when the request carries tenders,
   * `receivables:advance:apply` when it carries advance applications). The credit-limit
   * override is NOT decided here: only if the frozen orchestrator finds one necessary does the
   * frozen `authorize()` run (Owner permission + step-up + a bounded, audited reason).
   *
   * `Idempotency-Key` is required (the shared interceptor); `If-Match` is the expected order
   * version and is part of the semantic idempotency fingerprint
   * (`CompleteSaleFingerprintProvider`). A successful 2xx result is stored and replayed
   * verbatim — a replay returns the stored response before the facade, the orchestrator, the
   * journal adapter, numbering or any payment logic run again. 200 (a command on an existing
   * order, like hold / resume / cancel), not 201.
   */
  @Post(':orderId/complete-sale')
  @HttpCode(200)
  @RequirePermission('orders:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @UseGuards(CompleteSaleAuthorityGuard)
  @Idempotent({
    scope: 'orders.complete_sale',
    semanticFingerprintProvider: CompleteSaleFingerprintProvider,
  })
  async completeSale(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('orderId') orderId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodBody(completeSaleSchema)) dto: CompleteSaleDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(orderId, 'order');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    // the global IdempotencyInterceptor already required + shape-validated this header before
    // this handler ever ran — defensive, not a second validation layer
    if (!idempotencyKey) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    return this.sales.completeSale({
      companyId,
      branchId,
      orderId,
      expectedVersion,
      paymentIntent: dto.paymentIntent,
      tenders: dto.tenders.map((t) => ({ method: t.method, amountMinor: BigInt(t.amountMinor) })),
      advanceApplications: dto.advanceApplications.map((a) => ({
        advanceId: a.advanceId,
        amountMinor: BigInt(a.amountMinor),
      })),
      ...(dto.creditLimitExceptionReason !== undefined
        ? { creditLimitExceptionReason: dto.creditLimitExceptionReason }
        : {}),
      idempotencyKey,
    });
  }
}
