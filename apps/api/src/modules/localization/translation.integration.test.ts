import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { DbService } from '@flower/backend';
import { runWithContext, RequestContext } from '../../common/context/index.js';
import { TranslationRepository } from './translation.repository.js';
import { TranslationService } from './translation.service.js';

/**
 * Task 2.7 — `TranslationService` safety + isolation (owner rule 7 / HG-LOCALE
 * "RLS on translation"). No HTTP surface exists for translations in task 2.7
 * (a future domain phase adds one) — this exercises the service/repository
 * directly against a real Postgres, exactly the layer a future controller
 * would call into unchanged.
 */
describe('translation: allowlist safety + tenant isolation (integration)', () => {
  let stack: TestStack;
  let db: DbService;
  let repo: TranslationRepository;
  let service: TranslationService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);

    db = new DbService({
      DATABASE_URL: stack.postgres.url,
      PLATFORM_DATABASE_URL: stack.postgres.url,
    } as ConstructorParameters<typeof DbService>[0]);
    repo = new TranslationRepository(db);
    service = new TranslationService(repo);

    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const planId = randomUUID();
      const planVersionId = randomUUID();
      await c.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
        planId,
        `translation-test-plan-${planId.slice(0, 8)}`,
      ]);
      await c.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
         VALUES ($1, $2, 1, 'PUBLISHED', now())`,
        [planVersionId, planId],
      );
      for (const tenantId of [tenantA, tenantB]) {
        await c.query(
          `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
           VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
          [tenantId, `translation-test-${tenantId.slice(0, 8)}`, planVersionId],
        );
      }
      // `translation.locale` FK-references `locale.code`.
      await c.query(
        `INSERT INTO locale (code, "nameEn", "nameAr", direction) VALUES
           ('en', 'English', 'x', 'ltr'), ('ar', 'Arabic', 'x', 'rtl')`,
      );
    } finally {
      await c.end();
    }
  }, 120_000);

  afterAll(async () => {
    await db.onModuleDestroy();
    await stack?.stop();
  });

  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runWithContext(new RequestContext({ requestId: 'r', tenantId }), fn);
  }

  // ── allowlist safety ──────────────────────────────────────────────────────
  it('rejects an entity/field pair outside the allowlist before any DB access', async () => {
    await asTenant(tenantA, async () => {
      await expect(
        service.translate('product', randomUUID(), 'name', 'ar', 'default'),
      ).rejects.toMatchObject({ code: 'ENTITY_FIELD_NOT_TRANSLATABLE' });
      await expect(
        service.setTranslation('branch', randomUUID(), 'address', 'ar', 'x'),
      ).rejects.toMatchObject({ code: 'ENTITY_FIELD_NOT_TRANSLATABLE' });
    });
  });

  it('a SQL-injection-shaped entityType/field is rejected the same way — never reaches a query', async () => {
    await asTenant(tenantA, async () => {
      await expect(
        service.translate(
          'branch"; DROP TABLE translation; --',
          randomUUID(),
          'name',
          'ar',
          'default',
        ),
      ).rejects.toMatchObject({ code: 'ENTITY_FIELD_NOT_TRANSLATABLE' });
    });
    // the table must still exist and be queryable — proves the rejected call
    // never reached raw SQL construction at all.
    await asTenant(tenantA, () => repo.get('branch', randomUUID(), 'name', 'ar'));
  });

  // ── fallback chain ─────────────────────────────────────────────────────────
  it('falls back: requested locale -> configured fallback (en) -> default text', async () => {
    const entityId = randomUUID();
    await asTenant(tenantA, async () => {
      // nothing stored yet at all -> default text
      expect(await service.translate('branch', entityId, 'name', 'ar', 'Main Branch')).toBe(
        'Main Branch',
      );

      // an English fallback row exists, Arabic does not -> falls back to it
      await service.setTranslation('branch', entityId, 'name', 'en', 'Main Branch (en)');
      expect(await service.translate('branch', entityId, 'name', 'ar', 'Main Branch')).toBe(
        'Main Branch (en)',
      );

      // an Arabic row now exists -> the requested locale wins directly
      await service.setTranslation('branch', entityId, 'name', 'ar', 'الفرع الرئيسي');
      expect(await service.translate('branch', entityId, 'name', 'ar', 'Main Branch')).toBe(
        'الفرع الرئيسي',
      );
    });
  });

  // ── tenant isolation (RLS) ──────────────────────────────────────────────────
  it("a tenant can never resolve another tenant's translation, even for the identical entityId", async () => {
    // the SAME entityId in both tenants — proves isolation is by tenant_id via
    // RLS, not merely "different ids never collide by chance".
    const sharedEntityId = randomUUID();

    await asTenant(tenantA, () =>
      service.setTranslation('branch', sharedEntityId, 'name', 'ar', 'تينانت أ'),
    );
    await asTenant(tenantB, () =>
      service.setTranslation('branch', sharedEntityId, 'name', 'ar', 'تينانت ب'),
    );

    const fromA = await asTenant(tenantA, () =>
      service.translate('branch', sharedEntityId, 'name', 'ar', 'fallback'),
    );
    const fromB = await asTenant(tenantB, () =>
      service.translate('branch', sharedEntityId, 'name', 'ar', 'fallback'),
    );
    expect(fromA).toBe('تينانت أ');
    expect(fromB).toBe('تينانت ب');
    expect(fromA).not.toBe(fromB);

    // and a raw DB check that BOTH rows exist, distinguished only by tenant_id
    // — RLS is what's preventing cross-read, not "the data never existed".
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const rows = (
        await c.query(
          `SELECT "tenantId", value FROM translation WHERE "entityId"=$1 ORDER BY value`,
          [sharedEntityId],
        )
      ).rows;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r: { tenantId: string }) => r.tenantId))).toEqual(
        new Set([tenantA, tenantB]),
      );
    } finally {
      await c.end();
    }
  });
});
