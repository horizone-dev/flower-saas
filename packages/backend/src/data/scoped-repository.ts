import { runScoped, type ScopedTx } from '@flower/db';
import { requireTenantContext } from '../context/index.js';
import type { DbService } from '../db/db.module.js';

/**
 * The ONLY sanctioned data path for a tenant-scoped domain module (CLAUDE.md
 * rule 6 / ADR-0004). A concrete repository extends this and calls `this.scoped`;
 * the tenant + branch filter is injected by RLS via `runScoped` — the repository
 * code never has to remember it, and a missed call fails closed (RLS returns
 * zero rows).
 *
 * `no-raw-prisma-in-scoped-modules` (ESLint) forbids reaching the client any
 * other way from inside `src/modules/**`.
 */
export abstract class ScopedRepository {
  protected constructor(protected readonly db: DbService) {}

  /**
   * Run `fn` inside a tenant-scoped transaction. Tenant + branch come from the
   * request context (populated only from the session — never a request field).
   * Throws `NotTenantScopedError` outside a tenant request.
   */
  protected async scoped<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    const ctx = requireTenantContext();
    return runScoped(
      this.db.appClient(),
      { tenantId: ctx.tenantId, branchId: ctx.singleBranchId },
      fn,
    );
  }
}
