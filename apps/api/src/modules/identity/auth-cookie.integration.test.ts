import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';

/**
 * Post-Phase-1 auth hardening. The refresh token has two transports:
 *   - response body (default) — server-side clients (owner-web / super-admin-web)
 *     store it in their own HttpOnly cookie;
 *   - `Secure; HttpOnly` cookie set by the API, withheld from the body — browser
 *     clients (the POS PWA) opt in with `X-Auth-Transport: cookie` and never hold
 *     a refresh credential in JS-readable storage.
 * A cookie-authenticated refresh/logout requires the same custom header (a
 * cross-site page cannot set it on a credentialed request) — that is the CSRF
 * defence for the cookie flow.
 */
const PASSWORD = 'CorrectHorseBatteryStaple9';
const SLUG = 'cookieco';
const COOKIE = 'flower_refresh';

describe('auth: HttpOnly refresh-cookie transport (integration — Postgres + Redis)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    await seed(stack.postgres.url);

    process.env['DATABASE_URL'] = stack.postgres.url;
    process.env['PLATFORM_DATABASE_URL'] = stack.postgres.url;
    process.env['REDIS_URL'] = stack.redis.url;
    process.env['AUTH_JWT_SECRET'] = 'integration-test-jwt-secret-0000000000';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    installRequestContext(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  const login = (headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { workspaceSlug: SLUG, email: 'owner@cookieco.test', password: PASSWORD },
      headers,
    });

  const setCookieHeader = (res: { headers: Record<string, unknown> }): string =>
    ([] as string[])
      .concat((res.headers['set-cookie'] as string | string[] | undefined) ?? [])
      .join('\n');

  const cookieValue = (res: { headers: Record<string, unknown> }): string => {
    const header = setCookieHeader(res);
    const value = new RegExp(`${COOKIE}=([^;\\s]+)`).exec(header)?.[1];
    if (!value) throw new Error(`no ${COOKIE} cookie in: ${header || '(none)'}`);
    return value;
  };

  // ── A. transport selection ───────────────────────────────────────────────
  it('cookie transport: login withholds the refresh token and sets an HttpOnly cookie', async () => {
    const res = await login({ 'x-auth-transport': 'cookie' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.accessToken).toBe('string');
    expect(body.refreshToken).toBeUndefined();

    const cookie = setCookieHeader(res);
    expect(cookie).toMatch(new RegExp(`${COOKIE}=[^;\\s]+`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/i);
  });

  it('body transport (default): login returns the refresh token and sets no cookie', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().refreshToken).toBe('string');
    expect(setCookieHeader(res)).not.toMatch(new RegExp(COOKIE));
  });

  // ── B. cookie refresh ────────────────────────────────────────────────────
  it('refresh over the cookie rotates it and returns only an access token', async () => {
    const first = cookieValue(await login({ 'x-auth-transport': 'cookie' }));

    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-auth-transport': 'cookie', cookie: `${COOKIE}=${first}` },
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().accessToken).toBe('string');
    expect(r.json().refreshToken).toBeUndefined();
    expect(cookieValue(r)).not.toBe(first);
  });

  // ── C. CSRF defence ──────────────────────────────────────────────────────
  it('a cookie refresh WITHOUT the transport header is blocked (CSRF_BLOCKED)', async () => {
    const cookie = cookieValue(await login({ 'x-auth-transport': 'cookie' }));

    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `${COOKIE}=${cookie}` },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_BLOCKED');
  });

  it('an explicit body refreshToken still works without the header (server-side clients)', async () => {
    const body = (await login()).json();
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: body.refreshToken },
    });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().refreshToken).toBe('string'); // body transport keeps body
  });

  // ── D. rotation / reuse detection over the cookie ────────────────────────
  it('replaying a rotated cookie revokes the whole family', async () => {
    const c1 = cookieValue(await login({ 'x-auth-transport': 'cookie' }));

    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-auth-transport': 'cookie', cookie: `${COOKIE}=${c1}` },
      payload: {},
    });
    const c2 = cookieValue(r);

    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-auth-transport': 'cookie', cookie: `${COOKIE}=${c1}` },
      payload: {},
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('REFRESH_REUSED');

    // the token issued after the replayed one is now dead too
    const dead = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-auth-transport': 'cookie', cookie: `${COOKIE}=${c2}` },
      payload: {},
    });
    expect(dead.statusCode).toBe(401);
  });

  // ── E. logout invalidates every auth artifact ───────────────────────────
  it('logout clears the cookie (Max-Age=0) and revokes the session', async () => {
    const loginRes = await login({ 'x-auth-transport': 'cookie' });
    const access = loginRes.json().accessToken as string;
    const cookie = cookieValue(loginRes);

    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${access}`, 'x-auth-transport': 'cookie' },
    });
    expect(out.statusCode).toBe(200);
    expect(setCookieHeader(out)).toMatch(new RegExp(`${COOKIE}=;?\\s*Max-Age=0`, 'i'));

    // access token dead
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(401);

    // the refresh cookie no longer continues the session
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-auth-transport': 'cookie', cookie: `${COOKIE}=${cookie}` },
      payload: {},
    });
    expect(refresh.statusCode).toBe(401);
  });
});

const TENANT_ID = '00000000-0000-7000-8000-0000000cc001';
const ROLE_ID = '00000000-0000-7000-8000-0000000cc002';

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const pw = await hash(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000000cc0a1', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000000cc0a2', '00000000-0000-7000-8000-0000000cc0a1', 1, 'PUBLISHED', now());
      INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
      VALUES ('${TENANT_ID}', '${SLUG}', 'CookieCo', 'AE', 'ACTIVE',
              '00000000-0000-7000-8000-0000000cc0a2', now());
      INSERT INTO role (id, "tenantId", key, name, "isSystem", "updatedAt")
      VALUES ('${ROLE_ID}', '${TENANT_ID}', 'owner', 'Owner', true, now());
    `);
    for (const perm of ['users:view', 'users:manage']) {
      await c.query(
        `INSERT INTO role_permission ("tenantId", "roleId", "permissionKey") VALUES ($1, $2, $3)`,
        [TENANT_ID, ROLE_ID, perm],
      );
    }
    const USER_ID = '00000000-0000-7000-8000-0000000cc003';
    await c.query(
      `INSERT INTO "user" (id, "tenantId", "accountType", email, status, "updatedAt")
       VALUES ($1, $2, 'OWNER', 'owner@cookieco.test', 'ACTIVE', now())`,
      [USER_ID, TENANT_ID],
    );
    await c.query(
      `INSERT INTO credential ("tenantId", "userId", kind, hash, "updatedAt")
       VALUES ($1, $2, 'PASSWORD', $3, now())`,
      [TENANT_ID, USER_ID, pw],
    );
    await c.query(`INSERT INTO user_role ("tenantId", "userId", "roleId") VALUES ($1, $2, $3)`, [
      TENANT_ID,
      USER_ID,
      ROLE_ID,
    ]);
  } finally {
    await c.end();
  }
}
