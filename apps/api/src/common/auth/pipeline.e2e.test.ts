import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../../config/config.module.js';
import { DbModule } from '../db/db.module.js';
import { installRequestContext } from '../context/index.js';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter.js';
import { Public } from './public.decorator.js';
import { RequirePermission } from './require-permission.decorator.js';
import { PlatformRealm, ScopedParam } from './pipeline.decorators.js';
import { PipelineModule } from './pipeline.module.js';
import { JwtService } from './jwt.service.js';
import { SessionStore, InMemorySessionStore } from './session-store.js';
import { assertEveryRouteDeclaresIntent, RouteCoverageError } from './route-coverage.js';
import type { SessionData } from './session.types.js';

// ── a test controller exercising each decorator ──────────────────────────────
@Controller('t')
class TestController {
  @Get('open')
  @Public()
  open() {
    return { ok: true };
  }

  @Get('view')
  @RequirePermission('users:view')
  view() {
    return { ok: 'view' };
  }

  @Get('manage')
  @RequirePermission('users:manage') // step-up required
  manage() {
    return { ok: 'manage' };
  }

  @Get('module-gated')
  @RequirePermission('recipe:manage') // needs the production_bom module
  moduleGated() {
    return { ok: 'recipe' };
  }

  @Get('branch/:branchId')
  @RequirePermission('users:view')
  @ScopedParam({ branch: 'branchId' })
  branch() {
    return { ok: 'branch' };
  }
}

@Controller('platform/t')
@PlatformRealm()
class PlatformTestController {
  @Get('tenants')
  @RequirePermission('platform:tenants:view')
  list() {
    return { ok: 'platform' };
  }
}

@Module({ controllers: [TestController, PlatformTestController] })
class TestFeatureModule {}

@Module({ imports: [ConfigModule, DbModule, PipelineModule, TestFeatureModule] })
class TestAppModule {}

// ── helpers ─────────────────────────────────────────────────────────────────
const T = '11111111-1111-7111-8111-111111111111';

function session(over: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 's1',
    realm: 'tenant',
    tenantId: T,
    userId: '22222222-2222-7222-8222-222222222222',
    platformUserId: null,
    accountType: 'USER',
    posTerminalId: null,
    deviceId: null,
    mfaLevel: 'MFA',
    stepUpUntil: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    revokedAt: null,
    revokeReason: null,
    impersonatorPlatformUserId: null,
    access: {
      effectivePermissions: ['users:view'],
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: 'starter',
    },
    ...over,
  };
}

