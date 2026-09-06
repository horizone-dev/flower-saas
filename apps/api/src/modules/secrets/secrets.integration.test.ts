import 'reflect-metadata';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { ALL_PERMISSIONS, PLATFORM_PERMISSIONS } from '@flower/permissions';
import pino from 'pino';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { REDACT_PATHS } from '../../common/logger/logger.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import { assertEveryRouteDeclaresIntent } from '../../common/auth/route-coverage.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { CRYPTO_PROVIDER, type CryptoProvider } from './crypto-provider.js';

const PLAN_V = '00000000-0000-7000-8000-0000001a0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000001a0002';
const SECRET = 'sk_live_9f8e7d6c5b4a32100000';

describe('secrets: provider-credential vault shell (integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantId: string;
  let ownerUserId: string;

  let superToken: string; // platform, platform:secrets:manage
  let weakPlatformToken: string; // platform, but WITHOUT platform:secrets:manage
  let tenantToken: string; // a tenant OWNER token

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
    jwt = app.get(JwtService);
    store = app.get(SessionStore);

    const prov = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      payload: {
        slug: 'sectest',
        name: 'SecTest FZE',
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'CUSTOM',
        planVersionId: PLAN_V,
        ownerEmail: 'owner@sectest.test',
      },
      headers: {
        authorization: `Bearer ${await mintPlatform('sec-super', [...PLATFORM_PERMISSIONS])}`,
      },
    });
    expect(prov.statusCode).toBe(201);
    ({ tenantId, ownerUserId } = prov.json());

    superToken = await mintPlatform('sec-super', [...PLATFORM_PERMISSIONS]);
    weakPlatformToken = await mintPlatform(
      'sec-weak',
      PLATFORM_PERMISSIONS.filter((k) => k !== 'platform:secrets:manage'),
    );
    tenantToken = await mintTenant('sec-tenant', ownerUserId, ['settings:tenant:manage']);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  async function mintPlatform(sessionId: string, permissions: string[]): Promise<string> {
    const s = baseSession(sessionId, 'platform');
    s.platformUserId = PLATFORM_USER;
    s.accountType = 'PLATFORM';
    s.mfaLevel = 'STEP_UP';
    s.stepUpUntil = Date.now() + 600_000;
    s.access = {
      effectivePermissions: permissions,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: PLATFORM_USER, sid: s.sessionId, aud: 'platform' });
  }

  async function mintTenant(
    sessionId: string,
    userId: string,
    permissions: string[],
  ): Promise<string> {
    const s = baseSession(sessionId, 'tenant');
    s.tenantId = tenantId;
    s.userId = userId;
    s.accountType = 'OWNER';
    s.mfaLevel = 'STEP_UP';
    s.stepUpUntil = Date.now() + 600_000;
    s.access = {
      effectivePermissions: permissions,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: userId, sid: s.sessionId, aud: 'tenant', tid: tenantId });
  }

  function baseSession(sessionId: string, realm: 'tenant' | 'platform'): SessionData {
    return {
      sessionId,
      realm,
      familyId: 'f',
      tenantId: null,
      userId: null,
      platformUserId: null,
      accountType: 'USER',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'NONE',
      stepUpUntil: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: null,
    };
  }

  const base = () => `/v1/platform/tenants/${tenantId}/provider-credentials`;
  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    token: string,
    body?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    });

  // ── tests ────────────────────────────────────────────────────────────────
  it('every secrets route declares a permission or @Public (G8)', () => {
    expect(() => assertEveryRouteDeclaresIntent(app)).not.toThrow();
  });

  it('there is no tenant-realm permission key matching /secret/i (rule 26)', () => {
    expect(ALL_PERMISSIONS.filter((k) => /secret/i.test(k))).toEqual([]);
  });

  it('a tenant-realm token cannot reach any secrets route', async () => {
    const res = await req('GET', base(), tenantToken);
    expect([401, 403]).toContain(res.statusCode);
  });

  it('a platform token without platform:secrets:manage is 403', async () => {
    const res = await req('GET', base(), weakPlatformToken);
    expect(res.statusCode).toBe(403);
  });

  let credentialId: string;

  it('creates a credential and returns only the masked view (no plaintext)', async () => {
    const res = await req('POST', base(), superToken, {
      provider: 'stripe',
      mode: 'LIVE',
      secret: SECRET,
      nonSecretConfig: { publishableKey: 'pk_live_visible' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    credentialId = body.id;
    expect(body.secretMask).toBe('••••0000');
    expect(body.nonSecretConfig).toEqual({ publishableKey: 'pk_live_visible' });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('reads back the masked view — still no plaintext', async () => {
    const res = await req('GET', `${base()}/${credentialId}`, superToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().secretMask).toBe('••••0000');
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
  });

  it('the cipher blobs round-trip and are tenant-bound (AAD)', async () => {
    const crypto = app.get<CryptoProvider>(CRYPTO_PROVIDER);
    const sealed = await crypto.encrypt(SECRET, { tenantId });
    expect(await crypto.decrypt(sealed, { tenantId })).toBe(SECRET);
    await expect(
      crypto.decrypt(sealed, { tenantId: '00000000-0000-7000-8000-0000001a0bad' }),
    ).rejects.toThrow();
  });

  it('rotation bumps the version; revoke flips the status', async () => {
    const rot = await req('PUT', `${base()}/${credentialId}`, superToken, {
      secret: 'sk_live_rotated_000000',
    });
    expect(rot.statusCode).toBe(200);
    expect(rot.json().version).toBe(2);

    const del = await req('DELETE', `${base()}/${credentialId}`, superToken);
    expect(del.statusCode).toBe(200);
    expect((await req('GET', `${base()}/${credentialId}`, superToken)).json().status).toBe(
      'REVOKED',
    );
  });

  it('the plaintext never survives a log line (redaction paths)', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: [...REDACT_PATHS], censor: '[redacted]' } }, sink);
    log.info(
      {
        vault: { plaintext: SECRET, secretNonce: 'n' },
        body: { secret: SECRET, token: SECRET },
        creds: { password: SECRET },
      },
      'storing credential',
    );
    const out = lines.join('');
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[redacted]');
  });

  it('every mutation wrote a platform-actor audit row', async () => {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const rows = await c
        .query(
          `SELECT action, "actorAccountType" FROM audit_log
            WHERE "tenantId"=$1 AND action LIKE 'provider_credential.%'`,
          [tenantId],
        )
        .then((r) => r.rows);
      expect(new Set(rows.map((x) => x.action))).toEqual(
        new Set([
          'provider_credential.created',
          'provider_credential.rotated',
          'provider_credential.revoked',
        ]),
      );
      expect(rows.every((x) => x.actorAccountType === 'PLATFORM')).toBe(true);
    } finally {
      await c.end();
    }
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000001a0000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000001a0000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 3), ('${PLAN_V}', 'max_sessions_per_user', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED-ar');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt") VALUES ('AE', 'United Arab Emirates', 'UAE-ar', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt") VALUES ('CUSTOM', 1, 'Custom', 'مخصص', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey", "capabilityKey", enabled, "updatedAt") VALUES ('CUSTOM','strategy.stocked',true,now()),('CUSTOM','branch_pricing',true,now()),('CUSTOM','channel.pos',true,now());
    `);
  } finally {
    await c.end();
  }
}
