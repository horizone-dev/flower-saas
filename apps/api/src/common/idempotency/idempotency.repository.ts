import { Injectable } from '@nestjs/common';
import { runPlatform, runScoped } from '@flower/db';
import { DbService } from '../db/db.module.js';

/**
 * The `idempotency_key` store (task 2.2 + hardening). Every tenant-scoped write
 * runs through `runScoped` → RLS confines it to the request's tenant
 * (constraint 9). The atomic claim is `INSERT … ON CONFLICT DO NOTHING
 * RETURNING`; a stale lease is reclaimed by a conditional `UPDATE` that re-checks
 * staleness *inside the statement*, so at most one concurrent reclaimer wins.
 *
 * Every successful claim / reclaim mints a fresh opaque **`claim_token`**.
 * `markDone` / `release` only act on a row whose token still matches → a stale
 * owner can never complete or release a newer owner's claim. `lockedAt` is only
 * the lease/staleness timestamp.
 */

export interface IdemIdentity {
  tenantId: string;
  scope: string;
  principalId: string;
  key: string;
}

interface IdemStateRow {
  status: 'PENDING' | 'DONE';
  requestHash: string;
  httpStatus: number | null;
  responseSnapshot: unknown;
  claimToken: string | null;
  stale: boolean;
  expired: boolean;
}

export type AcquireOutcome =
  | { kind: 'acquired'; claimToken: string }
  | { kind: 'replay'; httpStatus: number; snapshot: unknown; snapshotStored: boolean }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' }
  | { kind: 'retry' };

@Injectable()
export class IdempotencyRepository {
  constructor(private readonly db: DbService) {}

  async acquire(
    id: IdemIdentity,
    requestHash: string,
    ttlSeconds: number,
    staleLockSeconds: number,
  ): Promise<AcquireOutcome> {
    return runScoped(this.db.appClient(), { tenantId: id.tenantId }, async (tx) => {
      // An expired row for this identity must never block a fresh retry (constraint 8).
      await tx.$executeRawUnsafe(
        `DELETE FROM "idempotency_key"
          WHERE "tenantId" = $1::uuid AND "scope" = $2 AND "principalId" = $3::uuid AND "key" = $4
            AND "expiresAt" < now()`,
        id.tenantId,
        id.scope,
        id.principalId,
        id.key,
      );

      const inserted = await tx.$queryRawUnsafe<{ claimToken: string }[]>(
        `INSERT INTO "idempotency_key"
           ("tenantId","scope","principalId","key","requestHash","status","claimToken","lockedAt","createdAt","expiresAt")
         VALUES ($1::uuid,$2,$3::uuid,$4,$5,'PENDING',gen_random_uuid(),clock_timestamp(),now(),
                 now() + $6::int * interval '1 second')
         ON CONFLICT ("tenantId","scope","principalId","key") DO NOTHING
         RETURNING "claimToken"::text AS "claimToken"`,
        id.tenantId,
        id.scope,
        id.principalId,
        id.key,
        requestHash,
        ttlSeconds,
      );
      if (inserted.length > 0) return { kind: 'acquired', claimToken: inserted[0]!.claimToken };

      const rows = await tx.$queryRawUnsafe<IdemStateRow[]>(
        `SELECT "status","requestHash","httpStatus","responseSnapshot",
                "claimToken"::text AS "claimToken",
                ((now() - "lockedAt") > $5::int * interval '1 second') AS "stale",
                ("expiresAt" <= now()) AS "expired"
           FROM "idempotency_key"
          WHERE "tenantId" = $1::uuid AND "scope" = $2 AND "principalId" = $3::uuid AND "key" = $4`,
        id.tenantId,
        id.scope,
        id.principalId,
        id.key,
        staleLockSeconds,
      );
      const row = rows[0];
      if (!row || row.expired) return { kind: 'retry' }; // lost a race with cleanup
      if (row.requestHash !== requestHash) return { kind: 'mismatch' };
      if (row.status === 'DONE') {
        return {
          kind: 'replay',
          httpStatus: row.httpStatus ?? 200,
          snapshot: row.responseSnapshot,
          snapshotStored: row.responseSnapshot !== null,
        };
      }
      if (!row.stale) return { kind: 'in_progress' };

      // PENDING and stale — reclaim exactly the claim we observed, atomically,
      // re-checking staleness so at most one concurrent reclaimer wins.
      const took = await tx.$queryRawUnsafe<{ claimToken: string }[]>(
        `UPDATE "idempotency_key"
            SET "lockedAt" = clock_timestamp(),
                "claimToken" = gen_random_uuid(),
                "expiresAt" = now() + $1::int * interval '1 second'
          WHERE "tenantId" = $2::uuid AND "scope" = $3 AND "principalId" = $4::uuid AND "key" = $5
            AND "status" = 'PENDING'
            AND "requestHash" = $6
            AND "claimToken" IS NOT DISTINCT FROM $7::uuid
            AND (now() - "lockedAt") > $8::int * interval '1 second'
         RETURNING "claimToken"::text AS "claimToken"`,
        ttlSeconds,
        id.tenantId,
        id.scope,
        id.principalId,
        id.key,
        requestHash,
        row.claimToken,
        staleLockSeconds,
      );
      return took.length > 0
        ? { kind: 'acquired', claimToken: took[0]!.claimToken }
        : { kind: 'in_progress' };
    });
  }

  /** PENDING → DONE with the (already scrubbed) snapshot — only if this request
   *  still holds the claim (`claim_token` unchanged) and it is still PENDING. */
  async markDone(
    id: IdemIdentity,
    claimToken: string,
    httpStatus: number,
    snapshot: { stored: true; body: unknown } | { stored: false },
  ): Promise<void> {
    const body = snapshot.stored ? JSON.stringify(snapshot.body) : null;
    await runScoped(this.db.appClient(), { tenantId: id.tenantId }, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "idempotency_key"
            SET "status" = 'DONE', "httpStatus" = $1, "responseSnapshot" = $2::jsonb
          WHERE "tenantId" = $3::uuid AND "scope" = $4 AND "principalId" = $5::uuid AND "key" = $6
            AND "status" = 'PENDING' AND "claimToken" = $7::uuid`,
        httpStatus,
        body,
        id.tenantId,
        id.scope,
        id.principalId,
        id.key,
        claimToken,
      ),
    );
  }

  /** Handler failed (non-2xx / threw) → remove the PENDING row so a retry (or a
   *  waiting request) re-executes. A transient 5xx is never cached (constraint 7).
   *  Only removes a row this request still owns. */
  async release(id: IdemIdentity, claimToken: string): Promise<void> {
    await runScoped(this.db.appClient(), { tenantId: id.tenantId }, (tx) =>
      tx.$executeRawUnsafe(
        `DELETE FROM "idempotency_key"
          WHERE "tenantId" = $1::uuid AND "scope" = $2 AND "principalId" = $3::uuid AND "key" = $4
            AND "status" = 'PENDING' AND "claimToken" = $5::uuid`,
        id.tenantId,
        id.scope,
        id.principalId,
        id.key,
        claimToken,
      ),
    );
  }

  /** TTL cleanup — wired to the scheduler in task 2.3. Uses the platform path so
   *  one pass sweeps every tenant. Not required for correctness (`acquire`
   *  already drops an expired row for its own identity). */
  async sweepExpired(): Promise<number> {
    return runPlatform(this.db.platformClient(), async (tx) => {
      const deleted = await tx.$executeRawUnsafe(
        `DELETE FROM "idempotency_key" WHERE "expiresAt" < now()`,
      );
      return Number(deleted);
    });
  }
}
