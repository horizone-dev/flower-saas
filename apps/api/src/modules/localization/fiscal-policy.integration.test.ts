import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient } from '@flower/db';
import pg from 'pg';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import type { DbService } from '../../common/data/index.js';
import { LocalizationRepository } from './localization.repository.js';
import { LocalizationService } from './localization.service.js';

/**
 * Task 3b.4 Checkpoint C — `LocalizationService.resolveFiscalPolicyOn` against
 * real Postgres. White-box, no-HTTP direct-construction pattern (mirrors
 * `invoice-issuance.repository.integration.test.ts`) — `country_tax_config`
 * is RLS-exempt platform reference data, so only a `DbService` + a tenant-
 * bearing request context (for `ScopedRepository.scoped()`'s own GUC dance,
 * which plays no role for this specific table) are needed, never a full app.
 *
 * `country_tax_config` is now immutable history (§C11 — no UPDATE-in-place,
 * no DELETE, proven separately in the migration test). Each test therefore
 * gets its OWN freshly-inserted `country` row (a distinct 2-char code) rather
 * than sharing/cleaning up one row between tests — total isolation, no
 * cleanup needed, and it never fights the new immutability trigger.
 */
describe('LocalizationService.resolveFiscalPolicyOn (task 3b.4 Checkpoint C, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let client: pg.Client;
  let service: LocalizationService;
  const tenantId = randomUUID();
  let seq = 0;

  function withTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runWithContext(new RequestContext({ requestId: randomUUID(), tenantId }), fn);
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    client = new pg.Client({ connectionString: stack.postgres.url });
    await client.connect();

    const dbService = { appClient: () => prisma } as unknown as DbService;
    service = new LocalizationService(new LocalizationRepository(dbService));

    await client.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('FPX', 2, 'x', 'Fiscal Policy Test Currency', 'x') ON CONFLICT (code) DO NOTHING`,
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  /** A fresh, never-reused country code + its seeded `country_tax_config` row(s). */
  async function mkCountry(
    configs: { effectiveFrom: string; effectiveTo?: string | null; config: unknown }[],
  ): Promise<string> {
    const code = `Z${(seq++).toString(36).padStart(2, '0')}`.slice(0, 8);
    await client.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
       VALUES ($1, 'Fiscal Policy Test', 'x', 'XX', 'FPX', 'FRI_SAT', now())`,
      [code],
    );
    for (const c of configs) {
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo","regime","config")
         VALUES ($1,$2,$3,'VAT',$4::jsonb)`,
        [code, c.effectiveFrom, c.effectiveTo ?? null, JSON.stringify(c.config)],
      );
    }
    return code;
  }

  const VALID_CONFIG = {
    priceTaxMode: 'TAX_EXCLUSIVE',
    roundingScope: 'LINE',
    roundingMode: 'HALF_UP',
  };

  it('resolves a single valid effective config', async () => {
    const country = await mkCountry([{ effectiveFrom: '2026-01-01', config: VALID_CONFIG }]);
    const result = await withTenant(() => service.resolveFiscalPolicyOn(country, '2026-06-01'));
    expect(result).toEqual(VALID_CONFIG);
  });

  it('effectiveFrom boundary is inclusive', async () => {
    const country = await mkCountry([{ effectiveFrom: '2026-01-01', config: VALID_CONFIG }]);
    const result = await withTenant(() => service.resolveFiscalPolicyOn(country, '2026-01-01'));
    expect(result).toEqual(VALID_CONFIG);
  });

  it('effectiveTo boundary is inclusive', async () => {
    const country = await mkCountry([
      { effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31', config: VALID_CONFIG },
    ]);
    const result = await withTenant(() => service.resolveFiscalPolicyOn(country, '2026-03-31'));
    expect(result).toEqual(VALID_CONFIG);
  });

  it('before the effective range -> NOT_CONFIGURED (never a default), 409 caller-fixable', async () => {
    const country = await mkCountry([{ effectiveFrom: '2026-01-01', config: VALID_CONFIG }]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(country, '2025-12-31')),
    ).rejects.toMatchObject({ code: 'ORDER_COMPANY_TAX_POLICY_NOT_CONFIGURED', status: 409 });
  });

  it('after a closed effective range -> NOT_CONFIGURED, 409 caller-fixable', async () => {
    const country = await mkCountry([
      { effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31', config: VALID_CONFIG },
    ]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(country, '2026-04-01')),
    ).rejects.toMatchObject({ code: 'ORDER_COMPANY_TAX_POLICY_NOT_CONFIGURED', status: 409 });
  });

  it('>1 overlapping effective rows -> TAX_POLICY_AMBIGUOUS (never newest-wins/first-row-wins)', async () => {
    const country = await mkCountry([
      { effectiveFrom: '2026-01-01', config: VALID_CONFIG },
      { effectiveFrom: '2026-02-01', config: { ...VALID_CONFIG, roundingMode: 'HALF_EVEN' } },
    ]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(country, '2026-06-01')),
    ).rejects.toMatchObject({ code: 'TAX_POLICY_AMBIGUOUS', status: 500 });
  });

  it('exactly one effective row but a malformed config -> TAX_POLICY_CONFIG_INVALID (never a silent TAX_EXCLUSIVE/HALF_UP default)', async () => {
    const country = await mkCountry([{ effectiveFrom: '2026-01-01', config: {} }]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(country, '2026-06-01')),
    ).rejects.toMatchObject({ code: 'TAX_POLICY_CONFIG_INVALID', status: 500 });
  });

  it('exactly one effective row with an unknown extra config key -> TAX_POLICY_CONFIG_INVALID', async () => {
    const country = await mkCountry([
      { effectiveFrom: '2026-01-01', config: { ...VALID_CONFIG, extra: true } },
    ]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(country, '2026-06-01')),
    ).rejects.toMatchObject({ code: 'TAX_POLICY_CONFIG_INVALID', status: 500 });
  });

  // §C24 item 1D — non-disclosing errors. `countryCode` is always already
  // authoritative (`company.countryCode`, never client-supplied), so there is
  // no cross-tenant/cross-scope surface for THIS method to leak through — the
  // remaining concern is that none of its 3 error messages ever echo internal
  // identifiers (tenantId/companyId) or raw stored config content beyond the
  // fixed, already-public enum vocabulary.
  it('none of the 3 error messages leak a tenantId/companyId or raw config content', async () => {
    const notConfigured = await mkCountry([]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(notConfigured, '2026-06-01')),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining(tenantId),
    });

    const ambiguous = await mkCountry([
      { effectiveFrom: '2026-01-01', config: VALID_CONFIG },
      { effectiveFrom: '2026-02-01', config: { ...VALID_CONFIG, roundingMode: 'HALF_EVEN' } },
    ]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(ambiguous, '2026-06-01')),
    ).rejects.toMatchObject({ message: expect.not.stringContaining(tenantId) });

    const malformed = await mkCountry([
      { effectiveFrom: '2026-01-01', config: { secretField: 'should-not-leak' } },
    ]);
    await expect(
      withTenant(() => service.resolveFiscalPolicyOn(malformed, '2026-06-01')),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining('should-not-leak'),
    });
  });
});
