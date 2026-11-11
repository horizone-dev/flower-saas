import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { SystemClock } from '../../common/clock/clock.js';
import { requireTenantContext } from '../../common/context/index.js';
import { DbService, ScopedRepository } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import {
  SUMMARY_MAX_NOTES,
  buildSummary,
  parseSummaryPeriod,
  type AnonymousCreditNoteSummary,
  type SummaryJson,
} from './anonymous-credit-note-summary.js';
import { ANONYMOUS_SUMMARY_SQL } from './anonymous-credit-note-summary.sql.js';

/**
 * Phase 3B closure — F-1 / F-2: the read-only anonymous credit-note summary. ONE statement in ONE database-enforced READ-ONLY scoped
 * transaction (`SET LOCAL transaction_read_only = on`), tenant from the authenticated context, company / branch from the validated route
 * params. NO audit, NO outbox, NO idempotency, NO write of any kind: a pure function of the committed ledger.
 */
@Injectable()
export class AnonymousCreditNoteSummaryRepository extends ScopedRepository {
  /** a `protected` seam only so a test can exercise the density boundary on a small real-document world; nothing in production overrides it */
  protected readonly maxNotes: number = SUMMARY_MAX_NOTES;

  constructor(
    db: DbService,
    private readonly clock: SystemClock,
  ) {
    super(db);
  }

  getCompany(input: {
    companyId: string;
    from: unknown;
    to: unknown;
  }): Promise<AnonymousCreditNoteSummary> {
    assertUuid(input.companyId, 'company');
    return this.read({ ...input, branchId: null });
  }

  getBranch(input: {
    companyId: string;
    branchId: string;
    from: unknown;
    to: unknown;
  }): Promise<AnonymousCreditNoteSummary> {
    assertUuid(input.companyId, 'company');
    assertUuid(input.branchId, 'branch');
    return this.read(input);
  }

  private async read(input: {
    companyId: string;
    branchId: string | null;
    from: unknown;
    to: unknown;
  }): Promise<AnonymousCreditNoteSummary> {
    const { from, to } = parseSummaryPeriod(input);
    const { tenantId } = requireTenantContext();
    const doc = await this.scoped(async (tx: ScopedTx) => {
      await tx.$executeRawUnsafe('SET LOCAL transaction_read_only = on');
      const rows = await tx.$queryRawUnsafe<{ doc: string }[]>(
        ANONYMOUS_SUMMARY_SQL,
        tenantId,
        input.companyId,
        from,
        to,
        input.branchId,
        this.maxNotes,
        this.clock.now(),
      );
      return rows[0]?.doc;
    });
    if (doc === undefined)
      throw new DomainError('REPORT_DATA_INVALID', 'the summary statement returned no row', 500);
    const json = JSON.parse(doc) as SummaryJson;
    if (json.company === null) throw new NotFoundError('company');
    if (json.candidateNotes > this.maxNotes) {
      throw new DomainError(
        'REPORT_RESULT_TOO_LARGE',
        `the anonymous credit-note summary of this ${input.branchId === null ? 'company' : 'branch'} and period would hold more than ${this.maxNotes} credit notes — narrow the period${input.branchId === null ? ' or request one branch' : ''}`,
        422,
        [{ field: 'period', issue: `more than ${this.maxNotes} credit notes` }],
      );
    }
    return buildSummary(json, { companyId: input.companyId, branchId: input.branchId, from, to });
  }
}
