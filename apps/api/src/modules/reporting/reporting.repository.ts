// A reporting repository never opens a connection of its own: it reads through the one
// sanctioned scoped transaction (`ScopedRepository.scoped`), exactly like every other module
// repository. The `ScopedTx` type is imported only to type the read callback.
import type { ScopedTx } from '@flower/db';
import { ScopedRepository, type DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';

/**
 * Task 3b.10 Checkpoint A — the narrow, READ-ONLY foundation every financial report
 * repository extends. It owns exactly the rules all reports share and nothing else:
 *
 *   - the data path is `ScopedRepository` (tenant from the authenticated `RequestContext`,
 *     never from a request value);
 *   - the transaction is DATABASE-ENFORCED read-only (`SET LOCAL transaction_read_only = on`
 *     is the first statement) — a report cannot mutate even by programming error;
 *   - tenant + company are EXPLICIT predicates in every report statement (supplied by
 *     {@link tenantIdOrThrow} + the route's company) — a report never relies on RLS or the
 *     branch GUC alone;
 *   - NO audit, NO outbox, NO realtime, NO idempotency, NO pagination state, NO write of any
 *     kind. A report is a pure function of the committed ledger.
 *
 * Company currency / timezone authority and the civil-date contract are the pure modules
 * `report-money.ts` and `report-date-range.ts`; the concrete report repositories compose them.
 */
export abstract class ReportingRepository extends ScopedRepository {
  protected constructor(db: DbService) {
    super(db);
  }

  /** The tenant of the authenticated request — the only tenant a report may read. */
  protected tenantIdOrThrow(): string {
    return requireTenantContext().tenantId;
  }

  /**
   * Run `fn` in a tenant-scoped, DB-enforced READ-ONLY transaction. `SET LOCAL
   * transaction_read_only = on` may be issued at any point (only the reverse switch is
   * restricted), and it lasts exactly for this transaction.
   */
  protected readScoped<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return this.scoped(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL transaction_read_only = on');
      return fn(tx);
    });
  }
}
