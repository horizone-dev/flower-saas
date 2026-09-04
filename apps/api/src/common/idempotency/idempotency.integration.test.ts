import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { runScoped } from '@flower/db';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter.js';
import { DomainError } from '../errors/domain-error.js';
import { installRequestContext, requireContext } from '../context/index.js';
import { DbService } from '../db/db.module.js';
import { RequirePermission } from '../auth/require-permission.decorator.js';
import { assertNoIdempotencyOnCredentialRoutes } from './assert-no-idempotency-on-credentials.js';
import { Idempotent } from './idempotent.decorator.js';

/**
 * Idempotency store (task 2.2) — full request path against Postgres. A test-only
 * controller with one `@Idempotent` route drives every branch: replay,
 * hash-mismatch, concurrency (exactly-once), stale-PENDING recovery, transient
 * 5xx not cached, snapshot scrub + size limit, tenant + principal isolation,
 * expiry.
 */

const PASSWORD = 'CorrectHorseBatteryStaple9';
const T1 = '00000000-0000-7000-8000-0000000ee001';
const T2 = '00000000-0000-7000-8000-0000000ee002';

// ── test-only route ──────────────────────────────────────────────────────────
interface RunDto {
  marker: string;
  mode?: 'ok' | 'boom' | 'reject' | 'slow' | 'big';
}

@Controller('_idem')
class IdemTestController {
  constructor(private readonly db: DbService) {}