describe('guard pipeline (e2e via Fastify inject)', () => {
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: InMemorySessionStore;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    installRequestContext(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwt = app.get(JwtService);
    store = app.get(SessionStore) as InMemorySessionStore;
  });

  afterAll(async () => {
    await app?.close();
  });

  const inject = (path: string, token?: string) =>
    app.inject({
      method: 'GET',
      url: `/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function tokenFor(s: SessionData): Promise<string> {
    await store.set(s);
    return jwt.sign(
      s.realm === 'platform'
        ? { sub: s.platformUserId!, sid: s.sessionId, aud: 'platform' }
        : { sub: s.userId!, sid: s.sessionId, aud: 'tenant', tid: s.tenantId! },
    );
  }

  it('@Public route needs no token', async () => {
    expect((await inject('/t/open')).statusCode).toBe(200);
  });

  it('protected route without a token → 401', async () => {
    expect((await inject('/t/view')).statusCode).toBe(401);
  });

  it('valid session + held permission → 200', async () => {
    const res = await inject('/t/view', await tokenFor(session()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: 'view' });
  });

  it('missing permission → 403 FORBIDDEN', async () => {
    const res = await inject('/t/manage', await tokenFor(session()));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MISSING_PERMISSION');
  });

  it('has the key but no step-up → 403 STEP_UP_REQUIRED', async () => {
    const s = session({
      access: { ...session().access!, effectivePermissions: ['users:manage'] },
    });
    const res = await inject('/t/manage', await tokenFor(s));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('step-up active → 200', async () => {
    const s = session({
      mfaLevel: 'STEP_UP',
      stepUpUntil: Date.now() + 60_000,
      access: { ...session().access!, effectivePermissions: ['users:manage'] },
    });
    expect((await inject('/t/manage', await tokenFor(s))).statusCode).toBe(200);
  });

  it('module not entitled → 403 MODULE_NOT_ENTITLED', async () => {
    const s = session({
      access: {
        ...session().access!,
        effectivePermissions: ['recipe:manage'],
        entitledModules: [],
      },
    });
    const res = await inject('/t/module-gated', await tokenFor(s));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODULE_NOT_ENTITLED');
  });

  it('module entitled → 200', async () => {
    const s = session({
      access: {
        ...session().access!,
        effectivePermissions: ['recipe:manage'],
        entitledModules: ['production_bom'],
      },
    });
    expect((await inject('/t/module-gated', await tokenFor(s))).statusCode).toBe(200);
  });

  it('branch out of scope → 404 (no existence leak)', async () => {
    const s = session({
      access: { ...session().access!, branchScope: ['branch-a'] },
    });
    const res = await inject('/t/branch/branch-b', await tokenFor(s));
    expect(res.statusCode).toBe(404);
  });

  it('branch in scope → 200', async () => {
    const s = session({ access: { ...session().access!, branchScope: ['branch-a'] } });
    expect((await inject('/t/branch/branch-a', await tokenFor(s))).statusCode).toBe(200);
  });

  it('revoked session → 401', async () => {
    const s = session({ sessionId: 'revoked' });
    const token = await tokenFor(s);
    await store.revoke('revoked', 'test');
    expect((await inject('/t/view', token)).statusCode).toBe(401);
  });

  it('realm separation: a tenant token on a platform route → 401', async () => {
    const tenantToken = await tokenFor(session());
    expect((await inject('/platform/t/tenants', tenantToken)).statusCode).toBe(401);
  });

  it('realm separation: a platform token on a tenant route → 401', async () => {
    const s = session({
      sessionId: 'p1',
      realm: 'platform',
      tenantId: null,
      userId: null,
      platformUserId: '33333333-3333-7333-8333-333333333333',
      accountType: 'PLATFORM',
      access: null,
    });
    const platformToken = await tokenFor(s);
    expect((await inject('/t/view', platformToken)).statusCode).toBe(401);
  });

  it('platform token with the platform permission → 200', async () => {
    const s = session({
      sessionId: 'p2',
      realm: 'platform',
      tenantId: null,
      userId: null,
      platformUserId: '33333333-3333-7333-8333-333333333333',
      accountType: 'PLATFORM',
      mfaLevel: 'STEP_UP',
      stepUpUntil: Date.now() + 60_000,
      access: {
        effectivePermissions: ['platform:tenants:view'],
        companyScope: 'ALL',
        branchScope: 'ALL',
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    });
    const res = await inject('/platform/t/tenants', await tokenFor(s));
    expect(res.statusCode).toBe(200);
  });

  it('route-coverage assertion passes for the test app', () => {
    expect(() => assertEveryRouteDeclaresIntent(app)).not.toThrow();
  });
});

// ── the bootstrap assertion catches an undecorated route ─────────────────────
describe('route-coverage assertion', () => {
  it('throws when a route declares neither @RequirePermission nor @Public', async () => {
    @Controller('bad')
    class BadController {
      // deliberately missing @RequirePermission / @Public — the bootstrap
      // assertion must catch what the lint rule would also catch at dev time
      // eslint-disable-next-line flower/route-must-declare-permission
      @Get('leak')
      leak() {
        return { oops: true };
      }
    }
    @Module({ imports: [ConfigModule, DbModule, PipelineModule], controllers: [BadController] })
    class BadModule {}

    const moduleRef = await Test.createTestingModule({ imports: [BadModule] }).compile();
    const bad = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await bad.init();
    expect(() => assertEveryRouteDeclaresIntent(bad)).toThrow(RouteCoverageError);
    await bad.close();
  });
});
