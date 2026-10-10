import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../../config/config.module.js';
import { DbModule } from '../db/db.module.js';
import { installRequestContext } from '../context/index.js';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter.js';
import {
  RequirePermission,
  RequireAllPermissions,
  RequireAllBranches,
} from './require-permission.decorator.js';
import { ScopedParam } from './pipeline.decorators.js';
import { PipelineModule } from './pipeline.module.js';
import { JwtService } from './jwt.service.js';
import { SessionStore, InMemorySessionStore } from './session-store.js';
import type { SessionData } from './session.types.js';

/**
 * Task 3b.10 Checkpoint F — the additive guard features, proven at the pipeline level (in-process, real guard, no database):
 * `@RequireAllPermissions` (every key must hold, on top of the primary key) and `@RequireAllBranches` (a company-wide route
 * needs unrestricted branch authority). Plain `@RequirePermission` behaves exactly as before.
 */
@Controller('t')
class TestController {
  @Get('plain')
  @RequirePermission('orders:view')
  plain() {
    return { ok: 'plain' };
  }

  @Get('all-of')
  @RequirePermission('orders:view')
  @RequireAllPermissions('credit_notes:view', 'receivables:view')
  allOf() {
    return { ok: 'all-of' };
  }

  @Get('company/:companyId/all-of')
  @RequirePermission('orders:view')
  @RequireAllPermissions('credit_notes:view', 'receivables:view')
  @RequireAllBranches()
  @ScopedParam({ company: 'companyId' })
  companyWide() {
    return { ok: 'company-wide' };
  }

  @Get('company/:companyId/branch/:branchId')
  @RequirePermission('orders:view')
  @RequireAllPermissions('credit_notes:view', 'receivables:view')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  branchLevel() {
    return { ok: 'branch' };
  }

  /** the all-branches rule WITHOUT a @ScopedParam: it must still be enforced (never silently skipped) */
  @Get('unscoped-wide')
  @RequirePermission('orders:view')
  @RequireAllBranches()
  unscopedWide() {
    return { ok: 'unscoped-wide' };
  }
}

@Module({ controllers: [TestController] })
class TestFeatureModule {}
@Module({ imports: [ConfigModule, DbModule, PipelineModule, TestFeatureModule] })
class TestAppModule {}

const T = '11111111-1111-7111-8111-111111111111';
const THREE = ['orders:view', 'credit_notes:view', 'receivables:view'];

function session(
  perms: string[],
  access: Partial<NonNullable<SessionData['access']>> = {},
  id = Math.random().toString(36).slice(2),
): SessionData {
  return {
    sessionId: `s-${id}`,
    realm: 'tenant',
    familyId: 'f1',
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
      effectivePermissions: perms,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: 'starter',
      ...access,
    },
  };
}

describe('multi-permission + all-branches guard features (e2e via Fastify inject)', () => {
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

  const call = async (path: string, s?: SessionData) => {
    if (s) await store.set(s);
    const token = s
      ? await jwt.sign({ sub: s.userId!, sid: s.sessionId, aud: 'tenant', tid: s.tenantId! })
      : undefined;
    return app.inject({
      method: 'GET',
      url: `/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  };

  it('@RequirePermission alone is unchanged: the single key decides', async () => {
    expect((await call('/t/plain', session(['orders:view']))).statusCode).toBe(200);
    expect((await call('/t/plain', session(['credit_notes:view']))).statusCode).toBe(403);
    expect((await call('/t/plain')).statusCode).toBe(401);
  });

  it('@RequireAllPermissions: all three keys → 200', async () => {
    const res = await call('/t/all-of', session(THREE));
    expect(res.statusCode).toBe(200);
  });

  it('@RequireAllPermissions: missing ANY one key (the primary or either extra) → 403 MISSING_PERMISSION', async () => {
    for (const missing of THREE) {
      const res = await call('/t/all-of', session(THREE.filter((k) => k !== missing)));
      expect(res.statusCode, `without ${missing}`).toBe(403);
      expect(res.json().error.code).toBe('MISSING_PERMISSION');
    }
    for (const only of THREE) {
      expect((await call('/t/all-of', session([only]))).statusCode, only).toBe(403);
    }
    expect((await call('/t/all-of', session([]))).statusCode).toBe(403);
  });

  it('@RequireAllPermissions never relaxes: an unrelated extra permission does not stand in for a required one', async () => {
    const res = await call(
      '/t/all-of',
      session([...THREE.slice(0, 2), 'users:view', 'payments:view']),
    );
    expect(res.statusCode).toBe(403);
  });

  it('@RequireAllPermissions: a per-branch overlay that withholds ANY of the keys denies that branch route', async () => {
    const overlay = { 'branch-a': ['orders:view', 'credit_notes:view'] }; // receivables:view withheld there
    const s = session(THREE, { perBranchOverlay: overlay });
    const denied = await call('/t/company/c1/branch/branch-a', s);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('MISSING_PERMISSION');
    expect(
      (await call('/t/company/c1/branch/branch-b', session(THREE, { perBranchOverlay: overlay })))
        .statusCode,
    ).toBe(200);
  });

  it('@RequireAllBranches: unrestricted branch authority → 200; a restricted caller → the non-disclosing 404', async () => {
    expect((await call('/t/company/c1/all-of', session(THREE))).statusCode).toBe(200);
    for (const branchScope of [['branch-a'], ['branch-a', 'branch-b'], []]) {
      const res = await call('/t/company/c1/all-of', session(THREE, { branchScope }));
      expect(res.statusCode, JSON.stringify(branchScope)).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('@RequireAllBranches: "all" branches narrowed by a per-branch overlay is NOT unrestricted', async () => {
    const s = session(THREE, { perBranchOverlay: { 'branch-a': ['orders:view'] } });
    expect((await call('/t/company/c1/all-of', s)).statusCode).toBe(404);
  });

  it('@RequireAllBranches is enforced even without a @ScopedParam (never silently skipped)', async () => {
    expect((await call('/t/unscoped-wide', session(['orders:view']))).statusCode).toBe(200);
    expect(
      (await call('/t/unscoped-wide', session(['orders:view'], { branchScope: ['branch-a'] })))
        .statusCode,
    ).toBe(404);
  });

  it('the permission is still decided FIRST: a restricted caller lacking the permission gets 403, an authorized restricted caller 404', async () => {
    expect(
      (await call('/t/company/c1/all-of', session([], { branchScope: ['branch-a'] }))).statusCode,
    ).toBe(403);
    expect(
      (await call('/t/company/c1/all-of', session(THREE, { branchScope: ['branch-a'] })))
        .statusCode,
    ).toBe(404);
  });

  it('company scope still applies to a company-wide route: another company → 404', async () => {
    expect(
      (await call('/t/company/c2/all-of', session(THREE, { companyScope: ['c1'] }))).statusCode,
    ).toBe(404);
    expect(
      (await call('/t/company/c1/all-of', session(THREE, { companyScope: ['c1'] }))).statusCode,
    ).toBe(200);
  });

  it('a branch route is unchanged: in-scope branch 200, out-of-scope 404', async () => {
    const s = session(THREE, { branchScope: ['branch-a'] });
    expect((await call('/t/company/c1/branch/branch-a', s)).statusCode).toBe(200);
    expect((await call('/t/company/c1/branch/branch-b', s)).statusCode).toBe(404);
  });
});