  @Post('run')
  @RequirePermission('users:view')
  @Idempotent({ scope: 'idem.test.run' })
  async run(@Body() dto: RunDto) {
    const ctx = requireContext();
    const mode = dto.mode ?? 'ok';
    if (mode === 'boom') throw new DomainError('BOOM', 'transient failure', 500);
    if (mode === 'reject') throw new DomainError('REJECTED', 'business rejection', 422);
    if (mode === 'slow') await sleep(300);

    // a real tenant-scoped mutation — one row per handler execution
    await runScoped(this.db.appClient(), { tenantId: ctx.tenantId! }, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "translation" ("id","tenantId","entityType","entityId","field","locale","value","updatedAt")
         VALUES (uuidv7(), $1::uuid, 'idem-test', uuidv7(), 'n', 'en', $2, now())`,
        ctx.tenantId,
        dto.marker,
      ),
    );

    return {
      ok: true,
      marker: dto.marker,
      principal: ctx.userId,
      nonce: randomUUID(),
      secretToken: 'sk_live_SHOULD_BE_REDACTED',
      nested: { password: 'hunter2', label: 'keep-me' },
      ...(mode === 'big' ? { blob: 'x'.repeat(200_000) } : {}),
    };
  }
}

@Module({ imports: [AppModule], controllers: [IdemTestController] })
class IdemTestModule {}

// ── suite ────────────────────────────────────────────────────────────────────
describe('idempotency store (integration — Postgres)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let pool: pg.Pool;
  let tokenA1: string; // tenant 1, user 1
  let tokenA2: string; // tenant 1, user 2
  let tokenB1: string; // tenant 2, user 1
  let userA1Id: string;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    await seed(stack.postgres.url);

    process.env['DATABASE_URL'] = stack.postgres.url;
    process.env['PLATFORM_DATABASE_URL'] = stack.postgres.url;
    process.env['REDIS_URL'] = stack.redis.url;
    process.env['AUTH_JWT_SECRET'] = 'integration-test-jwt-secret-0000000000';
    process.env['IDEMPOTENCY_STALE_LOCK_SECONDS'] = '2';

    const moduleRef = await Test.createTestingModule({ imports: [IdemTestModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    installRequestContext(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    pool = new pg.Pool({ connectionString: stack.postgres.url });

    tokenA1 = await login('t1', 'owner@t1.test');
    tokenA2 = await login('t1', 'owner2@t1.test');
    tokenB1 = await login('t2', 'owner@t2.test');

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tokenA1}` },
    });
    userA1Id = meRes.json().userId as string;
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await app?.close();
    await stack?.stop();
    for (const k of [
      'DATABASE_URL',
      'PLATFORM_DATABASE_URL',
      'REDIS_URL',
      'AUTH_JWT_SECRET',
      'IDEMPOTENCY_STALE_LOCK_SECONDS',
    ]) {
      delete process.env[k];
    }
  });

  async function login(slug: string, email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { workspaceSlug: slug, email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  }

  const run = (token: string, key: string | undefined, body: RunDto) =>
    app.inject({
      method: 'POST',
      url: '/v1/_idem/run',
      headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
      payload: body,
    });

  const markerCount = async (marker: string, tenantId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "translation" WHERE "entityType" = 'idem-test' AND value = $1 AND "tenantId" = $2`,
      [marker, tenantId],
    );
    return Number(rows[0]!.n);
  };

  // ── tests ──────────────────────────────────────────────────────────────────
  it('a missing / malformed Idempotency-Key is rejected', async () => {
    expect((await run(tokenA1, undefined, { marker: 'm' })).statusCode).toBe(400);
    expect((await run(tokenA1, 'short', { marker: 'm' })).statusCode).toBe(400);
  });

  it('replays a stored 2xx result and does not re-execute the handler', async () => {
    const m = `replay-${randomUUID()}`;
    const first = await run(tokenA1, 'replay-key-1', { marker: m });
    expect(first.statusCode).toBe(201);
    const nonce = first.json().nonce;

    const second = await run(tokenA1, 'replay-key-1', { marker: m });
    expect(second.statusCode).toBe(201);
    expect(second.json().nonce).toBe(nonce); // identical body, not a re-execution
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(await markerCount(m, T1)).toBe(1);
  });

  it('same key + a semantically-equal body still replays (canonical hashing)', async () => {
    const m = `canon-${randomUUID()}`;
    const a = await run(tokenA1, 'canon-key-1', { marker: m, mode: 'ok' });
    const b = await app.inject({
      method: 'POST',
      url: '/v1/_idem/run',
      headers: { authorization: `Bearer ${tokenA1}`, 'idempotency-key': 'canon-key-1' },
      // keys reordered, same meaning
      payload: { mode: 'ok', marker: m },
    });
    expect(b.statusCode).toBe(201);
    expect(b.json().nonce).toBe(a.json().nonce);
    expect(await markerCount(m, T1)).toBe(1);
  });

  it('same key + a different request hash is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    await run(tokenA1, 'reuse-key-1', { marker: 'reuse-a' });
    const clash = await run(tokenA1, 'reuse-key-1', { marker: 'reuse-b' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('N concurrent identical requests execute the handler exactly once', async () => {
    const m = `conc-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run(tokenA1, 'conc-key-1', { marker: m, mode: 'slow' })),
    );
    const ok = results.filter((r) => r.statusCode === 201);
    const inProgress = results.filter(
      (r) => r.statusCode === 409 && r.json().error.code === 'IDEMPOTENCY_IN_PROGRESS',
    );
    expect(ok).toHaveLength(1);
    expect(inProgress.length).toBe(7);
    expect(await markerCount(m, T1)).toBe(1);

    // a later retry replays the winner's result
    const late = await run(tokenA1, 'conc-key-1', { marker: m, mode: 'slow' });
    expect(late.statusCode).toBe(201);
    expect(late.json().nonce).toBe(ok[0]!.json().nonce);
    expect(await markerCount(m, T1)).toBe(1);
  });

  it('a transient 5xx is not cached — the row is dropped and a retry re-executes', async () => {
    const first = await run(tokenA1, 'boom-key-1', { marker: 'boom-m', mode: 'boom' });
    expect(first.statusCode).toBe(500);
    const { rows } = await pool.query(`SELECT 1 FROM "idempotency_key" WHERE key = 'boom-key-1'`);
    expect(rows.length).toBe(0);
    const second = await run(tokenA1, 'boom-key-1', { marker: 'boom-m', mode: 'boom' });
    expect(second.statusCode).toBe(500); // re-executed, not a cached 500
  });

  it('a 4xx business rejection is not cached', async () => {
    expect((await run(tokenA1, 'rej-key-1', { marker: 'rej', mode: 'reject' })).statusCode).toBe(
      422,
    );
    const { rows } = await pool.query(`SELECT 1 FROM "idempotency_key" WHERE key = 'rej-key-1'`);
    expect(rows.length).toBe(0);
    expect((await run(tokenA1, 'rej-key-1', { marker: 'rej', mode: 'reject' })).statusCode).toBe(
      422,
    );
  });

  it('stale PENDING is reclaimable and cannot be reclaimed by two owners at once', async () => {
    const m = `stale-${randomUUID()}`;
    const key = `stale-key-${randomUUID()}`;
    // plant a PENDING row locked > STALE_LOCK_SECONDS ago, with the hash this
    // request would compute
    const h = await hashForRun(m, userA1Id);
    await pool.query(
      `INSERT INTO "idempotency_key"
         ("tenantId","scope","principalId","key","requestHash","status","lockedAt","createdAt","expiresAt")
       VALUES ($1::uuid,'idem.test.run',$2::uuid,$3,$4,'PENDING', now() - interval '1 hour', now(), now() + interval '1 hour')`,
      [T1, userA1Id, key, h],
    );

    const [a, b] = await Promise.all([
      run(tokenA1, key, { marker: m }),
      run(tokenA1, key, { marker: m }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]); // exactly one reclaimer executes
    expect(await markerCount(m, T1)).toBe(1);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM "idempotency_key" WHERE key = $1`,
      [key],
    );
    expect(rows[0]!.status).toBe('DONE');
  });

  it('an expired stored result does not block a fresh retry', async () => {
    const m = `exp-${randomUUID()}`;
    const key = `exp-key-${randomUUID()}`;
    const h = await hashForRun(m, userA1Id);
    await pool.query(
      `INSERT INTO "idempotency_key"
         ("tenantId","scope","principalId","key","requestHash","status","httpStatus","responseSnapshot","lockedAt","createdAt","expiresAt")
       VALUES ($1::uuid,'idem.test.run',$2::uuid,$3,$4,'DONE',201,'{"stale":true}'::jsonb, now() - interval '2 hour', now() - interval '2 hour', now() - interval '1 hour')`,
      [T1, userA1Id, key, h],
    );
    const res = await run(tokenA1, key, { marker: m });
    expect(res.statusCode).toBe(201);
    expect(res.json().stale).toBeUndefined(); // fresh execution, not the expired snapshot
    expect(res.json().marker).toBe(m);
    expect(await markerCount(m, T1)).toBe(1);
  });

  it('the stored snapshot scrubs secrets and keeps safe fields', async () => {
    const m = `scrub-${randomUUID()}`;
    await run(tokenA1, 'scrub-key-1', { marker: m });
    const { rows } = await pool.query<{ responseSnapshot: Record<string, unknown> }>(
      `SELECT "responseSnapshot" FROM "idempotency_key" WHERE key = 'scrub-key-1'`,
    );
    const body = rows[0]!.responseSnapshot as {
      secretToken: string;
      nested: { password: string; label: string };
      marker: string;
    };
    expect(body.secretToken).toBe('[redacted]');
    expect(body.nested.password).toBe('[redacted]');
    expect(body.nested.label).toBe('keep-me');
    expect(body.marker).toBe(m);
  });

  it('an oversized 2xx body is not cached but the mutation is still protected', async () => {
    const m = `big-${randomUUID()}`;
    const first = await run(tokenA1, 'big-key-1', { marker: m, mode: 'big' });
    expect(first.statusCode).toBe(201);
    expect((first.json().blob as string).length).toBe(200_000);

    const { rows } = await pool.query<{ responseSnapshot: unknown; status: string }>(
      `SELECT "responseSnapshot", status FROM "idempotency_key" WHERE key = 'big-key-1'`,
    );
    expect(rows[0]!.responseSnapshot).toBeNull();
    expect(rows[0]!.status).toBe('DONE');

    const second = await run(tokenA1, 'big-key-1', { marker: m, mode: 'big' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_REPLAY_UNAVAILABLE');
    expect(await markerCount(m, T1)).toBe(1); // not re-executed
  });

  it("tenant A's key never affects tenant B", async () => {
    const m = `tiso-${randomUUID()}`;
    const a = await run(tokenA1, 'tenant-iso-key', { marker: m });
    expect(a.statusCode).toBe(201);
    const b = await run(tokenB1, 'tenant-iso-key', { marker: m });
    expect(b.statusCode).toBe(201); // fresh — B never sees A's key (RLS)
    expect(b.json().nonce).not.toBe(a.json().nonce);
    expect(await markerCount(m, T1)).toBe(1);
    expect(await markerCount(m, T2)).toBe(1);
  });

  it("user A's stored response never replays to user B", async () => {
    const m = `piso-${randomUUID()}`;
    const a = await run(tokenA1, 'principal-iso-key', { marker: m });
    expect(a.json().principal).toBeTruthy();
    const b = await run(tokenA2, 'principal-iso-key', { marker: m });
    expect(b.statusCode).toBe(201);
    expect(b.json().principal).not.toBe(a.json().principal); // B executed fresh, got its own identity
    expect(b.json().nonce).not.toBe(a.json().nonce);
    expect(await markerCount(m, T1)).toBe(2); // one per principal
  });

  it('an undecorated route ignores the Idempotency-Key header', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tokenA1}`, 'idempotency-key': 'ignored-on-get' },
    });
    expect(me.statusCode).toBe(200);
  });

  it('the credential-route startup guard passes for the real app', () => {
    expect(() => assertNoIdempotencyOnCredentialRoutes(app)).not.toThrow();
  });

  // recomputes the interceptor's request hash for a planted row
  async function hashForRun(marker: string, principalId: string): Promise<string> {
    const { requestHash } = await import('./canonical-hash.js');
    return requestHash({
      method: 'POST',
      routePattern: '/v1/_idem/run',
      pathParams: {},
      query: {},
      scope: 'idem.test.run',
      tenantId: T1,
      principalId,
      body: { marker },
    });
  }
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const pw = await hash(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  try {
    await c.query(`
      INSERT INTO locale (code, "nameEn", "nameAr", direction) VALUES ('en','English','الإنجليزية','ltr');
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000000ee0a1', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000000ee0a2', '00000000-0000-7000-8000-0000000ee0a1', 1, 'PUBLISHED', now());
    `);
    for (const [tid, slug] of [
      [T1, 't1'],
      [T2, 't2'],
    ] as const) {
      const roleId = randomUUID();
      await c.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1,$2,$2,'AE','ACTIVE','00000000-0000-7000-8000-0000000ee0a2', now())`,
        [tid, slug],
      );
      await c.query(
        `INSERT INTO role (id, "tenantId", key, name, "isSystem", "updatedAt")
         VALUES ($1,$2,'owner','Owner',true, now())`,
        [roleId, tid],
      );
      await c.query(
        `INSERT INTO role_permission ("tenantId","roleId","permissionKey") VALUES ($1,$2,'users:view')`,
        [tid, roleId],
      );
      const emails = tid === T1 ? [`owner@t1.test`, `owner2@t1.test`] : [`owner@t2.test`];
      for (const email of emails) {
        const uid = randomUUID();
        await c.query(
          `INSERT INTO "user" (id,"tenantId","accountType",email,status,"updatedAt")
           VALUES ($1,$2,'OWNER',$3,'ACTIVE', now())`,
          [uid, tid, email],
        );
        await c.query(
          `INSERT INTO credential ("tenantId","userId",kind,hash,"updatedAt")
           VALUES ($1,$2,'PASSWORD',$3, now())`,
          [tid, uid, pw],
        );
        await c.query(`INSERT INTO user_role ("tenantId","userId","roleId") VALUES ($1,$2,$3)`, [
          tid,
          uid,
          roleId,
        ]);
      }
    }
  } finally {
    await c.end();
  }
}
