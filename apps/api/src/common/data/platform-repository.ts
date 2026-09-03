import { runPlatform, type ScopedTx } from '@flower/db';
import type { DbService } from '../db/db.module.js';

/**
 * The separate, explicitly-audited cross-tenant path (ADR-0014 / SECURITY.md).
 * Runs as `flower_platform` (BYPASSRLS) — it can see and write every tenant's
 * rows, so **every caller MUST also write an `audit_log` record** (Phase 1 task
 * 1.14). Reachable only from the `platform` module (the boundary lint rule keeps
 * other modules off it — they have no reason to extend this class).
 *
 * Use this only for operations that are inherently cross-tenant: listing all
 * tenants, the audit viewer, provisioning, impersonation setup, plan/entitlement
 * administration. Anything scoped to one tenant uses `ScopedRepository`.
 */
export abstract class PlatformRepository {
  protected constructor(protected readonly db: DbService) {}

  protected async platform<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runPlatform(this.db.platformClient(), fn);
  }
}
