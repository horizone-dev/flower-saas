import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { createSaleWorld, type SaleWorld } from '../../verification/load-sale-world.js';
import { DbService } from '../../common/data/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { RedisService } from '../../common/redis/redis.module.js';
import { LimitService } from '../platform/limit.service.js';
import { StaffOnboardingRepository } from './staff-onboarding.repository.js';
import {
  ACTOR_INVITES_PER_HOUR,
  ONBOARDABLE_ROLE_KEYS,
  StaffOnboardingService,
  normaliseEmail,
} from './staff-onboarding.service.js';

/**
 * F-7 (PROPOSED, inert: no route, no module registration) — create a staff user + one-time invite. Real PostgreSQL + Redis. The service is
 * built by hand from the running app's providers, so nothing in production wires it. Proves: the account, role, EXPLICIT scope, hashed
 * single-use token and the three audit rows are created together; the invite works through the EXISTING set-password + login flow; every
 * refusal leaves nothing behind; cross-tenant / cross-company ids are refused; the plan limit holds under concurrency; abuse budgets bite.
 */
describe('F-7 — staff onboarding service (inert)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let svc: StaffOnboardingService;
  let redis: RedisService;
  const ACTOR = '00000000-0000-7000-8000-0000000000aa';
  let seq = 0;
  const email = (): string => `Staff-${++seq}@Pilot.TEST`;
  const q = async <T = Record<string, unknown>>(text: string, p: unknown[] = []): Promise<T[]> =>
    (await w.pool.query(text, p)).rows as T[];
  const cmd = (over: Record<string, unknown> = {}) => ({
    tenantId: w.a.tenantId,
    email: email(),
    roleKey: 'cashier',
    companyIds: [w.a.companyId],
    branchIds: [w.a.branches[0]!],
    actorPlatformUserId: ACTOR,
    ...over,
  });
  const userCount = async (): Promise<number> =>
    Number(
      (
        await q<{ n: string }>(`SELECT count(*)::int AS n FROM "user" WHERE "tenantId" = $1`, [
          w.a.tenantId,
        ])
      )[0]!.n,
    );

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 2, {
      realClock: true,
    });
    const app = w.h.app;
    redis = app.get(RedisService);
    await q(
      `INSERT INTO platform_user (id, email, name, "updatedAt") VALUES ($1,'inviter@flower.test','Inviter',now()) ON CONFLICT DO NOTHING`,
      [ACTOR],
    );
    svc = new StaffOnboardingService(
      new StaffOnboardingRepository(app.get(DbService), app.get(AuditWriter)),
      app.get(LimitService),
      redis,
    );
  }, 300_000);

  afterAll(async () => {
    await w?.h.close();
    await w?.pool.end();
    await stack?.stop();
  });

  it('creates the user, ONE role, an explicit scope, a hashed token and the audit trail in one go — and no credential yet', async () => {
    const r = await svc.inviteStaff(cmd());
    expect(r.roleKey).toBe('cashier');
    const u = (
      await q<{ id: string; email: string; accountType: string; status: string }>(
        `SELECT id, email, "accountType", status FROM "user" WHERE id = $1`,
        [r.userId],
      )
    )[0]!;
    expect(u).toMatchObject({ accountType: 'USER', status: 'ACTIVE' });
    expect(u.email).toBe(u.email.toLowerCase()); // normalised
    const roles = await q<{ key: string }>(
      `SELECT r.key FROM user_role ur JOIN role r ON r.id = ur."roleId" WHERE ur."userId" = $1`,
      [r.userId],
    );
    expect(roles).toEqual([{ key: 'cashier' }]);
    const sc = (
      await q<Record<string, unknown>>(`SELECT * FROM data_scope_assignment WHERE "userId" = $1`, [
        r.userId,
      ])
    )[0]!;
    expect(sc['companyScopeAll']).toBe(false);
    expect(sc['branchScopeAll']).toBe(false);
    expect(sc['companyIds']).toEqual([w.a.companyId]);
    expect(sc['branchIds']).toEqual([w.a.branches[0]]);
    // the token is stored ONLY as a hash, never the raw value
    const tok = await q<{ tokenHash: string; usedAt: unknown; createdByPlatformUserId: string }>(
      `SELECT "tokenHash", "usedAt", "createdByPlatformUserId" FROM set_password_token WHERE "userId" = $1`,
      [r.userId],
    );
    expect(tok).toHaveLength(1);
    expect(tok[0]!.tokenHash).not.toBe(r.setPasswordToken);
    expect(tok[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tok[0]!.usedAt).toBeNull();
    expect(tok[0]!.createdByPlatformUserId).toBe(ACTOR);
    expect(await q(`SELECT 1 FROM credential WHERE "userId" = $1`, [r.userId])).toHaveLength(0);
    // audit: user.created + roles + scope, by the PLATFORM actor, never carrying the token
    const audit = await q<{ action: string; actorPlatformUserId: string; after: unknown }>(
      `SELECT action, "actorPlatformUserId", after FROM audit_log WHERE "resourceId" = $1 ORDER BY action`,
      [r.userId],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'user.created',
      'user.roles_changed',
      'user.scope_changed',
    ]);
    expect(audit.every((a) => a.actorPlatformUserId === ACTOR)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(r.setPasswordToken);
  });

  it('the invite works through the EXISTING flow: set-password once, then login; the token is single-use', async () => {
    const em = email();
    const r = await svc.inviteStaff(cmd({ email: em }));
    const password = 'Cashier-Onboard-Pass-77';
    const set = await w.h.app.inject({
      method: 'POST',
      url: '/v1/auth/set-password',
      payload: { token: r.setPasswordToken, newPassword: password },
    });
    expect(set.statusCode, set.payload).toBeLessThan(300);
    const again = await w.h.app.inject({
      method: 'POST',
      url: '/v1/auth/set-password',
      payload: { token: r.setPasswordToken, newPassword: 'Another-Pass-Value-88' },
    });
    expect(again.statusCode).toBeGreaterThanOrEqual(400); // single use
    const slug = (
      await q<{ slug: string }>(`SELECT slug FROM tenant WHERE id = $1`, [w.a.tenantId])
    )[0]!.slug;
    const login = await w.h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { workspaceSlug: slug, email: em.toLowerCase(), password },
    });
    expect(login.statusCode, login.payload).toBe(200);
  });

  it('only allow-listed, non-owner roles can be onboarded', async () => {
    expect([...ONBOARDABLE_ROLE_KEYS]).toEqual(['cashier', 'sales']);
    for (const roleKey of ['owner', 'admin', 'manager', 'accountant', 'nonexistent']) {
      const before = await userCount();
      await expect(svc.inviteStaff(cmd({ roleKey }))).rejects.toMatchObject({
        code: 'ROLE_NOT_ONBOARDABLE',
      });
      expect(await userCount()).toBe(before);
    }
  });

  it('the scope must be explicit: empty company or branch lists are refused (never all-access)', async () => {
    const before = await userCount();
    await expect(svc.inviteStaff(cmd({ companyIds: [] }))).rejects.toMatchObject({
      code: 'SCOPE_REQUIRED',
    });
    await expect(svc.inviteStaff(cmd({ branchIds: [] }))).rejects.toMatchObject({
      code: 'SCOPE_REQUIRED',
    });
    await expect(svc.inviteStaff(cmd({ branchIds: ['not-a-uuid'] }))).rejects.toMatchObject({
      code: 'SCOPE_INVALID',
    });
    expect(await userCount()).toBe(before);
  });

  it('refuses a foreign tenant company/branch, and a branch outside the listed company — nothing is left behind', async () => {
    const before = await userCount();
    const tokens = (
      await q<{ n: string }>(
        `SELECT count(*)::int AS n FROM set_password_token WHERE "tenantId" = $1`,
        [w.a.tenantId],
      )
    )[0]!.n;
    // a company of ANOTHER tenant
    await expect(
      svc.inviteStaff(cmd({ companyIds: [w.b.companyId], branchIds: [w.b.branches[0]!] })),
    ).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
    // own-tenant company but the branch of a different company of the same tenant
    await expect(
      svc.inviteStaff(cmd({ companyIds: [w.a.companyId], branchIds: [w.a2.branches[0]!] })),
    ).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
    // a foreign tenant's branch smuggled in next to a valid one
    await expect(
      svc.inviteStaff(cmd({ branchIds: [w.a.branches[0]!, w.b.branches[0]!] })),
    ).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
    expect(await userCount()).toBe(before);
    expect(
      (
        await q<{ n: string }>(
          `SELECT count(*)::int AS n FROM set_password_token WHERE "tenantId" = $1`,
          [w.a.tenantId],
        )
      )[0]!.n,
    ).toBe(tokens);
    // and the foreign tenant gained nothing
    expect(
      (
        await q<{ n: string }>(
          `SELECT count(*)::int AS n FROM "user" WHERE "tenantId" = $1 AND email ILIKE 'staff-%'`,
          [w.b.tenantId],
        )
      )[0]!.n,
    ).toBe(0);
  });

  // R10 — regression for a gap found by mutation: removing the tenant filter from the company lookup survived every other test, because a
  // foreign company id was only ever listed together with a foreign branch (which the branch check catches). Here the foreign COMPANY id sits
  // next to a fully valid own company AND own branch, so only the tenant-filtered company lookup can refuse it.
  it('R10: a foreign tenant company id listed ALONGSIDE a valid own company and branch is refused — it never reaches the new user scope', async () => {
    const before = await userCount();
    const tokensBefore = (
      await q<{ n: string }>(
        `SELECT count(*)::int AS n FROM set_password_token WHERE "tenantId" = $1`,
        [w.a.tenantId],
      )
    )[0]!.n;
    await expect(
      svc.inviteStaff(
        cmd({
          companyIds: [w.a.companyId, w.b.companyId],
          branchIds: [w.a.branches[0]!],
        }),
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
    expect(await userCount()).toBe(before);
    expect(
      (
        await q<{ n: string }>(
          `SELECT count(*)::int AS n FROM set_password_token WHERE "tenantId" = $1`,
          [w.a.tenantId],
        )
      )[0]!.n,
    ).toBe(tokensBefore);
    // no data scope anywhere names the foreign company
    expect(
      (
        await q<{ n: string }>(
          `SELECT count(*)::int AS n FROM data_scope_assignment WHERE "tenantId" = $1 AND $2::uuid = ANY("companyIds")`,
          [w.a.tenantId, w.b.companyId],
        )
      )[0]!.n,
    ).toBe(0);
  });

  it('a duplicate email in the workspace is refused (409) without a second user or token; a malformed email is refused', async () => {
    const em = email();
    await svc.inviteStaff(cmd({ email: em }));
    const before = await userCount();
    await expect(svc.inviteStaff(cmd({ email: em.toUpperCase() }))).rejects.toMatchObject({
      code: 'USER_EMAIL_TAKEN',
      status: 409,
    });
    expect(await userCount()).toBe(before);
    for (const bad of ['', 'no-at-sign', 'a@b', 'a b@c.d', `${'x'.repeat(250)}@a.bc`]) {
      expect(() => normaliseEmail(bad)).toThrow();
    }
  });

  it('the plan max_users limit holds under concurrency (re-count under the tenant lock): exactly the free slots are created', async () => {
    const repo = new StaffOnboardingRepository(w.h.app.get(DbService), w.h.app.get(AuditWriter));
    const usersOfLimitBucket = async (): Promise<number> =>
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*)::int AS n FROM "user" WHERE "tenantId" = $1 AND "accountType" = 'USER'`,
            [w.a.tenantId],
          )
        )[0]!.n,
      );
    const slots = 3;
    const cap = (await usersOfLimitBucket()) + slots;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        repo.createStaffUser({
          tenantId: w.a.tenantId,
          email: email().toLowerCase(),
          roleKey: 'cashier',
          companyIds: [w.a.companyId],
          branchIds: [w.a.branches[0]!],
          tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
          tokenExpiresAt: new Date(Date.now() + 60_000),
          maxUsers: cap,
          actorPlatformUserId: ACTOR,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const limited = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'LIMIT_EXCEEDED',
    ).length;
    expect(ok).toBe(slots);
    expect(limited).toBe(12 - slots);
    expect(await usersOfLimitBucket()).toBe(cap);
  });

  it('an exhausted per-actor invite budget refuses (429) before any work, and a missing token store is not required to be trusted', async () => {
    const before = await userCount();
    await redis
      .require()
      .set(`staff-invite:actor:${ACTOR}`, String(ACTOR_INVITES_PER_HOUR), 'EX', 3600);
    await expect(svc.inviteStaff(cmd())).rejects.toMatchObject({
      code: 'INVITE_RATE_LIMITED',
      status: 429,
    });
    expect(await userCount()).toBe(before);
    await redis.require().del(`staff-invite:actor:${ACTOR}`);
  });

  it('a suspended / non-active workspace cannot onboard staff', async () => {
    await q(`UPDATE tenant SET status = 'SUSPENDED' WHERE id = $1`, [w.b.tenantId]);
    await redis.require().del(`staff-invite:actor:${ACTOR}`);
    await expect(
      svc.inviteStaff({
        tenantId: w.b.tenantId,
        email: email(),
        roleKey: 'cashier',
        companyIds: [w.b.companyId],
        branchIds: [w.b.branches[0]!],
        actorPlatformUserId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_ACTIVE' });
    await q(`UPDATE tenant SET status = 'ACTIVE' WHERE id = $1`, [w.b.tenantId]);
  });

  it('FAILS CLOSED when the abuse-budget store (Redis) is unavailable: nothing is created', async () => {
    const downRedis = {
      require: () => {
        throw new Error('redis unavailable');
      },
    } as unknown as RedisService;
    const closed = new StaffOnboardingService(
      new StaffOnboardingRepository(w.h.app.get(DbService), w.h.app.get(AuditWriter)),
      w.h.app.get(LimitService),
      downRedis,
    );
    const before = await userCount();
    await expect(closed.inviteStaff(cmd())).rejects.toThrow(/redis unavailable/);
    expect(await userCount()).toBe(before);
  });

  it('the invite token is 256-bit random base64url, unique per invite, and an EXPIRED invite cannot set a password', async () => {
    await redis.require().del(`staff-invite:actor:${ACTOR}`);
    const a = await svc.inviteStaff(cmd());
    const b = await svc.inviteStaff(cmd());
    expect(a.setPasswordToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.setPasswordToken).not.toBe(b.setPasswordToken);
    await q(
      `UPDATE set_password_token SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`,
      [a.userId],
    );
    const r = await w.h.app.inject({
      method: 'POST',
      url: '/v1/auth/set-password',
      payload: { token: a.setPasswordToken, newPassword: 'Expired-Invite-Pass-12' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await q(`SELECT 1 FROM credential WHERE "userId" = $1`, [a.userId])).toHaveLength(0);
  });

  it('an invited user cannot log in before the invite is used (no credential exists)', async () => {
    await redis.require().del(`staff-invite:actor:${ACTOR}`);
    const em = email();
    await svc.inviteStaff(cmd({ email: em }));
    const slug = (
      await q<{ slug: string }>(`SELECT slug FROM tenant WHERE id = $1`, [w.a.tenantId])
    )[0]!.slug;
    const login = await w.h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { workspaceSlug: slug, email: em.toLowerCase(), password: 'Guess-Guess-Guess-1' },
    });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);
  });
});
