import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { PLATFORM_PERMISSIONS } from '@flower/permissions';
import { createSaleWorld, type SaleWorld } from '../../verification/load-sale-world.js';
import type { SessionData } from '../../common/auth/session.types.js';

/**
 * R-1 review: with SECRETS_PROVIDER=disabled, EVERY way to use the vault fails closed, NOTHING is stored (no row, no plaintext anywhere in the
 * database), and everything that does not need a secret keeps working — a cash + card-terminal sale (card is a recorded local tender),
 * listing credentials, and revoking. (Run in a disposable copy with the R-1 patch applied; the patch itself is unapplied.)
 */
// the platform user id for the session AND the token subject: a constant, so the token claim is a plain string rather than `string | null`
const PLATFORM_USER_ID = '00000000-0000-7000-8000-000000009991';

describe('R-1 — the disabled secrets vault fails closed', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let platform = '';
  const SECRET = 'sk_live_R1_PLAINTEXT_MUST_NEVER_BE_STORED_9f3a';
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) =>
    (await w.pool.query(s, p)).rows as T[];
  const creds = (method: 'GET' | 'POST' | 'PUT', url: string, body?: Record<string, unknown>) =>
    w.req(method, `/platform/tenants/${w.a.tenantId}/provider-credentials${url}`, platform, body);

  beforeAll(async () => {
    process.env['SECRETS_PROVIDER'] = 'disabled';
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 2, {
      realClock: true,
    });
    const s: SessionData = {
      sessionId: 'r1-platform',
      realm: 'platform',
      familyId: 'f',
      tenantId: null,
      userId: null,
      platformUserId: PLATFORM_USER_ID,
      accountType: 'PLATFORM',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'STEP_UP',
      stepUpUntil: Date.now() + 600_000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: {
        effectivePermissions: [...PLATFORM_PERMISSIONS],
        companyScope: 'ALL',
        branchScope: 'ALL',
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    };
    await w.h.store.set(s);
    platform = await w.h.jwt.sign({ sub: PLATFORM_USER_ID, sid: s.sessionId, aud: 'platform' });
  }, 300_000);

  afterAll(async () => {
    delete process.env['SECRETS_PROVIDER'];
    await w?.h.close();
    await w?.pool.end();
    await stack?.stop();
  });

  it('creating a credential is refused 503 SECRETS_DISABLED; no row; the plaintext appears NOWHERE in the database', async () => {
    const r = await creds('POST', '', { provider: 'stripe', mode: 'LIVE', secret: SECRET });
    expect(r.status, JSON.stringify(r.body)).toBe(503);
    expect((r.body as { error: { code: string } }).error.code).toBe('SECRETS_DISABLED');
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(await q('SELECT 1 FROM provider_credential')).toHaveLength(0);
    // scan every text-like column of every table for the plaintext
    const tables = await q<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    for (const { t } of tables) {
      const hit = await q(`SELECT 1 FROM "${t}" x WHERE x::text LIKE $1 LIMIT 1`, [`%${SECRET}%`]);
      expect(hit, `plaintext found in ${t}`).toHaveLength(0);
    }
  });

  it('rotating, reading a sealed credential and any other vault read are refused or not found; nothing is created', async () => {
    const id = '00000000-0000-7000-8000-0000000000ee';
    expect((await creds('PUT', `/${id}`, { secret: SECRET })).status).toBe(404); // nothing exists to rotate
    expect((await creds('GET', `/${id}`)).status).toBe(404);
    expect((await creds('GET', '')).status).toBe(200); // listing needs no secret
    expect((await creds('GET', '')).body).toEqual([]);
    expect(await q('SELECT 1 FROM provider_credential')).toHaveLength(0);
  });

  it('a row that already exists cannot be OPENED (decrypt fails closed 503) — simulating a credential created before the vault was disabled', async () => {
    await q(
      `INSERT INTO provider_credential ("tenantId", provider, mode, status, version, "nonSecretConfig", "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, 'stripe', 'TEST', 'ACTIVE', 1, '{}'::jsonb, '\\x00', '\\x00', '\\x00', now())`,
      [w.a.tenantId],
    );
    const rows = await q<{ id: string }>('SELECT id FROM provider_credential LIMIT 1');
    expect(
      rows,
      'the pre-existing credential row must exist for this test to mean anything',
    ).toHaveLength(1);
    const r = await creds('GET', `/${rows[0]!.id}`);
    expect(r.status).toBe(503);
  });

  it('NOTHING that does not need a secret is affected: a cash + card-terminal split sale completes (card is a recorded local tender)', async () => {
    const created = await w.req(
      'POST',
      `/companies/${w.a.companyId}/branches/${w.a.branches[0]!}/orders`,
      w.ownerToken,
      {
        lines: [
          {
            productId: w.productId,
            variantId: w.variantId,
            selectedUomCode: 'piece',
            quantity: '2',
          },
        ],
      },
      { 'idempotency-key': `r1-${Date.now()}` },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const o = (created.body as { order: { id: string; version: number } }).order;
    const done = await w.req(
      'POST',
      `/companies/${w.a.companyId}/branches/${w.a.branches[0]!}/orders/${o.id}/complete-sale`,
      w.ownerToken,
      {
        paymentIntent: 'PAY_NOW',
        tenders: [
          { method: 'CARD_TERMINAL', amountMinor: '1200' },
          { method: 'CASH', amountMinor: '800' },
        ],
      },
      { 'if-match': String(o.version), 'idempotency-key': `r1s-${Date.now()}` },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  });
});
