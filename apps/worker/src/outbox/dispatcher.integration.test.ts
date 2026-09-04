import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { runDispatcher } from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import { type Logger } from '@flower/service-runtime';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { allocateTenantSeq, discoverUnstampedTenants } from './seq-allocator.js';
import { publishNextForTenant, publishReadyAcrossTenants } from './publisher.js';
import { buildEnvelope, streamKey, ENVELOPE_FIELD, type OutboxRow } from './envelope.js';
import { OutboxDispatcher } from './dispatcher.js';

/**
 * The outbox dispatcher, end to end, against real PostgreSQL + Redis
 * (Testcontainers) — PHASE-2-CORE-PLAN §2.4 / HG-OUTBOX / OI-P2-1. No mocked
 * database or Redis anywhere in this file.
 */
describe('outbox dispatcher (integration — Postgres + Redis)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let redis: Redis;
  let db: DbService;
  const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    redis = new Redis(stack.redis.url);

    db = new DbService(dbConfig());
  }, 300_000);

  /** `BackendConfig` for this stack — `AUTH_JWT_SECRET`/`AUTH_ACCESS_TOKEN_TTL_SECONDS`
   *  (task 2.5) are unused by anything in this Postgres+Redis-only outbox suite,
   *  a dev-default value satisfies the type. */
  function dbConfig(): BackendConfig {
    return {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: stack.postgres.url,
      PLATFORM_DATABASE_URL: stack.postgres.url,
      AUTH_JWT_SECRET: 'dev-only-insecure-jwt-secret-change-me-000',
      AUTH_ACCESS_TOKEN_TTL_SECONDS: 600,
    };
  }

  afterAll(async () => {
    await redis?.quit();
    await pool?.end();
    await stack?.stop();
  });

  // `publishReadyAcrossTenants` discovers tenants GLOBALLY (any tenant with
  // ready work, by design — see publisher.ts). A test that only stamps a row
  // (never publishes it) would otherwise leave a "ready to publish" row lying
  // around that a LATER test's publish call picks up instead of its own —
  // full isolation between tests requires a clean slate every time, not just
  // fresh tenant ids.
  afterEach(async () => {
    await pool.query('DELETE FROM outbox');
    await pool.query('DELETE FROM outbox_tenant_seq');
    const keys = await redis.keys('rt:stream:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  /** A fresh `DbService` — its own Prisma client / connection pool, so an
   *  advisory lock taken through it is genuinely a separate Postgres session. */
  function freshDb(): DbService {
    return new DbService(dbConfig());
  }

  async function insertOutboxRow(over: {
    tenantId: string;
    aggregateType?: string;
    aggregateId?: string;
    eventType?: string;
    payload?: unknown;
    createdAt?: Date;
    branchId?: string | null;
    resourceVersion?: bigint | null;
    actorSummary?: unknown;
  }): Promise<{ id: string; createdAt: Date }> {
    const { rows } = await pool.query<{ id: string; createdAt: Date }>(
      `INSERT INTO outbox
         (id, "tenantId", "branchId", "aggregateType", "aggregateId", "eventType", payload,
          "resourceVersion", "actorSummary", "createdAt")
       VALUES (uuidv7(), $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::jsonb, COALESCE($9, now()))
       RETURNING id, "createdAt"`,
      [
        over.tenantId,
        over.branchId ?? null,
        over.aggregateType ?? 'tenant',
        over.aggregateId ?? over.tenantId,
        over.eventType ?? 'test.event',
        JSON.stringify(over.payload ?? { note: 'test payload' }),
        over.resourceVersion != null ? over.resourceVersion.toString() : null,
        over.actorSummary != null ? JSON.stringify(over.actorSummary) : null,
        over.createdAt ?? null,
      ],
    );
    return rows[0]!;
  }

  async function fetchRow(id: string): Promise<{
    seq: string | null;
    dispatchedAt: Date | null;
    attempts: number;
    availableAt: Date;
    lastError: string | null;
  }> {
    const { rows } = await pool.query(
      `SELECT seq, "dispatchedAt", attempts, "availableAt", "lastError" FROM outbox WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function streamEntries(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const raw = await redis.xrange(streamKey(tenantId), '-', '+');
    return raw.map(([, fields]) => {
      const idx = fields.indexOf(ENVELOPE_FIELD);
      return JSON.parse(fields[idx + 1]!) as Record<string, unknown>;
    });
  }

  /** A promise plus its own resolver, for orchestrating a genuine overlap
   *  between two concurrent transactions (`Promise.all` alone does not
   *  guarantee the underlying DB operations actually overlap in time — one
   *  call's whole transaction can complete before the other even starts). */
  function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await sleep(50);
    }
  }

  // ── 1. single event publish ──────────────────────────────────────────────
  it('a single row is stamped, published exactly once, and marked dispatched', async () => {
    const tenantId = randomUUID();
    const row = await insertOutboxRow({ tenantId, eventType: 'single.event' });

    const alloc = await allocateTenantSeq(db, tenantId);
    expect(alloc).toEqual({ leader: true, stamped: 1 });

    const pub = await publishReadyAcrossTenants(db, redis);
    expect(pub).toEqual({ published: 1, failed: 0 });

    const entries = await streamEntries(tenantId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event_id: row.id,
      seq: '1',
      tenant_id: tenantId,
      type: 'single.event',
    });

    const stored = await fetchRow(row.id);
    expect(stored.seq).toBe('1');
    expect(stored.dispatchedAt).not.toBeNull();
  });

  // ── 2. multiple ordered events in one tenant ─────────────────────────────
  it('multiple events in one tenant are stamped in (created_at, id) order — seq matches append order', async () => {
    const tenantId = randomUUID();
    const t0 = new Date();
    const r1 = await insertOutboxRow({
      tenantId,
      eventType: 'e1',
      createdAt: new Date(t0.getTime()),
    });
    const r2 = await insertOutboxRow({
      tenantId,
      eventType: 'e2',
      createdAt: new Date(t0.getTime() + 10),
    });
    const r3 = await insertOutboxRow({
      tenantId,
      eventType: 'e3',
      createdAt: new Date(t0.getTime() + 20),
    });

    const alloc = await allocateTenantSeq(db, tenantId);
    expect(alloc).toEqual({ leader: true, stamped: 3 });

    const s1 = await fetchRow(r1.id);
    const s2 = await fetchRow(r2.id);
    const s3 = await fetchRow(r3.id);
    expect([s1.seq, s2.seq, s3.seq]).toEqual(['1', '2', '3']);

    await publishReadyAcrossTenants(db, redis, { perTenantBatchSize: 10 });
    const entries = await streamEntries(tenantId);
    expect(entries.map((e) => e['type'])).toEqual(['e1', 'e2', 'e3']);
    expect(entries.map((e) => e['seq'])).toEqual(['1', '2', '3']);
  });

  // ── 3. concurrent different tenants ──────────────────────────────────────
  it('two different tenants allocate concurrently, independently — neither blocks the other', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await insertOutboxRow({ tenantId: tenantA });
    await insertOutboxRow({ tenantId: tenantB });

    const [resA, resB] = await Promise.all([
      allocateTenantSeq(freshDb(), tenantA),
      allocateTenantSeq(freshDb(), tenantB),
    ]);
    expect(resA).toEqual({ leader: true, stamped: 1 });
    expect(resB).toEqual({ leader: true, stamped: 1 });
  });

  // ── 4. two dispatcher processes competing for the same tenant ───────────
  it('two processes racing for the same tenant: the lock holder wins, the other defers untouched', async () => {
    const tenantId = randomUUID();
    await insertOutboxRow({ tenantId, eventType: 'race-1' });
    await insertOutboxRow({ tenantId, eventType: 'race-2' });

    const dbA = freshDb();
    const dbB = freshDb();
    const lockHeld = deferred();
    const releaseHold = deferred();

    // dbA takes the advisory lock and deliberately holds its transaction open
    // — a real overlap, not a `Promise.all` timing gamble (two independent
    // transactions can easily run fully sequentially even when "started
    // concurrently"; only an explicitly-held lock guarantees the second
    // attempt genuinely happens while the first is still active).
    const heldTx = runDispatcher(dbA.platformClient(), async (tx) => {
      const lock = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
        `SELECT pg_try_advisory_xact_lock(hashtext('outbox_seq:' || $1::text)) AS acquired`,
        tenantId,
      );
      expect(lock[0]?.acquired).toBe(true);
      lockHeld.resolve();
      await releaseHold.promise; // keep the transaction — and the lock — open
    });

    await lockHeld.promise; // dbA definitely holds the lock now
    const resB = await allocateTenantSeq(dbB, tenantId); // must defer
    expect(resB).toEqual({ leader: false, stamped: 0 });

    releaseHold.resolve(); // dbA made no writes — nothing to roll back or lose
    await heldTx;

    // the lock is free again — a fresh attempt becomes leader and claims BOTH rows.
    const resA = await allocateTenantSeq(freshDb(), tenantId);
    expect(resA).toEqual({ leader: true, stamped: 2 });

    // no unstamped work left for anyone
    expect(await discoverUnstampedTenants(db)).not.toContain(tenantId);
  });

  // ── 4b. same-tenant publish ordering under concurrent processes (remediation, 2026-09-04) ──
  // Concern #1: seq uniqueness/monotonicity alone does not guarantee STREAM
  // APPEND order. This proves the `outbox_publish:` lock, not just distinct
  // `seq` values, is what prevents a faster process from appending seq=2
  // ahead of a slower, still-in-flight seq=1 for the SAME tenant.
  it('same-tenant publish is strictly ordered: a concurrent attempt cannot append seq N+1 ahead of a slow, in-flight seq N', async () => {
    const tenantId = randomUUID();
    const t0 = new Date();
    const rLow = await insertOutboxRow({ tenantId, eventType: 'slow-n', createdAt: t0 });
    const rHigh = await insertOutboxRow({
      tenantId,
      eventType: 'fast-n-plus-1',
      createdAt: new Date(t0.getTime() + 10),
    });
    await allocateTenantSeq(db, tenantId, 10);
    expect((await fetchRow(rLow.id)).seq).toBe('1');
    expect((await fetchRow(rHigh.id)).seq).toBe('2');

    // Deliberately slow down XADD for exactly the first call issued through
    // this client — long enough that a genuinely concurrent
    // `publishNextForTenant` attempt for the SAME tenant is issued (and must
    // defer) while seq=1's publish transaction — and its `outbox_publish:`
    // advisory lock — is still open.
    type XaddFn = (...args: unknown[]) => Promise<unknown>;
    const originalXadd = redis.xadd.bind(redis) as unknown as XaddFn;
    const releaseXadd = deferred();
    let xaddCalls = 0;
    redis.xadd = (async (...args: unknown[]) => {
      xaddCalls++;
      if (xaddCalls === 1) await releaseXadd.promise;
      return originalXadd(...args);
    }) as unknown as typeof redis.xadd;

    try {
      const slowPublish = publishNextForTenant(freshDb(), tenantId, redis);
      await waitFor(async () => (xaddCalls > 0 ? true : undefined), 5_000);

      // a second, independent process races for the SAME tenant while seq=1's
      // publish transaction is still open — it must defer, never publish
      // seq=2 ahead of it.
      const concurrent = await publishNextForTenant(freshDb(), tenantId, redis);
      expect(concurrent).toBe('not-leader');
      expect(await streamEntries(tenantId)).toHaveLength(0); // nothing appended yet, at all

      releaseXadd.resolve();
      expect(await slowPublish).toBe('published');
    } finally {
      redis.xadd = originalXadd as unknown as typeof redis.xadd;
    }

    // seq=2 is free to publish now that seq=1 has committed.
    expect(await publishNextForTenant(freshDb(), tenantId, redis)).toBe('published');

    const entries = await streamEntries(tenantId);
    expect(entries.map((e) => e['seq'])).toEqual(['1', '2']);
    expect(entries.map((e) => e['type'])).toEqual(['slow-n', 'fast-n-plus-1']);
  });

  // ── 5. leader handover ───────────────────────────────────────────────────
  it('leadership handover preserves monotonic seq — the next leader continues, never resets or reuses', async () => {
    const tenantId = randomUUID();
    const r1 = await insertOutboxRow({ tenantId });
    const dbA = freshDb();
    const allocA = await allocateTenantSeq(dbA, tenantId); // dbA leads, stamps r1, commits (lock released)
    expect(allocA).toEqual({ leader: true, stamped: 1 });
    const seq1 = (await fetchRow(r1.id)).seq;

    const r2 = await insertOutboxRow({ tenantId });
    const dbB = freshDb();
    const allocB = await allocateTenantSeq(dbB, tenantId); // a DIFFERENT process becomes leader now
    expect(allocB).toEqual({ leader: true, stamped: 1 });
    const seq2 = (await fetchRow(r2.id)).seq;

    expect(BigInt(seq2!)).toBe(BigInt(seq1!) + 1n); // continues, does not reset to 1
  });

  // ── 6. seq assigned once and immutable ───────────────────────────────────
  it('seq is assigned exactly once — a re-allocation attempt never touches an already-stamped row', async () => {
    const tenantId = randomUUID();
    const row = await insertOutboxRow({ tenantId });
    await allocateTenantSeq(db, tenantId);
    const first = (await fetchRow(row.id)).seq;

    // a second allocation call (as if a later tick, or a handed-over leader)
    const again = await allocateTenantSeq(db, tenantId);
    expect(again.stamped).toBe(0); // nothing left unstamped
    const second = (await fetchRow(row.id)).seq;
    expect(second).toBe(first);
  });

  // ── 7. crash before XADD ─────────────────────────────────────────────────
  it('crash before XADD: the row stays undispatched; a later publish succeeds exactly once', async () => {
    const tenantId = randomUUID();
    const row = await insertOutboxRow({ tenantId });
    await allocateTenantSeq(db, tenantId); // stamped, but never published — simulates the crash window

    const before = await fetchRow(row.id);
    expect(before.seq).not.toBeNull();
    expect(before.dispatchedAt).toBeNull();
    expect(await streamEntries(tenantId)).toHaveLength(0);

    const outcome = await publishNextForTenant(db, tenantId, redis);
    expect(outcome).toBe('published');
    expect(await streamEntries(tenantId)).toHaveLength(1);
    expect((await fetchRow(row.id)).dispatchedAt).not.toBeNull();
  });

  // ── 8 + 9 + 10. crash after XADD / before ack, retry duplicate identity, dedup ──
  it('crash after XADD but before the ack commits: retry republishes with the IDENTICAL event_id + seq; a dedup consumer applies the effect once', async () => {
    const tenantId = randomUUID();
    const row = await insertOutboxRow({ tenantId, eventType: 'crash-after-xadd' });
    await allocateTenantSeq(db, tenantId);

    // Reproduce the crash precisely: the same lock+SELECT+XADD
    // publishNextForTenant performs, but the transaction is forced to roll
    // back before the ack UPDATE commits.
    await expect(
      runDispatcher(db.platformClient(), async (tx) => {
        const lock = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(hashtext('outbox_publish:' || $1::text)) AS acquired`,
          tenantId,
        );
        expect(lock[0]?.acquired).toBe(true);
        const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
          `SELECT id, "tenantId", "branchId", "aggregateType", "aggregateId", "eventType",
                  "resourceVersion", "actorSummary", "createdAt", seq, attempts
             FROM outbox
            WHERE "tenantId" = $1::uuid AND seq IS NOT NULL AND "dispatchedAt" IS NULL
            ORDER BY seq
            LIMIT 1
            FOR UPDATE`,
          tenantId,
        );
        const envelope = buildEnvelope(rows[0]!);
        await redis.xadd(streamKey(tenantId), '*', ENVELOPE_FIELD, JSON.stringify(envelope));
        throw new Error('SIMULATED_CRASH_BEFORE_ACK');
      }),
    ).rejects.toThrow('SIMULATED_CRASH_BEFORE_ACK');

    // the crash rolled back the whole transaction — dispatched_at is still null,
    // and attempts was never touched (the crash never reached the catch block).
    const midway = await fetchRow(row.id);
    expect(midway.dispatchedAt).toBeNull();
    expect(midway.attempts).toBe(0);
    expect(await streamEntries(tenantId)).toHaveLength(1); // the "crashed" XADD did land in Redis

    // the retry: publishNextForTenant re-selects the SAME row and republishes it.
    const outcome = await publishNextForTenant(db, tenantId, redis);
    expect(outcome).toBe('published');

    const entries = await streamEntries(tenantId);
    expect(entries).toHaveLength(2); // a genuine duplicate Stream entry
    expect(entries[0]!['event_id']).toBe(row.id);
    expect(entries[1]!['event_id']).toBe(row.id);
    expect(entries[0]!['seq']).toBe(entries[1]!['seq']); // identical seq across both

    // 10. a dedup consumer applies the business effect exactly once.
    const applied = new Set<string>();
    let effectCount = 0;
    for (const e of entries) {
      const id = e['event_id'] as string;
      if (applied.has(id)) continue; // duplicate — skip
      applied.add(id);
      effectCount++;
    }
    expect(effectCount).toBe(1);

    // and dispatched_at is now durably set — no third publish will occur.
    expect((await fetchRow(row.id)).dispatchedAt).not.toBeNull();
  });

  // ── crash after dispatched_at: never republished ─────────────────────────
  it('a row already marked dispatched is never republished', async () => {
    const tenantId = randomUUID();
    const row = await insertOutboxRow({ tenantId });
    await allocateTenantSeq(db, tenantId);
    await publishNextForTenant(db, tenantId, redis);
    expect(await streamEntries(tenantId)).toHaveLength(1);

    const again = await publishNextForTenant(db, tenantId, redis); // nothing eligible for THIS tenant
    expect(again).toBe('empty');
    expect(await streamEntries(tenantId)).toHaveLength(1);
    expect((await fetchRow(row.id)).dispatchedAt).not.toBeNull();
  });

  // ── 11. Redis unavailable -> retry/backoff -> recovery ───────────────────
  it('Redis unavailable: the row backs off (attempts/lastError/availableAt), then a later publish recovers', async () => {
    const tenantId = randomUUID();
    const row = await insertOutboxRow({ tenantId, eventType: 'redis-down' });
    await allocateTenantSeq(db, tenantId);

    const deadRedis = new Redis({
      host: '127.0.0.1',
      port: 59989,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    // generously wide relative to normal test/assertion overhead — under
    // concurrent Testcontainers load (many files' containers competing for
    // CPU/IO) a tight window (tens of ms) is genuinely reachable between two
    // sequential `await`s and makes the "too soon" assertion below flaky.
    const shortBackoff = { baseMs: 2_000, maxMs: 3_000 };
    const outcome = await publishNextForTenant(db, tenantId, deadRedis, shortBackoff);
    expect(outcome).toBe('failed');
    deadRedis.disconnect();

    const failed = await fetchRow(row.id);
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBeTruthy();
    expect(failed.lastError).not.toContain(stack.redis.url); // never leak a connection string
    expect(await streamEntries(tenantId)).toHaveLength(0);

    // immediately retrying (still within the backoff window) finds nothing
    // eligible — the real, observable proof that availableAt was pushed into
    // the future (a raw timestamp comparison against a fresh Date.now() would
    // be flaky under real DB/CI round-trip jitter; this behavioural check is
    // not).
    const tooSoon = await publishNextForTenant(db, tenantId, redis, shortBackoff);
    expect(tooSoon).toBe('empty');
    expect(await streamEntries(tenantId)).toHaveLength(0);

    // recovery: once the backoff window elapses, a healthy Redis connection
    // succeeds. waitFor polls (well past maxMs) rather than a single fixed
    // sleep, so this isn't sensitive to exactly how long the window was.
    const recovered = await waitFor(async () => {
      const o = await publishNextForTenant(db, tenantId, redis, shortBackoff);
      return o === 'published' ? o : undefined;
    }, 15_000);
    expect(recovered).toBe('published');
    expect(await streamEntries(tenantId)).toHaveLength(1);
    void row;
  });

  // ── 12. one failing tenant does not block another ────────────────────────
  // (the orchestrator-level guarantee — OutboxDispatcher.tick() catches a
  // per-tenant allocateTenantSeq rejection and still runs the publish phase —
  // is unit-tested with a mocked seq-allocator in dispatcher.test.ts; this is
  // the real-database half: a genuinely failing allocation attempt (a
  // malformed tenant id — a real Postgres cast error, not a mock) must not
  // corrupt the connection pool or block a subsequent, unrelated tenant.)
  it('a failed allocation attempt (real Postgres error) never blocks a subsequent tenant on the same db', async () => {
    await expect(allocateTenantSeq(db, 'not-a-valid-uuid')).rejects.toThrow();

    const tenantOk = randomUUID();
    await insertOutboxRow({ tenantId: tenantOk, eventType: 'after-a-failure' });
    const alloc = await allocateTenantSeq(db, tenantOk); // same DbService / pool as the failed call above
    expect(alloc).toEqual({ leader: true, stamped: 1 });
    await publishReadyAcrossTenants(db, redis, { perTenantBatchSize: 10 });
    expect(await streamEntries(tenantOk)).toHaveLength(1);
  });

  // ── no secret-bearing fields in the envelope ─────────────────────────────
  it('the envelope never carries the payload (secrets in payload must never reach the Stream)', async () => {
    const tenantId = randomUUID();
    const row = await insertOutboxRow({
      tenantId,
      eventType: 'has-secret-payload',
      payload: { apiKey: 'sk_live_should_never_leave_postgres', note: 'business detail' },
      actorSummary: { userId: randomUUID(), accountType: 'OWNER' },
    });
    await allocateTenantSeq(db, tenantId);
    await publishNextForTenant(db, tenantId, redis);

    const raw = await redis.xrange(streamKey(tenantId), '-', '+');
    const rawText = JSON.stringify(raw);
    expect(rawText).not.toContain('sk_live_should_never_leave_postgres');
    expect(rawText).not.toContain('business detail');

    const entries = await streamEntries(tenantId);
    expect(Object.keys(entries[0]!).sort()).toEqual(
      [
        'actor_summary',
        'branch_id',
        'event_id',
        'occurred_at',
        'resource_id',
        'resource_type',
        'resource_version',
        'seq',
        'tenant_id',
        'type',
      ].sort(),
    );
    void row;
  });

  // ── routing metadata for Phase 2.5 (remediation, 2026-09-04, concern #2) ──
  // The gateway (Task 2.5) must be able to route/authorize off first-class
  // envelope fields alone — never by parsing `payload`. These prove that
  // guarantee end to end, through the real dispatcher and into the actual
  // Redis Stream entry (not just `buildEnvelope` in isolation — see
  // envelope.test.ts for the unit-level coverage).
  it('a branch-scoped event preserves branch_id through the full pipeline into the Stream entry', async () => {
    const tenantId = randomUUID();
    const branchId = randomUUID();
    const row = await insertOutboxRow({
      tenantId,
      branchId,
      eventType: 'branch.scoped.event',
      resourceVersion: 7n,
      actorSummary: { userId: randomUUID(), accountType: 'STAFF' },
    });
    await allocateTenantSeq(db, tenantId);
    await publishNextForTenant(db, tenantId, redis);

    const entries = await streamEntries(tenantId);
    expect(entries[0]).toMatchObject({
      event_id: row.id,
      tenant_id: tenantId,
      branch_id: branchId,
      resource_version: '7',
    });
  });

  it('a tenant-global event (no branch) yields branch_id: null in the Stream entry, not an omitted field', async () => {
    const tenantId = randomUUID();
    await insertOutboxRow({ tenantId, branchId: null, eventType: 'tenant.global.event' });
    await allocateTenantSeq(db, tenantId);
    await publishNextForTenant(db, tenantId, redis);

    const entries = await streamEntries(tenantId);
    expect(entries[0]).toHaveProperty('branch_id', null);
  });

  it('a payload field shaped like routing metadata never overrides the real branch_id/tenant_id (the publisher never derives routing/authorization from untrusted payload)', async () => {
    const tenantId = randomUUID();
    const realBranchId = randomUUID();
    const spoofedTenantId = randomUUID();
    const spoofedBranchId = randomUUID();
    const row = await insertOutboxRow({
      tenantId,
      branchId: realBranchId,
      eventType: 'spoof-attempt',
      // an attacker-influenced (or merely buggy) payload claiming a DIFFERENT
      // tenant/branch — must never leak into the envelope's routing fields.
      payload: {
        tenant_id: spoofedTenantId,
        tenantId: spoofedTenantId,
        branch_id: spoofedBranchId,
        branchId: spoofedBranchId,
      },
    });
    await allocateTenantSeq(db, tenantId);
    await publishNextForTenant(db, tenantId, redis);

    const entries = await streamEntries(tenantId);
    expect(entries[0]).toMatchObject({
      event_id: row.id,
      tenant_id: tenantId,
      branch_id: realBranchId,
    });
    const rawText = JSON.stringify(entries[0]);
    expect(rawText).not.toContain(spoofedTenantId);
    expect(rawText).not.toContain(spoofedBranchId);
  });

  // ── dispatcher orchestration end to end (tick loop) ──────────────────────
  it('OutboxDispatcher.start()/stop() drives a real row from insert to published Stream entry', async () => {
    const tenantId = randomUUID();
    const dispatcher = new OutboxDispatcher({
      db: freshDb(),
      redis,
      logger: log,
      tickIntervalMs: 50,
    });
    dispatcher.start();
    try {
      const row = await insertOutboxRow({ tenantId, eventType: 'via-loop' });
      const entries = await waitFor(async () => {
        const e = await streamEntries(tenantId);
        return e.length > 0 ? e : undefined;
      });
      expect(entries[0]).toMatchObject({ event_id: row.id, type: 'via-loop' });
    } finally {
      await dispatcher.stop();
    }
  });
});
