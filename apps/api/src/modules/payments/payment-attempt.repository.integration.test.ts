import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startTestStack,
  migrateTestDb,
  inParallel,
  summarize,
  type TestStack,
} from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped, type PrismaClient, type ScopedTx } from '@flower/db';
import { DbService, RequestContext, runWithContext, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { DomainError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import {
  PaymentAttemptReservationRepository,
  type ApplyProviderInitiationResultInput,
} from './payment-attempt-reservation.repository.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import { PaymentAttemptRepository } from './payment-attempt.repository.js';
import type {
  PaymentProvider,
  PaymentProviderInitiationResult,
  VerifiedProviderWebhookEvent,
} from './payment-provider.port.js';

/**
 * Task 3b.5 Checkpoint E (integration) — proves the async PaymentAttempt /
 * provider-reservation flow directly against real Postgres, through the
 * actual production `runScoped`/`RequestContext` path (no HTTP, no NestJS
 * bootstrap — matches `payment-collection.repository.integration.test.ts`'s
 * own precedent exactly). Covers: provider-config resolution security matrix
 * (§E25), the two-phase reservation transaction (§E8/§E9/§E11/§E14),
 * PENDING/REQUIRES_ACTION/AUTHORIZED/FAILED/CANCELED transition handling
 * (§E15/§E22), the malformed-CAPTURED runtime guard (§E12), ambiguous
 * network/persist failures (§E16/§E23/§E24), idempotent replay (§E18),
 * providerReference uniqueness (§E7/§E26), and concurrent reservation hard
 * gates against local synchronous capture (§E21).
 *
 * NO Payment/PaymentAllocation/CAPTURED-from-provider-result/audit/outbox/
 * PostingEngine/webhook code is exercised or asserted on anywhere in this
 * file — none of it exists in the code under test.
 */
const TENANT = 'e1000000-1111-7111-8111-111111111111';
const OTHER_TENANT = 'e2000000-2222-7222-8222-222222222222';
const COMPANY = 'e3000000-3333-7333-8333-333333333333';
const COMPANY_2 = 'e4000000-4444-7444-8444-444444444444';
const OTHER_TENANT_COMPANY = 'e5000000-5555-7555-8555-555555555555';
const BRANCH = 'e6000000-6666-7666-8666-666666666666';
const BRANCH_2 = 'e7000000-7777-7777-8777-777777777777';
const OTHER_TENANT_BRANCH = 'e8000000-8888-7888-8888-888888888888';
const CATEGORY = 'e9000000-9999-7999-8999-999999999999';
const PRODUCT = 'ea000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const VARIANT = 'eb000000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

const CRED_OK = 'ec000000-0001-7001-8001-000000000001';
const CRED_REVOKED = 'ec000000-0002-7002-8002-000000000002';
const CRED_NO_WEBHOOK = 'ec000000-0003-7003-8003-000000000003';
const CRED_WRONG_BRANCH = 'ec000000-0004-7004-8004-000000000004';
const CRED_TENANT_WIDE = 'ec000000-0005-7005-8005-000000000005';
const CRED_COMPANY_ONLY = 'ec000000-0006-7006-8006-000000000006';
const CRED_AMBIGUOUS_A = 'ec000000-0007-7007-8007-000000000007';
const CRED_AMBIGUOUS_B = 'ec000000-0008-7008-8008-000000000008';

function fakeAdapter(
  behavior: { kind: 'result'; result: PaymentProviderInitiationResult } | { kind: 'throws' },
): PaymentProvider & { callCount: number } {
  const adapter = {
    callCount: 0,
    async createIntent(): Promise<PaymentProviderInitiationResult> {
      adapter.callCount += 1;
      if (behavior.kind === 'throws') {
        throw new Error('simulated transport failure');
      }
      return behavior.result;
    },
    async authorize(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async capture(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async refund(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async getStatus(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async verifyWebhook(): Promise<VerifiedProviderWebhookEvent> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
  };
  return adapter;
}

/**
 * A retry-safe fake (owner recovery-pass §2/§10): behaves per an explicit
 * per-call sequence, repeating the LAST entry forever once exhausted — a
 * conforming adapter's retry-safety guarantee means every subsequent call
 * for the SAME `paymentAttemptId` reconciles to one logical intent, so a
 * fixed final entry (never a fresh/different result) correctly models that.
 */
function fakeSequenceAdapter(
  results: ReadonlyArray<
    { kind: 'result'; result: PaymentProviderInitiationResult } | { kind: 'throws' }
  >,
): PaymentProvider & { callCount: number } {
  const adapter = {
    callCount: 0,
    async createIntent(): Promise<PaymentProviderInitiationResult> {
      const behavior = results[Math.min(adapter.callCount, results.length - 1)]!;
      adapter.callCount += 1;
      if (behavior.kind === 'throws') {
        throw new Error('simulated transport failure');
      }
      return behavior.result;
    },
    async authorize(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async capture(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async refund(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async getStatus(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
    async verifyWebhook(): Promise<VerifiedProviderWebhookEvent> {
      throw new Error('not implemented — never called by Checkpoint E');
    },
  };
  return adapter;
}

describe('Checkpoint E — async PaymentAttempt / provider port (integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let reservation: PaymentAttemptReservationRepository;
  let providerConfig: ProviderConfigRepository;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    reservation = new PaymentAttemptReservationRepository(
      new AuditWriter(db),
      new OutboxWriter(db),
    );
    providerConfig = new ProviderConfigRepository(db);

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000e0000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000e0000002',
               '00000000-0000-7000-8000-0000e0000001', 1, 'PUBLISHED', now())`,
    );
    for (const [tenantId, slug] of [
      [TENANT, 'pe-3b5'],
      [OTHER_TENANT, 'pe-3b5-other'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000e0000002', now())`,
        [tenantId, slug],
      );
    }
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    for (const [id, tenantId, name] of [
      [COMPANY, TENANT, 'Co'],
      [COMPANY_2, TENANT, 'Co 2'],
      [OTHER_TENANT_COMPANY, OTHER_TENANT, 'Other Tenant Co'],
    ] as const) {
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, $3, 'AED', 'Asia/Dubai', now())`,
        [id, tenantId, name],
      );
    }
    for (const [id, tenantId, companyId, name] of [
      [BRANCH, TENANT, COMPANY, 'Main'],
      [BRANCH_2, TENANT, COMPANY, 'Second'],
      [OTHER_TENANT_BRANCH, OTHER_TENANT, OTHER_TENANT_COMPANY, 'Other Tenant Branch'],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [id, tenantId, companyId, name],
      );
    }
    await pool.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt")
       VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await pool.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose', 'Rose', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await pool.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt")
       VALUES ($1, $2, $3, 'Rose Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );

    // ── provider_credential fixtures — the E25 security matrix ────────────
    async function cred(
      id: string,
      opts: {
        companyId: string | null;
        branchId: string | null;
        provider: string;
        status?: string;
      },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO provider_credential
           (id, "tenantId", "companyId", "branchId", provider, mode, status,
            "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'TEST', $6, '\\x00', '\\x00', '\\x00', now())`,
        [id, TENANT, opts.companyId, opts.branchId, opts.provider, opts.status ?? 'ACTIVE'],
      );
    }
    async function webhook(providerCredentialId: string): Promise<void> {
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         SELECT uuidv7(), "tenantId", "companyId", "branchId", id FROM provider_credential WHERE id = $1`,
        [providerCredentialId],
      );
    }

    await cred(CRED_OK, { companyId: COMPANY, branchId: BRANCH, provider: 'tap-ok' });
    await webhook(CRED_OK);
    await cred(CRED_REVOKED, {
      companyId: COMPANY,
      branchId: BRANCH,
      provider: 'tap-revoked',
      status: 'REVOKED',
    });
    await webhook(CRED_REVOKED);
    await cred(CRED_NO_WEBHOOK, {
      companyId: COMPANY,
      branchId: BRANCH,
      provider: 'tap-no-webhook',
    });
    // deliberately no webhook() call for CRED_NO_WEBHOOK
    await cred(CRED_WRONG_BRANCH, {
      companyId: COMPANY,
      branchId: BRANCH_2,
      provider: 'tap-wrong-branch',
    });
    await webhook(CRED_WRONG_BRANCH);
    await cred(CRED_TENANT_WIDE, { companyId: null, branchId: null, provider: 'tap-tenant-wide' });
    await cred(CRED_COMPANY_ONLY, {
      companyId: COMPANY,
      branchId: null,
      provider: 'tap-company-only',
    });
    await cred(CRED_AMBIGUOUS_A, {
      companyId: COMPANY,
      branchId: BRANCH,
      provider: 'tap-ambiguous',
    });
    await webhook(CRED_AMBIGUOUS_A);
    await cred(CRED_AMBIGUOUS_B, {
      companyId: COMPANY,
      branchId: BRANCH,
      provider: 'tap-ambiguous',
    });
    await webhook(CRED_AMBIGUOUS_B);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  const uid = (): string => crypto.randomUUID();
  let seq = 0;

  async function insertOrder(
    overrides: { tenantId?: string; companyId?: string; branchId?: string } = {},
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [
        id,
        overrides.tenantId ?? TENANT,
        overrides.companyId ?? COMPANY,
        overrides.branchId ?? BRANCH,
        `fp-${id}`,
      ],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-E-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function insertInvoice(orderId: string, totalAmountMinor = 500n): Promise<string> {
    const invoiceId = uid();
    const lineId = uid();
    const { rows } = await pool.query<{
      tenantId: string;
      companyId: string;
      originBranchId: string;
    }>(`SELECT "tenantId", "companyId", "originBranchId" FROM "order" WHERE id = $1`, [orderId]);
    const o = rows[0]!;
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Rose','Rose Variant', now())`,
      [lineId, o.tenantId, o.companyId, orderId, PRODUCT, VARIANT, totalAmountMinor],
    );
    await confirmOrder(orderId);
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, $7, 0, 0, $7)`,
      [
        invoiceId,
        o.tenantId,
        o.companyId,
        o.originBranchId,
        orderId,
        `INV-E-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    return invoiceId;
  }

  async function freshInvoice(
    totalAmountMinor = 500n,
    overrides: { companyId?: string; branchId?: string } = {},
  ): Promise<string> {
    const orderId = await insertOrder(overrides);
    return insertInvoice(orderId, totalAmountMinor);
  }

  function ctx(overrides: { tenantId?: string; userId?: string | null } = {}): RequestContext {
    return new RequestContext({
      requestId: uid(),
      tenantId: overrides.tenantId ?? TENANT,
      userId: overrides.userId === undefined ? uid() : overrides.userId,
      accountType: 'USER',
    });
  }

  function makeAttemptRepo(
    registry: PaymentProviderRegistry,
    reservationOverride?: PaymentAttemptReservationRepository,
  ): PaymentAttemptRepository {
    return new PaymentAttemptRepository(
      db,
      reservationOverride ?? reservation,
      providerConfig,
      registry,
    );
  }

  async function countAttempts(idempotencyKey: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_attempt WHERE "idempotencyKey" = $1`,
      [idempotencyKey],
    );
    return Number(rows[0]!.n);
  }

  // ══════════════ §E25 — provider-config resolution security matrix ═══════
  describe('provider-config resolution (§E5/§E6/§E25)', () => {
    it('resolves a valid ACTIVE branch-scoped credential with a webhook mapping', async () => {
      const resolved = await runWithContext(ctx(), () =>
        providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'tap-ok'),
      );
      expect(resolved.providerCredentialId).toBe(CRED_OK);
      expect(resolved.providerKey).toBe('tap-ok');
      expect(resolved.mode).toBe('TEST');
      expect(resolved.webhookEndpointId).toBeTruthy();
      // §E6 — no secret material anywhere on the resolved/loggable shape.
      expect(Object.keys(resolved).sort()).toEqual(
        ['mode', 'providerCredentialId', 'providerKey', 'webhookEndpointId'].sort(),
      );
    });

    it('rejects a wrong-tenant credential (cross-tenant isolation)', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(
            OTHER_TENANT_COMPANY,
            OTHER_TENANT_BRANCH,
            'tap-ok',
          ),
        ),
      ).rejects.toThrow(DomainError);
    });

    it('rejects a wrong-company credential', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY_2, BRANCH, 'tap-ok'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_NOT_FOUND' });
    });

    it('rejects a wrong-branch credential (same company, different branch)', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'tap-wrong-branch'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_NOT_FOUND' });
      // it IS resolvable against its own real branch, proving the fixture itself is sound.
      const resolved = await runWithContext(ctx(), () =>
        providerConfig.resolveForBranchScoped(COMPANY, BRANCH_2, 'tap-wrong-branch'),
      );
      expect(resolved.providerCredentialId).toBe(CRED_WRONG_BRANCH);
    });

    it('rejects a tenant-wide credential (companyId/branchId both NULL)', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'tap-tenant-wide'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_NOT_FOUND' });
    });

    it('rejects a company-only credential (branchId NULL)', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'tap-company-only'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_NOT_FOUND' });
    });

    it('rejects a REVOKED credential', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'tap-revoked'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_NOT_FOUND' });
    });

    it('rejects a credential with no PaymentWebhookEndpoint mapping', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'tap-no-webhook'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_NOT_FOUND' });
    });

    it('rejects an unrecognized providerKey', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'no-such-provider'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_NOT_FOUND' });
    });

    it('FAILS CLOSED — ambiguous when more than one usable config matches', async () => {
      await expect(
        runWithContext(ctx(), () =>
          providerConfig.resolveForBranchScoped(COMPANY, BRANCH, 'tap-ambiguous'),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_CONFIG_AMBIGUOUS' });
    });
  });

  // ══════════════ §E8/§E9/§E11/§E14/§E15 — Phase 1 + Phase 2 primitives ════
  describe('reservation primitives (§E8/§E9/§E11/§E14/§E15)', () => {
    it('Phase 1 reserves PENDING and the reservation is visible on a SEPARATE connection immediately after commit (§E11)', async () => {
      const invoiceId = await freshInvoice(1000n);
      const idempotencyKey = `e11-${uid()}`;
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 300n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey,
        }),
      );
      expect(reserved.state).toBe('PENDING');
      expect(reserved.reused).toBe(false);

      // a genuinely separate pg connection (not `tx`, not `prisma`) — proves
      // Phase 1 truly committed and no Invoice lock is held across it.
      const { rows } = await pool.query(`SELECT "state" FROM payment_attempt WHERE "id" = $1`, [
        reserved.paymentAttemptId,
      ]);
      expect(rows[0]!.state).toBe('PENDING');
    });

    it('rejects an amount exceeding availableToCollect', async () => {
      const invoiceId = await freshInvoice(100n);
      await expect(
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.reserveAsyncAttemptInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 101n,
            providerKey: 'tap-ok',
            providerCredentialId: CRED_OK,
            createdByUserId: uid(),
            actingUserId: null,
            idempotencyKey: `e-reject-${uid()}`,
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE' });
    });

    it('rejects a non-provider-backed method (defense-in-depth against the async route)', async () => {
      const invoiceId = await freshInvoice(100n);
      await expect(
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.reserveAsyncAttemptInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'CASH',
            amountMinor: 10n,
            providerKey: 'tap-ok',
            providerCredentialId: CRED_OK,
            createdByUserId: uid(),
            actingUserId: null,
            idempotencyKey: `e-cash-${uid()}`,
          }),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_NOT_ALLOWED_FOR_ASYNC_ATTEMPT' });
    });

    it('Phase 2: REQUIRES_ACTION keeps the reservation ACTIVE with a SYSTEM event', async () => {
      const invoiceId = await freshInvoice(500n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 200n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e-ra-${uid()}`,
        }),
      );
      const applied = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.applyProviderInitiationResultInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          paymentAttemptId: reserved.paymentAttemptId,
          invoiceId,
          resultState: 'REQUIRES_ACTION',
          providerReference: 'ref-ra-1',
        }),
      );
      expect(applied.state).toBe('REQUIRES_ACTION');
      expect(applied.transitioned).toBe(true);
      const { rows } = await pool.query(
        `SELECT "fromState", "toState", "source" FROM payment_attempt_event WHERE "paymentAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fromState: 'PENDING',
        toState: 'REQUIRES_ACTION',
        source: 'SYSTEM',
      });
    });

    it('Phase 2: same-state PENDING->PENDING result is a no-op — no event written (§E15)', async () => {
      const invoiceId = await freshInvoice(500n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 200n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e-same-${uid()}`,
        }),
      );
      const applied = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.applyProviderInitiationResultInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          paymentAttemptId: reserved.paymentAttemptId,
          invoiceId,
          resultState: 'PENDING',
        }),
      );
      expect(applied.transitioned).toBe(false);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt_event WHERE "paymentAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      expect(rows[0]!.n).toBe(0);
    });

    for (const [from, to, releases] of [
      ['REQUIRES_ACTION', 'FAILED', true],
      ['REQUIRES_ACTION', 'CANCELED', true],
      ['PENDING', 'AUTHORIZED', false],
    ] as const) {
      it(`Phase 2: ${from} -> ${to} ${releases ? 'RELEASES' : 'keeps ACTIVE'} the reservation (§E16/§E22)`, async () => {
        const invoiceId = await freshInvoice(500n);
        const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.reserveAsyncAttemptInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 200n,
            providerKey: 'tap-ok',
            providerCredentialId: CRED_OK,
            createdByUserId: uid(),
            actingUserId: null,
            idempotencyKey: `e-fc-${uid()}`,
          }),
        );
        if (from !== 'PENDING') {
          await runScoped(prisma, { tenantId: TENANT }, (tx) =>
            reservation.applyProviderInitiationResultInTx(tx, {
              tenantId: TENANT,
              companyId: COMPANY,
              branchId: BRANCH,
              paymentAttemptId: reserved.paymentAttemptId,
              invoiceId,
              resultState: from,
            }),
          );
        }
        const applied = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.applyProviderInitiationResultInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            paymentAttemptId: reserved.paymentAttemptId,
            invoiceId,
            resultState: to,
          }),
        );
        expect(applied.state).toBe(to);
        // reservation-active proof: reserving the SAME amount again succeeds
        // only when the prior one was released.
        const secondInvoiceId = invoiceId; // same invoice, same available math
        const secondAttempt = runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.reserveAsyncAttemptInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId: secondInvoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 500n,
            providerKey: 'tap-ok',
            providerCredentialId: CRED_OK,
            createdByUserId: uid(),
            actingUserId: null,
            idempotencyKey: `e-fc-2nd-${uid()}`,
          }),
        );
        if (releases) {
          await expect(secondAttempt).resolves.toMatchObject({ state: 'PENDING' });
        } else {
          await expect(secondAttempt).rejects.toMatchObject({
            code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
          });
        }
      });
    }

    it('providerReference set-once: same value harmless, different value blocked (§E13/§E26)', async () => {
      const invoiceId = await freshInvoice(500n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 200n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e-ref-${uid()}`,
        }),
      );
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.applyProviderInitiationResultInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          paymentAttemptId: reserved.paymentAttemptId,
          invoiceId,
          resultState: 'REQUIRES_ACTION',
          providerReference: 'ref-set-once-1',
        }),
      );
      // same value again — harmless, no error, no state-change requirement.
      await expect(
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.applyProviderInitiationResultInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            paymentAttemptId: reserved.paymentAttemptId,
            invoiceId,
            resultState: 'REQUIRES_ACTION',
            providerReference: 'ref-set-once-1',
          }),
        ),
      ).resolves.toMatchObject({ transitioned: false });
      // a DIFFERENT replacement value is blocked by the DB trigger.
      await expect(
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.applyProviderInitiationResultInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            paymentAttemptId: reserved.paymentAttemptId,
            invoiceId,
            resultState: 'AUTHORIZED',
            providerReference: 'ref-DIFFERENT',
          }),
        ),
      ).rejects.toThrow();
    });

    it('the SAME non-null providerReference cannot be reused across attempts under the SAME credential (§E7/§E26)', async () => {
      const invoiceA = await freshInvoice(500n);
      const invoiceB = await freshInvoice(500n);
      const a = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId: invoiceA,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e-dup-a-${uid()}`,
        }),
      );
      const b = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId: invoiceB,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e-dup-b-${uid()}`,
        }),
      );
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.applyProviderInitiationResultInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          paymentAttemptId: a.paymentAttemptId,
          invoiceId: invoiceA,
          resultState: 'REQUIRES_ACTION',
          providerReference: 'shared-ref-under-same-credential',
        }),
      );
      await expect(
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.applyProviderInitiationResultInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            paymentAttemptId: b.paymentAttemptId,
            invoiceId: invoiceB,
            resultState: 'REQUIRES_ACTION',
            providerReference: 'shared-ref-under-same-credential',
          }),
        ),
      ).rejects.toThrow();
    });

    it('NULL providerReference may exist on multiple attempts', async () => {
      const invoiceId = await freshInvoice(500n);
      const first = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 50n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e-null-1-${uid()}`,
        }),
      );
      const second = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 50n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e-null-2-${uid()}`,
        }),
      );
      expect(first.paymentAttemptId).not.toBe(second.paymentAttemptId);
    });
  });

  // ══════════════ §E12/§E16/§E17/§E18/§E23/§E24 — full orchestration ═══════
  describe('orchestration — PaymentAttemptRepository (§E12/§E16-E18/§E23/§E24)', () => {
    it('resolved AUTHORIZED result: applies Phase 2 and returns it', async () => {
      const invoiceId = await freshInvoice(500n);
      const registry = new PaymentProviderRegistry();
      const key = `orc-auth-${uid()}`;
      registry.register(
        key,
        fakeAdapter({ kind: 'result', result: { state: 'AUTHORIZED', providerReference: 'r1' } }),
      );
      await pool.query(
        `INSERT INTO provider_credential
           (id, "tenantId", "companyId", "branchId", provider, mode, status,
            "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
         VALUES (uuidv7(), $1, $2, $3, $4, 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
         RETURNING id`,
        [TENANT, COMPANY, BRANCH, key],
      );
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM provider_credential WHERE provider = $1`,
        [key],
      );
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         SELECT uuidv7(), "tenantId", "companyId", "branchId", id FROM provider_credential WHERE id = $1`,
        [rows[0]!.id],
      );
      const repo = makeAttemptRepo(registry);
      const result = await runWithContext(ctx(), () =>
        repo.createAsyncAttemptForBranchScoped({
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 200n,
          providerKey: key,
          idempotencyKey: `orc-auth-key-${uid()}`,
        }),
      );
      expect(result.state).toBe('AUTHORIZED');
    });

    it('malformed CAPTURED initiation result throws PAYMENT_PROVIDER_OUTCOME_UNKNOWN, never creates Payment/Allocation/attempt-CAPTURED — stays PENDING (§E12/owner recovery-pass §4)', async () => {
      const invoiceId = await freshInvoice(500n);
      const registry = new PaymentProviderRegistry();
      const key = `orc-malformed-${uid()}`;
      const captured = { state: 'CAPTURED' } as unknown as PaymentProviderInitiationResult;
      registry.register(key, fakeAdapter({ kind: 'result', result: captured }));
      await insertCredWithWebhook(key);
      const repo = makeAttemptRepo(registry);
      const idempotencyKey = `orc-malformed-key-${uid()}`;
      let attemptId: string | undefined;
      try {
        await runWithContext(ctx(), () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 200n,
            providerKey: key,
            idempotencyKey,
          }),
        );
        expect.unreachable('a malformed CAPTURED result must not resolve successfully');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('PAYMENT_PROVIDER_OUTCOME_UNKNOWN');
        attemptId = (err as DomainError).details?.[0]?.issue;
        expect(attemptId).toBeTruthy();
      }
      const { rows: paymentRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment WHERE "sourceAttemptId" = $1`,
        [attemptId],
      );
      expect(paymentRows[0]!.n).toBe(0);
      const { rows: attemptRows } = await pool.query(
        `SELECT "state" FROM payment_attempt WHERE id = $1`,
        [attemptId],
      );
      expect(attemptRows[0]!.state).toBe('PENDING');
    });

    it('ambiguous transport failure keeps PENDING and is retryable; the SAME key recovers the SAME attempt and MAY call the provider again (owner recovery-pass §4/§10)', async () => {
      const invoiceId = await freshInvoice(500n);
      const registry = new PaymentProviderRegistry();
      const key = `orc-throws-${uid()}`;
      // throws on the first call, then reconciles to ONE fixed logical
      // intent forever after — modelling a retry-safe adapter (§2).
      const adapter = fakeSequenceAdapter([
        { kind: 'throws' },
        {
          kind: 'result',
          result: { state: 'REQUIRES_ACTION', providerReference: 'orc-throws-ref' },
        },
      ]);
      registry.register(key, adapter);
      await insertCredWithWebhook(key);
      const repo = makeAttemptRepo(registry);
      const idempotencyKey = `orc-throws-key-${uid()}`;
      const actorId = uid();

      let attemptId: string | undefined;
      try {
        await runWithContext(ctx({ userId: actorId }), () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 150n,
            providerKey: key,
            idempotencyKey,
          }),
        );
        expect.unreachable('an ambiguous outcome must not resolve successfully');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('PAYMENT_PROVIDER_OUTCOME_UNKNOWN');
        attemptId = (err as DomainError).details?.[0]?.issue;
      }
      expect(adapter.callCount).toBe(1);
      const { rows: pendingRows } = await pool.query(
        `SELECT "state" FROM payment_attempt WHERE id = $1`,
        [attemptId],
      );
      expect(pendingRows[0]!.state).toBe('PENDING');

      // retry — same key, same body. Recovers the SAME attempt (never mints
      // a second one) and is explicitly allowed to call the provider again
      // (the important invariant is one logical provider intent, not one
      // network function invocation, owner recovery-pass §10).
      const retry = await runWithContext(ctx({ userId: actorId }), () =>
        repo.createAsyncAttemptForBranchScoped({
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 150n,
          providerKey: key,
          idempotencyKey,
        }),
      );
      expect(retry.paymentAttemptId).toBe(attemptId);
      expect(retry.state).toBe('REQUIRES_ACTION');
      expect(adapter.callCount).toBe(2);
      expect(await countAttempts(idempotencyKey)).toBe(1); // exactly one attempt, never a second
    });

    it('Phase-2 persist failure after a successful provider call, then retry succeeds with the SAME providerReference exactly once (owner recovery-pass §8, the 13-step scenario)', async () => {
      const invoiceId = await freshInvoice(500n);
      const registry = new PaymentProviderRegistry();
      const key = `orc-persist-fail-${uid()}`;
      // (2) createIntent succeeds provider-side and returns a FIXED
      //     providerReference R on every call — a retry-safe adapter
      //     reconciling to the SAME logical intent (owner §2).
      const adapter = fakeAdapter({
        kind: 'result',
        result: { state: 'AUTHORIZED', providerReference: 'R-recovered' },
      });
      registry.register(key, adapter);
      await insertCredWithWebhook(key);

      // (3) Phase 2 deliberately fails on its FIRST invocation for a given
      //     attempt, then behaves normally — modelling "the DB application
      //     fails before persisting R/state" followed by a real recovery.
      class Phase2FailsOnce extends PaymentAttemptReservationRepository {
        private readonly failedOnce = new Set<string>();
        override async applyProviderInitiationResultInTx(
          tx: ScopedTx,
          input: ApplyProviderInitiationResultInput,
        ) {
          if (!this.failedOnce.has(input.paymentAttemptId)) {
            this.failedOnce.add(input.paymentAttemptId);
            throw new Error('simulated one-time Phase 2 DB application failure');
          }
          return super.applyProviderInitiationResultInTx(tx, input);
        }
      }
      const repo = makeAttemptRepo(
        registry,
        new Phase2FailsOnce(new AuditWriter(db), new OutboxWriter(db)),
      );
      const idempotencyKey = `orc-persist-fail-key-${uid()}`;
      const actorId = uid();
      const requestBody = {
        companyId: COMPANY,
        branchId: BRANCH,
        invoiceId,
        method: 'ONLINE_GATEWAY' as const,
        amountMinor: 150n,
        providerKey: key,
        idempotencyKey,
      };

      // (1)-(4) Phase 1 commits attempt A; createIntent(A) succeeds; Phase 2
      //         fails before persisting — the request as a whole is a
      //         retryable failure (§4), never a silent 202.
      let attemptId: string | undefined;
      try {
        await runWithContext(ctx({ userId: actorId }), () =>
          repo.createAsyncAttemptForBranchScoped(requestBody),
        );
        expect.unreachable('a Phase-2 persist failure must not resolve successfully');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('PAYMENT_PROVIDER_OUTCOME_UNKNOWN');
        attemptId = (err as DomainError).details?.[0]?.issue;
      }
      expect(adapter.callCount).toBe(1);

      // original attempt still exists, still PENDING, no providerReference leaked in
      const { rows } = await pool.query(
        `SELECT "state", "providerReference" FROM payment_attempt WHERE id = $1`,
        [attemptId],
      );
      expect(rows[0]).toMatchObject({ state: 'PENDING', providerReference: null });
      const { rows: paymentRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment WHERE "sourceAttemptId" = $1`,
        [attemptId],
      );
      expect(paymentRows[0]!.n).toBe(0);

      // (5)-(9) retry — SAME key + SAME body. Phase 1 finds attempt A (not a
      //         new one), createIntent is invoked again with the SAME
      //         paymentAttemptId, the retry-safe fake returns the SAME
      //         logical intent (R-recovered), and Phase 2 now succeeds.
      const retry = await runWithContext(ctx({ userId: actorId }), () =>
        repo.createAsyncAttemptForBranchScoped(requestBody),
      );
      expect(retry.paymentAttemptId).toBe(attemptId);
      expect(retry.state).toBe('AUTHORIZED');
      expect(adapter.callCount).toBe(2);

      // (10)-(13) exactly one attempt exists, providerReference is R, the
      //           transition/event occurred exactly once, zero duplicate
      //           Payment/Allocation.
      expect(await countAttempts(idempotencyKey)).toBe(1);
      const { rows: finalRows } = await pool.query(
        `SELECT "state", "providerReference" FROM payment_attempt WHERE id = $1`,
        [attemptId],
      );
      expect(finalRows[0]).toMatchObject({ state: 'AUTHORIZED', providerReference: 'R-recovered' });
      const { rows: eventRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt_event WHERE "paymentAttemptId" = $1`,
        [attemptId],
      );
      expect(eventRows[0]!.n).toBe(1);
      const { rows: finalPaymentRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment WHERE "sourceAttemptId" = $1`,
        [attemptId],
      );
      expect(finalPaymentRows[0]!.n).toBe(0);
    });

    it('a REUSED, already-resolved attempt never invokes the provider a second time (owner recovery-pass §5)', async () => {
      const invoiceId = await freshInvoice(500n);
      const registry = new PaymentProviderRegistry();
      const key = `orc-reuse-${uid()}`;
      // a DEFINITIVE (non-PENDING) result — already durably applied by the
      // first call, so a replay must short-circuit before ever reaching the
      // adapter again (a confirmed-PENDING result would NOT give this
      // guarantee — see the module doc comment on `reserved.state !==
      // 'PENDING'` in `payment-attempt.repository.ts`).
      const adapter = fakeAdapter({
        kind: 'result',
        result: { state: 'REQUIRES_ACTION', providerReference: 'orc-reuse-ref' },
      });
      registry.register(key, adapter);
      await insertCredWithWebhook(key);
      const repo = makeAttemptRepo(registry);
      const idempotencyKey = `orc-reuse-key-${uid()}`;
      const actorId = uid();

      const first = await runWithContext(ctx({ userId: actorId }), () =>
        repo.createAsyncAttemptForBranchScoped({
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey: key,
          idempotencyKey,
        }),
      );
      const second = await runWithContext(ctx({ userId: actorId }), () =>
        repo.createAsyncAttemptForBranchScoped({
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey: key,
          idempotencyKey,
        }),
      );
      expect(second.paymentAttemptId).toBe(first.paymentAttemptId);
      expect(second.state).toBe('REQUIRES_ACTION');
      expect(adapter.callCount).toBe(1);
    });

    it('crash BEFORE the provider call is ever made: retry recovers the SAME attempt and completes it (owner recovery-pass §9, liveness proof)', async () => {
      const invoiceId = await freshInvoice(500n);
      const registry = new PaymentProviderRegistry();
      const key = `orc-crash-${uid()}`;
      const adapter = fakeAdapter({
        kind: 'result',
        result: { state: 'AUTHORIZED', providerReference: 'orc-crash-ref' },
      });
      registry.register(key, adapter);
      const credentialId = await insertCredWithWebhook(key);
      const idempotencyKey = `orc-crash-key-${uid()}`;
      const actorId = uid();

      // (1)/(2) Phase 1 commits PENDING attempt A directly — simulating a
      //         process crash strictly BEFORE createIntent is ever invoked
      //         (the orchestration's external call never runs at all).
      const phase1Only = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 90n,
          providerKey: key,
          providerCredentialId: credentialId,
          createdByUserId: actorId,
          actingUserId: actorId,
          idempotencyKey,
        }),
      );
      expect(phase1Only.state).toBe('PENDING');
      expect(adapter.callCount).toBe(0);

      // (3) retry — same Idempotency-Key + same semantic request, through
      //     the FULL orchestration this time.
      const repo = makeAttemptRepo(registry);
      const recovered = await runWithContext(ctx({ userId: actorId }), () =>
        repo.createAsyncAttemptForBranchScoped({
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 90n,
          providerKey: key,
          idempotencyKey,
        }),
      );

      // (4)-(7) the SAME attempt A is found, createIntent is invoked using
      //         it, the result persists normally, no second attempt exists.
      expect(recovered.paymentAttemptId).toBe(phase1Only.paymentAttemptId);
      expect(recovered.state).toBe('AUTHORIZED');
      expect(adapter.callCount).toBe(1);
      expect(await countAttempts(idempotencyKey)).toBe(1);
    });

    // ══════════ §11 — DB-fallback different-payload hard gates (checked
    // specifically AFTER any shared HTTP idempotency state is gone — every
    // call in this file already bypasses the HTTP layer entirely, so this
    // is exactly that condition). ═══════════════════════════════════════
    describe('DB-fallback semantic-identity hard gates (owner recovery-pass §11)', () => {
      it('Example A: same key, DIFFERENT amount -> 409 IDEMPOTENCY_KEY_REUSED; original attempt unchanged, no provider call for the new amount', async () => {
        const invoiceId = await freshInvoice(500n);
        const registry = new PaymentProviderRegistry();
        const key = `orc-db-a-${uid()}`;
        const adapter = fakeAdapter({
          kind: 'result',
          result: { state: 'REQUIRES_ACTION', providerReference: 'orc-db-a-ref' },
        });
        registry.register(key, adapter);
        await insertCredWithWebhook(key);
        const repo = makeAttemptRepo(registry);
        const idempotencyKey = `orc-db-a-key-${uid()}`;
        const actorId = uid();

        const first = await runWithContext(ctx({ userId: actorId }), () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 60n,
            providerKey: key,
            idempotencyKey,
          }),
        );
        expect(adapter.callCount).toBe(1);

        await expect(
          runWithContext(ctx({ userId: actorId }), () =>
            repo.createAsyncAttemptForBranchScoped({
              companyId: COMPANY,
              branchId: BRANCH,
              invoiceId,
              method: 'ONLINE_GATEWAY',
              amountMinor: 70n,
              providerKey: key,
              idempotencyKey,
            }),
          ),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

        expect(adapter.callCount).toBe(1); // no provider call for the 70 request
        const { rows } = await pool.query(
          `SELECT "amountMinor"::text AS "amountMinor" FROM payment_attempt WHERE id = $1`,
          [first.paymentAttemptId],
        );
        expect(rows[0]!.amountMinor).toBe('60');
        expect(await countAttempts(idempotencyKey)).toBe(1);
      });

      it('Example B: same key, same amount, DIFFERENT invoice -> 409 IDEMPOTENCY_KEY_REUSED', async () => {
        const invoiceA = await freshInvoice(500n);
        const invoiceB = await freshInvoice(500n);
        const registry = new PaymentProviderRegistry();
        const key = `orc-db-b-${uid()}`;
        registry.register(
          key,
          fakeAdapter({ kind: 'result', result: { state: 'REQUIRES_ACTION' } }),
        );
        await insertCredWithWebhook(key);
        const repo = makeAttemptRepo(registry);
        const idempotencyKey = `orc-db-b-key-${uid()}`;
        const actorId = uid();

        await runWithContext(ctx({ userId: actorId }), () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId: invoiceA,
            method: 'ONLINE_GATEWAY',
            amountMinor: 50n,
            providerKey: key,
            idempotencyKey,
          }),
        );
        await expect(
          runWithContext(ctx({ userId: actorId }), () =>
            repo.createAsyncAttemptForBranchScoped({
              companyId: COMPANY,
              branchId: BRANCH,
              invoiceId: invoiceB,
              method: 'ONLINE_GATEWAY',
              amountMinor: 50n,
              providerKey: key,
              idempotencyKey,
            }),
          ),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });

      it('Example C: same invoice/amount, DIFFERENT providerKey -> 409 IDEMPOTENCY_KEY_REUSED', async () => {
        const invoiceId = await freshInvoice(500n);
        const registry = new PaymentProviderRegistry();
        const keyA = `orc-db-c-a-${uid()}`;
        const keyB = `orc-db-c-b-${uid()}`;
        registry.register(
          keyA,
          fakeAdapter({ kind: 'result', result: { state: 'REQUIRES_ACTION' } }),
        );
        registry.register(
          keyB,
          fakeAdapter({ kind: 'result', result: { state: 'REQUIRES_ACTION' } }),
        );
        await insertCredWithWebhook(keyA);
        await insertCredWithWebhook(keyB);
        const repo = makeAttemptRepo(registry);
        const idempotencyKey = `orc-db-c-key-${uid()}`;
        const actorId = uid();

        await runWithContext(ctx({ userId: actorId }), () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 50n,
            providerKey: keyA,
            idempotencyKey,
          }),
        );
        await expect(
          runWithContext(ctx({ userId: actorId }), () =>
            repo.createAsyncAttemptForBranchScoped({
              companyId: COMPANY,
              branchId: BRANCH,
              invoiceId,
              method: 'ONLINE_GATEWAY',
              amountMinor: 50n,
              providerKey: keyB,
              idempotencyKey,
            }),
          ),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });

      it('Example D: same semantic request, same key -> recovers the existing attempt (not a new one)', async () => {
        const invoiceId = await freshInvoice(500n);
        const registry = new PaymentProviderRegistry();
        const key = `orc-db-d-${uid()}`;
        const adapter = fakeAdapter({
          kind: 'result',
          result: { state: 'AUTHORIZED', providerReference: 'orc-db-d-ref' },
        });
        registry.register(key, adapter);
        await insertCredWithWebhook(key);
        const repo = makeAttemptRepo(registry);
        const idempotencyKey = `orc-db-d-key-${uid()}`;
        const actorId = uid();
        const body = {
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY' as const,
          amountMinor: 80n,
          providerKey: key,
          idempotencyKey,
        };

        const first = await runWithContext(ctx({ userId: actorId }), () =>
          repo.createAsyncAttemptForBranchScoped(body),
        );
        const second = await runWithContext(ctx({ userId: actorId }), () =>
          repo.createAsyncAttemptForBranchScoped(body),
        );
        expect(second.paymentAttemptId).toBe(first.paymentAttemptId);
        expect(await countAttempts(idempotencyKey)).toBe(1);
      });
    });

    it('scope isolation: wrong company/branch/tenant cannot reserve against this invoice (§E20)', async () => {
      const invoiceId = await freshInvoice(500n);
      const registry = new PaymentProviderRegistry();
      const repo = makeAttemptRepo(registry);
      await expect(
        runWithContext(ctx(), () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY_2,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 10n,
            providerKey: 'tap-ok',
            idempotencyKey: `e20-wrong-company-${uid()}`,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        runWithContext(ctx({ tenantId: OTHER_TENANT }), () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: OTHER_TENANT_COMPANY,
            branchId: OTHER_TENANT_BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 10n,
            providerKey: 'tap-ok',
            idempotencyKey: `e20-wrong-tenant-${uid()}`,
          }),
        ),
      ).rejects.toThrow();
    });

    async function insertCredWithWebhook(providerKey: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO provider_credential
           (id, "tenantId", "companyId", "branchId", provider, mode, status,
            "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
         VALUES (uuidv7(), $1, $2, $3, $4, 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
         RETURNING id`,
        [TENANT, COMPANY, BRANCH, providerKey],
      );
      const id = rows[0]!.id;
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         SELECT uuidv7(), "tenantId", "companyId", "branchId", id FROM provider_credential WHERE id = $1`,
        [id],
      );
      return id;
    }
  });

  // ══════════════ §E21 — concurrent reservation hard gates ═════════════════
  describe('concurrency hard gates (§E21)', () => {
    it('A: two concurrent async attempts for the FULL available amount — exactly one reserves', async () => {
      const invoiceId = await freshInvoice(100n);
      const results = await inParallel(2, () =>
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.reserveAsyncAttemptInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 100n,
            providerKey: 'tap-ok',
            providerCredentialId: CRED_OK,
            createdByUserId: uid(),
            actingUserId: null,
            idempotencyKey: `e21a-${uid()}-${Math.random()}`,
          }),
        ),
      );
      const s = summarize(results);
      expect(s.fulfilledCount).toBe(1);
      expect(s.rejectedCount).toBe(1);
      const rejection = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect((rejection.reason as DomainError).code).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1 AND state = 'PENDING'`,
        [invoiceId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('B: after a 60 async reservation, local CASH 40 succeeds and CASH 41 rejects', async () => {
      const invoiceId = await freshInvoice(100n);
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 60n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e21b-${uid()}`,
        }),
      );
      const { PaymentCollectionRepository } = await import('./payment-collection.repository.js');
      const collection = new PaymentCollectionRepository(new AuditWriter(db), new OutboxWriter(db));
      const capture = (amountMinor: bigint) =>
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          collection.captureSingleTenderInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'CASH',
            amountMinor,
            createdByUserId: null,
            actingUserId: null,
            idempotencyKey: `e21b-cash-${uid()}`,
          }),
        );
      await expect(capture(41n)).rejects.toMatchObject({
        code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
      });
      await expect(capture(40n)).resolves.toMatchObject({ amountMinor: 40n });
    });

    for (const state of ['REQUIRES_ACTION', 'AUTHORIZED'] as const) {
      it(`D/E: async 60 reaches ${state} — local CASH 41 rejects, CASH 40 succeeds`, async () => {
        const invoiceId = await freshInvoice(100n);
        const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.reserveAsyncAttemptInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 60n,
            providerKey: 'tap-ok',
            providerCredentialId: CRED_OK,
            createdByUserId: uid(),
            actingUserId: null,
            idempotencyKey: `e21de-${state}-${uid()}`,
          }),
        );
        await runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.applyProviderInitiationResultInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            paymentAttemptId: reserved.paymentAttemptId,
            invoiceId,
            resultState: state,
          }),
        );
        const { PaymentCollectionRepository } = await import('./payment-collection.repository.js');
        const collection = new PaymentCollectionRepository(
          new AuditWriter(db),
          new OutboxWriter(db),
        );
        const capture = (amountMinor: bigint) =>
          runScoped(prisma, { tenantId: TENANT }, (tx) =>
            collection.captureSingleTenderInTx(tx, {
              tenantId: TENANT,
              companyId: COMPANY,
              branchId: BRANCH,
              invoiceId,
              method: 'CASH',
              amountMinor,
              createdByUserId: null,
              actingUserId: null,
              idempotencyKey: `e21de-cash-${state}-${uid()}`,
            }),
          );
        await expect(capture(41n)).rejects.toMatchObject({
          code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
        });
        await expect(capture(40n)).resolves.toMatchObject({ amountMinor: 40n });
      });
    }

    it('C: async 60 receives definitive FAILED — reservation releases — later local CASH 100 succeeds', async () => {
      const invoiceId = await freshInvoice(100n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 60n,
          providerKey: 'tap-ok',
          providerCredentialId: CRED_OK,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `e21c-${uid()}`,
        }),
      );
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.applyProviderInitiationResultInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          paymentAttemptId: reserved.paymentAttemptId,
          invoiceId,
          resultState: 'FAILED',
        }),
      );
      const { PaymentCollectionRepository } = await import('./payment-collection.repository.js');
      const collection = new PaymentCollectionRepository(new AuditWriter(db), new OutboxWriter(db));
      const result = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        collection.captureSingleTenderInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'CASH',
          amountMinor: 100n,
          createdByUserId: null,
          actingUserId: null,
          idempotencyKey: `e21c-cash-${uid()}`,
        }),
      );
      expect(result.amountMinor).toBe(100n);
    });
  });
});
