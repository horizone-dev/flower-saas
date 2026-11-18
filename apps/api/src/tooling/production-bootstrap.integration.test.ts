import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import pg from 'pg';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { bootApp, type AppHandle } from '../verification/load-sale-world.js';
import { PasswordService } from '../common/crypto/password.service.js';
import { TotpService } from '../common/crypto/totp.service.js';
import { bootstrapPlatformOperator } from './platform-operator-bootstrap.js';
import { PlatformOperatorBootstrapRepository } from './platform-operator-bootstrap.repository.js';

/**
 * PRODUCTION BOOTSTRAP, end to end on real PostgreSQL + Redis, using only existing authentication primitives:
 *   real seed -> first platform operator (CLI core: password + PROVEN TOTP) -> platform login (password AND code) -> provision the pilot
 *   tenant -> one-time Owner invite -> Owner sets a password -> Owner enrols an authenticator -> Owner login now needs the code -> step-up.
 * Also proves: no hardcoded/shared credential exists, the bootstrap cannot be repeated or skip MFA, and the cashier-invite route (F-7) is NOT
 * active (cashier onboarding stays blocked until it is approved).
 */
describe('production bootstrap procedure', () => {
  let stack: TestStack;
  let h: AppHandle;
  let owner: pg.Client;
  const totp = new TotpService();
  const passwords = new PasswordService();
  const OP_EMAIL = 'first.operator@flower-ops.example';
  const OP_PASSWORD = 'tangerine-orbit-quiet-harbor-82';
  const OP_SECRET = authenticator.generateSecret();
  const OWNER_EMAIL = 'owner@pilot-flowers.example';
  const OWNER_PASSWORD = 'violet-meadow-slow-river-47!';
  let opToken = '';
  let slug = '';
  let tenantId = '';
  let ownerInviteToken = '';
  let ownerSecret = '';
  const post = (url: string, body: object, token?: string, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: 'POST',
      url: `/v1${url}`,
      payload: body,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) =>
    (await owner.query(s, p)).rows as T[];

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    // the REAL reference-data seed (the same one the staging job runs), not test fixtures
    execFileSync('node', ['--import', 'tsx', 'prisma/seed.ts'], {
      cwd: fileURLToPath(new URL('../../../../packages/db', import.meta.url)),
      env: { ...process.env, DATABASE_URL: stack.postgres.url },
      stdio: 'pipe',
    });
    h = await bootApp({ pg: stack.postgres.url, redis: stack.redis.url });
    owner = new pg.Client({ connectionString: stack.postgres.url });
    await owner.connect();
  }, 300_000);

  afterAll(async () => {
    await owner?.end();
    await h?.close();
    await stack?.stop();
  });

  it('a fresh production database has NO operator, NO credential and no default login', async () => {
    expect(await q('SELECT 1 FROM platform_user')).toHaveLength(0);
    expect(await q('SELECT 1 FROM platform_credential')).toHaveLength(0);
    const r = await post('/platform/auth/login', {
      email: 'admin@flower.test',
      password: 'admin',
      code: '123456',
    });
    expect(r.statusCode).toBe(401);
  });

  it('bootstraps the first operator: hash only, TOTP already confirmed, super_admin; refuses a repeat and a second operator', async () => {
    const repo = new PlatformOperatorBootstrapRepository(h.db.platformClient());
    const deps = {
      hashPassword: (p: string) => passwords.hash(p),
      verifyTotp: (c: string, s: string) => totp.verify(c, s),
      repo,
    };
    // MFA cannot be skipped: no proof of possession, nothing is created
    await expect(
      bootstrapPlatformOperator(deps, {
        email: OP_EMAIL,
        name: 'First Operator',
        password: OP_PASSWORD,
        totpSecret: OP_SECRET,
        totpCode: '000000',
      }),
    ).rejects.toMatchObject({ code: 'TOTP_NOT_PROVEN' });
    expect(await q('SELECT 1 FROM platform_user')).toHaveLength(0);

    await bootstrapPlatformOperator(deps, {
      email: OP_EMAIL,
      name: 'First Operator',
      password: OP_PASSWORD,
      totpSecret: OP_SECRET,
      totpCode: authenticator.generate(OP_SECRET),
    });
    const cred = (await q<{ hash: string }>('SELECT hash FROM platform_credential'))[0]!;
    expect(cred.hash.startsWith('$argon2id$')).toBe(true);
    expect(cred.hash).not.toContain(OP_PASSWORD);
    const mfa = await q<{ status: string; kind: string }>(
      'SELECT status, kind FROM platform_mfa_factor',
    );
    expect(mfa).toEqual([{ status: 'CONFIRMED', kind: 'TOTP' }]);
    expect(
      await q(
        `SELECT 1 FROM platform_user_role pur JOIN platform_role pr ON pr.id = pur."platformRoleId" WHERE pr.key = 'super_admin'`,
      ),
    ).toHaveLength(1);
    expect(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_log WHERE action = 'user.created' AND "resourceType" = 'platform_user'`,
        )
      )[0]!.n,
    ).toBe('1');
    // the password appears nowhere in the audit trail
    expect(JSON.stringify(await q('SELECT * FROM audit_log'))).not.toContain(OP_PASSWORD);

    await expect(
      bootstrapPlatformOperator(deps, {
        email: OP_EMAIL,
        name: 'x',
        password: OP_PASSWORD,
        totpSecret: OP_SECRET,
        totpCode: authenticator.generate(OP_SECRET),
      }),
    ).rejects.toMatchObject({ code: 'OPERATOR_EXISTS' });
    const s2 = authenticator.generateSecret();
    await expect(
      bootstrapPlatformOperator(deps, {
        email: 'second@flower-ops.example',
        name: 'Second',
        password: OP_PASSWORD,
        totpSecret: s2,
        totpCode: authenticator.generate(s2),
      }),
    ).rejects.toMatchObject({ code: 'OPERATORS_ALREADY_BOOTSTRAPPED' });
  });

  it('platform login needs the password AND the authenticator code', async () => {
    expect(
      (await post('/platform/auth/login', { email: OP_EMAIL, password: 'wrong-password-123456' }))
        .statusCode,
    ).toBe(401);
    const noCode = await post('/platform/auth/login', { email: OP_EMAIL, password: OP_PASSWORD });
    expect(noCode.statusCode).toBe(401);
    expect((noCode.json() as { error: { code: string } }).error.code).toBe('MFA_FAILED');
    expect(
      (
        await post('/platform/auth/login', {
          email: OP_EMAIL,
          password: OP_PASSWORD,
          code: '000000',
        })
      ).statusCode,
    ).toBe(401);
    const ok = await post('/platform/auth/login', {
      email: OP_EMAIL,
      password: OP_PASSWORD,
      code: authenticator.generate(OP_SECRET),
    });
    expect(ok.statusCode, ok.payload).toBe(200);
    opToken = (ok.json() as { accessToken: string }).accessToken;
    expect(opToken.length).toBeGreaterThan(20);
  });

  it('the operator provisions the pilot tenant; the response carries ONE one-time Owner invite (48 h, hash stored)', async () => {
    const plan = (
      await q<{ id: string }>(
        `SELECT pv.id FROM plan_version pv JOIN plan p ON p.id = pv."planId" WHERE p.key = 'starter' AND pv.status = 'PUBLISHED' LIMIT 1`,
      )
    )[0]!;
    slug = `pilot-flowers-${randomUUID().slice(0, 6)}`;
    const r = await post(
      '/platform/tenants',
      {
        slug,
        name: 'Pilot Flowers LLC',
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'FLOWER_FLORIST',
        planVersionId: plan.id,
        ownerEmail: OWNER_EMAIL,
      },
      opToken,
      { 'idempotency-key': `bootstrap-${slug}` },
    );
    expect(r.statusCode, r.payload).toBe(201);
    const body = r.json() as { tenantId: string; setPasswordToken: string };
    tenantId = body.tenantId;
    ownerInviteToken = body.setPasswordToken;
    expect(ownerInviteToken.length).toBeGreaterThanOrEqual(43);
    const tok = await q<{ tokenHash: string; usedAt: unknown }>(
      'SELECT "tokenHash", "usedAt" FROM set_password_token WHERE "tenantId" = $1',
      [tenantId],
    );
    expect(tok).toHaveLength(1);
    expect(tok[0]!.tokenHash).not.toBe(ownerInviteToken);
    // the Owner exists as an Owner, with NO credential yet
    const u = (
      await q<{ id: string; accountType: string }>(
        'SELECT id, "accountType" FROM "user" WHERE "tenantId" = $1 AND email = $2',
        [tenantId, OWNER_EMAIL],
      )
    )[0]!;
    expect(u.accountType).toBe('OWNER');
    expect(await q('SELECT 1 FROM credential WHERE "userId" = $1', [u.id])).toHaveLength(0);
  });

  it('the Owner redeems the invite once, then enrols an authenticator; from then on the password alone is not enough', async () => {
    const set = await post('/auth/set-password', {
      token: ownerInviteToken,
      newPassword: OWNER_PASSWORD,
    });
    expect(set.statusCode, set.payload).toBeLessThan(300);
    expect(
      (
        await post('/auth/set-password', {
          token: ownerInviteToken,
          newPassword: 'another-long-password-99',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);

    const login1 = await post('/auth/login', {
      workspaceSlug: slug,
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    expect(login1.statusCode, login1.payload).toBe(200);
    const t1 = (login1.json() as { accessToken?: string }).accessToken!;
    expect(t1).toBeTruthy();

    const enrol = await post('/auth/mfa/enrol', {}, t1);
    expect(enrol.statusCode, enrol.payload).toBeLessThan(300);
    ownerSecret = (enrol.json() as { secret: string }).secret;
    // an unconfirmed factor does not yet gate login; a WRONG code does not confirm it
    expect((await post('/auth/mfa/confirm', { code: '000000' }, t1)).statusCode).toBe(401);
    expect(
      (await post('/auth/mfa/confirm', { code: authenticator.generate(ownerSecret) }, t1))
        .statusCode,
    ).toBeLessThan(300);

    const login2 = await post('/auth/login', {
      workspaceSlug: slug,
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    const b2 = login2.json() as { accessToken?: string; mfaChallenge?: string };
    expect(b2.accessToken).toBeUndefined();
    expect(b2.mfaChallenge).toBeTruthy();
    expect(
      (await post('/auth/mfa/verify', { mfaChallenge: b2.mfaChallenge, code: '000000' }))
        .statusCode,
    ).toBe(401);
    const verified = await post('/auth/mfa/verify', {
      mfaChallenge: b2.mfaChallenge,
      code: authenticator.generate(ownerSecret),
    });
    expect(verified.statusCode, verified.payload).toBe(200);
    const t2 = (verified.json() as { accessToken: string }).accessToken;
    const step = await post('/auth/step-up', { code: authenticator.generate(ownerSecret) }, t2);
    expect(step.statusCode, step.payload).toBeLessThan(300);
  });

  it('pilot cashier onboarding stays BLOCKED: the F-7 invite route is not active (404), and no cashier exists', async () => {
    for (const url of [`/platform/tenants/${tenantId}/staff-invites`, '/org/staff-invites']) {
      const r = await post(
        url,
        { email: 'cashier@pilot-flowers.example', roleKey: 'cashier' },
        opToken,
      );
      expect(r.statusCode, url).toBe(404);
    }
    expect(
      await q(
        `SELECT 1 FROM user_role ur JOIN role r ON r.id = ur."roleId" WHERE r.key = 'cashier' AND ur."tenantId" = $1`,
        [tenantId],
      ),
    ).toHaveLength(0);
  });
});
