import { Injectable } from '@nestjs/common';
import { getContext } from '../../common/context/index.js';
import { ForbiddenError } from '../../common/errors/domain-error.js';
import { PolicyEngine } from '../access/policy-engine.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { extractPgCode } from '../../common/errors/pg-error.js';
import {
  AnonymousCreditNoteRepository,
  type CreditNoteView,
} from './anonymous-credit-note.repository.js';
import type {
  AddRefundDto,
  ExecuteRefundDto,
  FailRefundDto,
  IssueAnonymousCreditNoteDto,
} from './anonymous-credit-note.dto.js';

/**
 * Thin application service: maps the DTO to a repository command and translates a DATABASE guard violation into a stable error. The
 * application layer already re-checks everything under the invoice lock, so a database guard only fires on a race the lock did not
 * cover or a bug — it must still never surface as an unexplained 500, and it must never echo the database message.
 */
@Injectable()
export class AnonymousCreditNoteService {
  constructor(
    private readonly repo: AnonymousCreditNoteRepository,
    private readonly policy: PolicyEngine,
  ) {}

  /**
   * Composite authority (owner decision 2: a cashier must not independently issue OR execute a refund). The route already required
   * `credit_notes:issue`; creating refund lines also needs `refunds:execute`. Checked with the SAME `PolicyEngine` the guard pipeline
   * uses (permission + step-up + company / branch scope) BEFORE any database work, exactly as the frozen 3b.8 cancel path does for
   * `credit_notes:issue`. A denial writes nothing.
   */
  private requireRefundAuthority(scope: { companyId: string; branchId: string }): void {
    const ctx = getContext();
    const decision = ctx
      ? this.policy.can(ctx, 'refunds:execute', {
          companyId: scope.companyId,
          branchId: scope.branchId,
        })
      : ({ allowed: false, reason: 'NO_CONTEXT' } as const);
    if (decision.allowed) return;
    if (decision.reason === 'STEP_UP_REQUIRED') {
      throw new DomainError('STEP_UP_REQUIRED', 'a fresh step-up is required', 403);
    }
    throw new ForbiddenError(
      'you do not have permission to execute a refund',
      'MISSING_PERMISSION',
    );
  }

  issue(
    scope: { companyId: string; branchId: string; invoiceId: string },
    dto: IssueAnonymousCreditNoteDto,
  ): Promise<CreditNoteView> {
    this.requireRefundAuthority(scope);
    return this.guard(() =>
      this.repo.issue({
        ...scope,
        reasonCode: dto.reasonCode,
        note: dto.note ?? null,
        lines: dto.lines,
        refunds: dto.refunds.map((r) => ({
          method: r.method,
          amountMinor: BigInt(r.amountMinor),
          reference: r.reference ?? null,
        })),
      }),
    );
  }

  addRefund(
    scope: { companyId: string; branchId: string; creditNoteId: string },
    dto: AddRefundDto,
  ): Promise<CreditNoteView> {
    this.requireRefundAuthority(scope);
    return this.guard(() =>
      this.repo.addRefund({
        ...scope,
        method: dto.method,
        amountMinor: BigInt(dto.amountMinor),
        reference: dto.reference ?? null,
      }),
    );
  }

  executeRefund(
    scope: { companyId: string; branchId: string; creditNoteId: string; refundId: string },
    dto: ExecuteRefundDto,
  ): Promise<CreditNoteView> {
    return this.guard(() =>
      this.repo.executeRefund({ ...scope, reference: dto.reference ?? null }),
    );
  }

  failRefund(
    scope: { companyId: string; branchId: string; creditNoteId: string; refundId: string },
    dto: FailRefundDto,
  ): Promise<CreditNoteView> {
    return this.guard(() => this.repo.failRefund({ ...scope, reasonCode: dto.reasonCode }));
  }

  get(scope: {
    companyId: string;
    branchId: string;
    creditNoteId: string;
  }): Promise<CreditNoteView> {
    return this.repo.get(scope);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const text = err instanceof Error ? err.message : '';
      const code = extractPgCode(err);
      // a violation of one of this feature's own database guards (their messages all start with the table name)
      if ((code === '23514' || code === '23505') && /anonymous_credit_note/.test(text)) {
        throw new DomainError(
          'CREDIT_NOTE_CONFLICT',
          'the credit conflicts with an earlier credit or refund of this sale; reload and retry',
          409,
        );
      }
      throw err;
    }
  }
}
