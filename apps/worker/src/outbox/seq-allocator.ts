import { runPlatform } from '@flower/db';
import type { DbService } from '@flower/backend';

export interface AllocateResult {
  /** true iff this call won the tenant's advisory lock for this attempt */
  readonly leader: boolean;
  /** rows freshly stamped with a seq this call (0 if not leader, or no work) */
  readonly stamped: number;
}

/**
 * Phase A — durable per-tenant `seq` allocation (OI-P2-1 / FC-1).
 *
 * Only the process that wins `pg_try_advisory_xact_lock` for this tenant may
 * stamp its unstamped, undispatched rows — serialized allocation, so `seq` is
 * strictly increasing per tenant. The lock is transaction-scoped: it is held for
 * exactly this call's `runPlatform` transaction and is released the moment that
 * transaction commits (success) or rolls back (any error, or a crash — Postgres
 * itself frees every lock held by a backend whose connection drops), so a
 * "leadership handover" is nothing more than the *next* caller successfully
 * acquiring the same lock once this one is gone.
 *
 * `seq` comes from `outbox_tenant_seq`, a durable per-tenant counter row
 * (chosen over a dynamic per-tenant `SEQUENCE` object — simpler to migrate,
 * test and operate) incremented via `UPDATE … RETURNING`, never `MAX(seq)+1`
 * (which would race). Rows are stamped in `(created_at, id)` order. **This
 * entire step commits before returning — no `XADD` happens here** (FC-1: "seq
 * persisted before XADD"). A non-leader touches nothing and returns
 * `{ leader: false, stamped: 0 }` — the rows it *saw* remain untouched
 * (`seq`/`dispatched_at` both still null) for whoever the leader turns out to
 * be, on this tick or a later one.
 */
export async function allocateTenantSeq(
  db: DbService,
  tenantId: string,
  batchSize = 50,
): Promise<AllocateResult> {
  return runPlatform(db.platformClient(), async (tx) => {
    const lock = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
      `SELECT pg_try_advisory_xact_lock(hashtext('outbox_seq:' || $1::text)) AS acquired`,
      tenantId,
    );
    if (!lock[0]?.acquired) return { leader: false, stamped: 0 };

    const rows = await tx.$queryRawUnsafe<{ id: string; createdAt: Date }[]>(
      `SELECT id, "createdAt" FROM outbox
        WHERE "tenantId" = $1::uuid AND seq IS NULL AND "dispatchedAt" IS NULL
        ORDER BY "createdAt", id
        FOR UPDATE
        LIMIT $2`,
      tenantId,
      batchSize,
    );

    let stamped = 0;
    for (const row of rows) {
      // one UPDATE … RETURNING — atomic, no read-then-write race, ever.
      const allocated = await tx.$queryRawUnsafe<{ allocated: string }[]>(
        `INSERT INTO outbox_tenant_seq ("tenantId", "nextSeq") VALUES ($1::uuid, 2)
           ON CONFLICT ("tenantId") DO UPDATE SET "nextSeq" = outbox_tenant_seq."nextSeq" + 1
         RETURNING "nextSeq" - 1 AS allocated`,
        tenantId,
      );
      const seq = allocated[0]!.allocated;
      // Keyed on `id` alone — it's a `uuidv7()`, already globally unique; the
      // `createdAt` half of the composite PK exists only to satisfy Postgres's
      // partitioning requirement, not for uniqueness. Deliberately NOT `AND
      // "createdAt" = $x`: a value read back through a JS `Date` loses the
      // `timestamptz(6)` column's sub-millisecond precision, so an equality
      // match against it can silently affect zero rows.
      // `seq IS NULL` guard: belt-and-braces against ever clobbering an
      // already-stamped row (this codepath only selected unstamped rows above,
      // but the guard makes the invariant explicit at the write site too), and
      // — since `$executeRawUnsafe`'s return is the actual affected-row count —
      // lets `stamped` reflect reality rather than an assumed success.
      const affected = await tx.$executeRawUnsafe(
        `UPDATE outbox SET seq = $1::bigint WHERE id = $2::uuid AND seq IS NULL`,
        seq,
        row.id,
      );
      stamped += affected;
    }
    return { leader: true, stamped };
  });
}

/**
 * Candidate tenants with unstamped, eligible work — a cheap, lock-free scan
 * (uses the `outbox_unstamped_idx` partial index). Discovery only: which
 * tenant actually gets to stamp anything is still decided by the advisory lock
 * in `allocateTenantSeq`.
 */
export async function discoverUnstampedTenants(db: DbService, limit = 20): Promise<string[]> {
  return runPlatform(db.platformClient(), async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ tenantId: string }[]>(
      `SELECT DISTINCT "tenantId" FROM outbox
        WHERE "tenantId" IS NOT NULL AND seq IS NULL AND "dispatchedAt" IS NULL
        LIMIT $1`,
      limit,
    );
    return rows.map((r) => r.tenantId);
  });
}
