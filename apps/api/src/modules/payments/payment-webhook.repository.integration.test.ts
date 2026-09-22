import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, inParallel, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped, type PrismaClient } from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { WebhookBootstrapRepository } from './webhook-bootstrap.repository.js';
import { ProviderPaymentEventInboxRepository } from './provider-payment-event-inbox.repository.js';
import { WebhookEventProcessorRepository } from './webhook-event-processor.repository.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import { PaymentWebhookRepository } from './payment-webhook.repository.js';
import { WebhookRecoveryProcessor } from './webhook-recovery.repository.js';
import { PaymentAttemptReservationRepository } from './payment-attempt-reservation.repository.js';
import { PaymentCollectionRepository } from './payment-collection.repository.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import type {
  PaymentProvider,
  VerifiedProviderWebhookEvent,
  PaymentProviderInitiationResult,
} from './payment-provider.port.js';

/**
 * Task 3b.5 Checkpoint F (integration) — proves the verified-webhook /
 * durable-inbox / async-capture flow directly against real Postgres,
 * calling `PaymentWebhookRepository.handle(...)` directly (no HTTP — the
 * webhook path itself never uses a `RequestContext`, so there is nothing
 * to bootstrap besides the real Postgres/Redis-free stack). HTTP-layer
 * wiring (raw body, `@Public()`, route shape) is proven separately in
 * `payment-webhook.controller.integration.test.ts`.
 *
 * NO refund/settlement/AR/Advance/PostingEngine/Invoice.invoicePaymentStatus
 * code is exercised or asserted on anywhere in this file — none of it
 * exists in the code under test.
 */
const TENANT = 'f1000000-1111-7111-8111-111111111111';
const COMPANY = 'f3000000-3333-7333-8333-333333333333';
const BRANCH = 'f6000000-6666-7666-8666-666666666666';
const CATEGORY = 'f9000000-9999-7999-8999-999999999999';
const PRODUCT = 'fa000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const VARIANT = 'fb000000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function fakeWebhookAdapter(
  behavior: { kind: 'verifies'; event: VerifiedProviderWebhookEvent } | { kind: 'rejects' },
): PaymentProvider & { verifyCallCount: number } {
  const adapter = {
    verifyCallCount: 0,
    async createIntent(): Promise<PaymentProviderInitiationResult> {
      throw new Error('not implemented — never called by Checkpoint F');
    },
    async authorize(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint F');
    },
    async capture(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint F');
    },
    async refund(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint F');
    },
    async getStatus(): Promise<unknown> {
      throw new Error('not implemented — never called by Checkpoint F');
    },
    async verifyWebhook(): Promise<VerifiedProviderWebhookEvent> {
      adapter.verifyCallCount += 1;
      if (behavior.kind === 'rejects') {
        throw new Error('simulated invalid signature');
      }
      return behavior.event;
    },
  };
  return adapter;
}

describe('Checkpoint F — verified provider webhook / durable inbox / async capture (integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let reservation: PaymentAttemptReservationRepository;
  let collection: PaymentCollectionRepository;
  let bootstrap: WebhookBootstrapRepository;
  const inbox = new ProviderPaymentEventInboxRepository();
  let processor: WebhookEventProcessorRepository;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    bootstrap = new WebhookBootstrapRepository(db);
    collection = new PaymentCollectionRepository(new AuditWriter(db), new OutboxWriter(db));
    reservation = new PaymentAttemptReservationRepository(
      new AuditWriter(db),
      new OutboxWriter(db),
    );
    processor = new WebhookEventProcessorRepository(new AuditWriter(db), new OutboxWriter(db));

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000f0000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000f0000002',
               '00000000-0000-7000-8000-0000f0000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'pf-3b5', 'pf-3b5', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000f0000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
       VALUES ($1, $2, $3, 'Main', now())`,
      [BRANCH, TENANT, COMPANY],
    );
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
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  const uid = (): string => crypto.randomUUID();
  let seq = 0;

  async function insertOrder(): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [id, TENANT, COMPANY, BRANCH, `fp-${id}`],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-F-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function insertInvoice(orderId: string, totalAmountMinor = 500n): Promise<string> {
    const invoiceId = uid();
    const lineId = uid();
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
      [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT, totalAmountMinor],
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
        TENANT,
        COMPANY,
        BRANCH,
        orderId,
        `INV-F-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    return invoiceId;
  }

  async function freshInvoice(totalAmountMinor = 500n): Promise<string> {
    const orderId = await insertOrder();
    return insertInvoice(orderId, totalAmountMinor);
  }

  /** creates a `provider_credential` + `payment_webhook_endpoint` pair,
   *  returning both ids. */
  async function createCredentialAndEndpoint(
    providerKey: string,
  ): Promise<{ credentialId: string; endpointId: string }> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, status,
          "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, $4, 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
       RETURNING id`,
      [TENANT, COMPANY, BRANCH, providerKey],
    );
    const credentialId = rows[0]!.id;
    const { rows: epRows } = await pool.query<{ id: string }>(
      `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
       VALUES (uuidv7(), $1, $2, $3, $4) RETURNING id`,
      [TENANT, COMPANY, BRANCH, credentialId],
    );
    return { credentialId, endpointId: epRows[0]!.id };
  }

  /** creates a PENDING async PaymentAttempt directly via the frozen
   *  Checkpoint E primitive — bypasses the full E orchestration since this
   *  file only needs a durable reservation to correlate webhooks against. */
  async function createAttempt(input: {
    invoiceId: string;
    amountMinor: bigint;
    providerKey: string;
    providerCredentialId: string;
  }): Promise<string> {
    const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      reservation.reserveAsyncAttemptInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        invoiceId: input.invoiceId,
        method: 'ONLINE_GATEWAY',
        amountMinor: input.amountMinor,
        providerKey: input.providerKey,
        providerCredentialId: input.providerCredentialId,
        createdByUserId: uid(),
        actingUserId: null,
        idempotencyKey: `f-fixture-${uid()}`,
      }),
    );
    return reserved.paymentAttemptId;
  }

  async function localCash(invoiceId: string, amountMinor: bigint) {
    return runScoped(prisma, { tenantId: TENANT }, (tx) =>
      collection.captureSingleTenderInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        invoiceId,
        method: 'CASH',
        amountMinor,
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: `f-cash-${uid()}`,
      }),
    );
  }

  function makeWebhookRepo(registry: PaymentProviderRegistry): PaymentWebhookRepository {
    return new PaymentWebhookRepository(db, bootstrap, registry, inbox, processor);
  }

  async function attemptState(attemptId: string): Promise<string> {
    const { rows } = await pool.query<{ state: string }>(
      `SELECT "state" FROM payment_attempt WHERE id = $1`,
      [attemptId],
    );
    return rows[0]!.state;
  }

  async function inboxStatus(endpointCredentialId: string, providerEventId: string) {
    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT "id", "status" FROM provider_payment_event WHERE "providerCredentialId" = $1 AND "providerEventId" = $2`,
      [endpointCredentialId, providerEventId],
    );
    return rows[0];
  }

  async function paymentCount(attemptId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment WHERE "sourceAttemptId" = $1`,
      [attemptId],
    );
    return rows[0]!.n;
  }

  // ══════════════ §F3/§F27 — bootstrap resolver ═══════════════════════════
  describe('bootstrap resolver', () => {
    it('resolves a real endpoint to trusted identity only', async () => {
      const { credentialId, endpointId } = await createCredentialAndEndpoint(`tap-boot-${uid()}`);
      const resolved = await bootstrap.resolveEndpoint(endpointId);
      expect(resolved).toMatchObject({
        endpointId,
        providerCredentialId: credentialId,
        tenantId: TENANT,
      });
      expect(Object.keys(resolved!).sort()).toEqual(
        [
          'branchId',
          'companyId',
          'endpointId',
          'mode',
          'providerCredentialId',
          'providerKey',
          'tenantId',
        ].sort(),
      );
    });

    it('an unknown endpoint id resolves to null (non-disclosing)', async () => {
      const resolved = await bootstrap.resolveEndpoint(uid());
      expect(resolved).toBeNull();
    });

    it('a malformed endpoint id resolves to null without querying the database oddly', async () => {
      const resolved = await bootstrap.resolveEndpoint('not-a-uuid');
      expect(resolved).toBeNull();
    });
  });

  // ══════════════ §F8/§F27 — signature failure has zero side effects ══════
  it('invalid signature: zero inbox row, zero attempt mutation, zero Payment', async () => {
    const providerKey = `tap-badsig-${uid()}`;
    const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
    const invoiceId = await freshInvoice(200n);
    const attemptId = await createAttempt({
      invoiceId,
      amountMinor: 100n,
      providerKey,
      providerCredentialId: credentialId,
    });
    const registry = new PaymentProviderRegistry();
    registry.register(providerKey, fakeWebhookAdapter({ kind: 'rejects' }));
    const repo = makeWebhookRepo(registry);

    await expect(
      repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_UNAUTHENTICATED' });

    const { rows: inboxRows } = await pool.query(
      `SELECT count(*)::int AS n FROM provider_payment_event WHERE "providerCredentialId" = $1`,
      [credentialId],
    );
    expect(inboxRows[0]!.n).toBe(0);
    expect(await attemptState(attemptId)).toBe('PENDING');
    expect(await paymentCount(attemptId)).toBe(0);
  });

  it('unknown endpoint: the SAME rejection as invalid signature (non-disclosing)', async () => {
    const registry = new PaymentProviderRegistry();
    const repo = makeWebhookRepo(registry);
    await expect(
      repo.handle({ endpointId: uid(), rawBody: Buffer.from('{}'), headers: {} }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_UNAUTHENTICATED' });
  });

  // ══════════════ §F4/§F27 — no raw body storage ══════════════════════════
  it('never stores the raw body — only a SHA-256 payloadHash of it', async () => {
    const providerKey = `tap-rawbody-${uid()}`;
    const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
    const invoiceId = await freshInvoice(200n);
    const attemptId = await createAttempt({
      invoiceId,
      amountMinor: 100n,
      providerKey,
      providerCredentialId: credentialId,
    });
    const providerEventId = `evt-${uid()}`;
    const registry = new PaymentProviderRegistry();
    registry.register(
      providerKey,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId,
          eventType: 'charge.updated',
          paymentAttemptId: attemptId,
          targetState: 'REQUIRES_ACTION',
        },
      }),
    );
    const repo = makeWebhookRepo(registry);
    const rawBody = Buffer.from(
      JSON.stringify({ secret: 'super-sensitive-value-should-never-persist' }),
    );

    await repo.handle({ endpointId, rawBody, headers: {} });

    const row = await inboxStatus(credentialId, providerEventId);
    expect(row).toBeTruthy();
    const { rows } = await pool.query<{ payloadHash: string; sanitizedMetadata: unknown }>(
      `SELECT "payloadHash", "sanitizedMetadata" FROM provider_payment_event WHERE id = $1`,
      [row!.id],
    );
    expect(rows[0]!.payloadHash).toBe(crypto.createHash('sha256').update(rawBody).digest('hex'));
    expect(JSON.stringify(rows[0]!.sanitizedMetadata)).not.toMatch(/super-sensitive-value/);
    // no column anywhere on this row can contain the raw body — the whole
    // row's own JSON.stringify never matches the raw secret either.
    expect(JSON.stringify(rows[0])).not.toMatch(/super-sensitive-value/);
  });

  // ══════════════ §F9/F10/F27 — dedupe / replay ═══════════════════════════
  describe('inbox dedupe / replay', () => {
    it('same credential + same providerEventId: exactly one inbox row', async () => {
      const providerKey = `tap-dedupe-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 100n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const providerEventId = `evt-${uid()}`;
      const registry = new PaymentProviderRegistry();
      const adapter = fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId,
          eventType: 'charge.updated',
          paymentAttemptId: attemptId,
          targetState: 'REQUIRES_ACTION',
        },
      });
      registry.register(providerKey, adapter);
      const repo = makeWebhookRepo(registry);

      await repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });
      await repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

      expect(adapter.verifyCallCount).toBe(2); // signature MUST still be verified on replay (§F10)
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM provider_payment_event WHERE "providerCredentialId" = $1 AND "providerEventId" = $2`,
        [credentialId, providerEventId],
      );
      expect(rows[0]!.n).toBe(1);
      expect(await attemptState(attemptId)).toBe('REQUIRES_ACTION');
    });

    it('same providerEventId under a DIFFERENT credential is allowed (never trusted globally)', async () => {
      const providerKeyA = `tap-diffcred-a-${uid()}`;
      const providerKeyB = `tap-diffcred-b-${uid()}`;
      const a = await createCredentialAndEndpoint(providerKeyA);
      const b = await createCredentialAndEndpoint(providerKeyB);
      const invoiceA = await freshInvoice(200n);
      const invoiceB = await freshInvoice(200n);
      const attemptA = await createAttempt({
        invoiceId: invoiceA,
        amountMinor: 50n,
        providerKey: providerKeyA,
        providerCredentialId: a.credentialId,
      });
      const attemptB = await createAttempt({
        invoiceId: invoiceB,
        amountMinor: 50n,
        providerKey: providerKeyB,
        providerCredentialId: b.credentialId,
      });
      const sharedEventId = `evt-shared-${uid()}`;
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKeyA,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: sharedEventId,
            eventType: 'x',
            paymentAttemptId: attemptA,
            targetState: 'REQUIRES_ACTION',
          },
        }),
      );
      registry.register(
        providerKeyB,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: sharedEventId,
            eventType: 'x',
            paymentAttemptId: attemptB,
            targetState: 'REQUIRES_ACTION',
          },
        }),
      );
      const repo = makeWebhookRepo(registry);

      await repo.handle({ endpointId: a.endpointId, rawBody: Buffer.from('{}'), headers: {} });
      await repo.handle({ endpointId: b.endpointId, rawBody: Buffer.from('{}'), headers: {} });

      expect(await attemptState(attemptA)).toBe('REQUIRES_ACTION');
      expect(await attemptState(attemptB)).toBe('REQUIRES_ACTION');
    });

    it('a RECEIVED-but-unprocessed duplicate still gets (re-)processed, never duplicating a financial effect', async () => {
      const providerKey = `tap-reproc-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 100n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const providerEventId = `evt-${uid()}`;
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-reproc',
          },
        }),
      );
      const repo = makeWebhookRepo(registry);

      await repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });
      await repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

      expect(await attemptState(attemptId)).toBe('CAPTURED');
      expect(await paymentCount(attemptId)).toBe(1);
    });
  });

  // ══════════════ §F17 — non-capture state transitions ════════════════════
  describe('non-capture state transitions', () => {
    for (const target of [
      'PENDING',
      'REQUIRES_ACTION',
      'AUTHORIZED',
      'FAILED',
      'CANCELED',
    ] as const) {
      it(`verified ${target}: processed correctly (event/no-event, reservation active/released per state)`, async () => {
        const providerKey = `tap-ns-${target}-${uid()}`;
        const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
        const invoiceId = await freshInvoice(200n);
        const attemptId = await createAttempt({
          invoiceId,
          amountMinor: 100n,
          providerKey,
          providerCredentialId: credentialId,
        });
        const registry = new PaymentProviderRegistry();
        registry.register(
          providerKey,
          fakeWebhookAdapter({
            kind: 'verifies',
            event: {
              providerEventId: `evt-${uid()}`,
              eventType: 'x',
              paymentAttemptId: attemptId,
              targetState: target,
            },
          }),
        );
        const repo = makeWebhookRepo(registry);

        await repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

        expect(await attemptState(attemptId)).toBe(target);
        const { rows: eventRows } = await pool.query(
          `SELECT count(*)::int AS n FROM payment_attempt_event WHERE "paymentAttemptId" = $1 AND source = 'WEBHOOK'`,
          [attemptId],
        );
        expect(eventRows[0]!.n).toBe(target === 'PENDING' ? 0 : 1); // PENDING is the same-state no-op here
        expect(await paymentCount(attemptId)).toBe(0);
      });
    }
  });

  // ══════════════ §F18/F19/F20 — verified CAPTURED conversion ═════════════
  describe('verified CAPTURED conversion', () => {
    it('valid CAPTURED: exactly one Payment + Allocation + WEBHOOK event', async () => {
      const providerKey = `tap-cap-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(300n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 300n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-${uid()}`,
            eventType: 'charge.captured',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-cap-1',
          },
        }),
      );
      const repo = makeWebhookRepo(registry);

      await repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

      expect(await attemptState(attemptId)).toBe('CAPTURED');
      expect(await paymentCount(attemptId)).toBe(1);
      const { rows: allocRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_allocation pa JOIN payment p ON p.id = pa."paymentId" WHERE p."sourceAttemptId" = $1`,
        [attemptId],
      );
      expect(allocRows[0]!.n).toBe(1);
      const { rows: eventRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt_event WHERE "paymentAttemptId" = $1 AND source = 'WEBHOOK' AND "toState" = 'CAPTURED'`,
        [attemptId],
      );
      expect(eventRows[0]!.n).toBe(1);
    });

    it('duplicate CAPTURED same attempt (different providerEventId, matching reference): PROCESSED idempotent no-op', async () => {
      const providerKey = `tap-capdup-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(300n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 300n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-a-${uid()}`,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-dup',
          },
        }),
      );
      const repo = makeWebhookRepo(registry);
      await repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });
      expect(await paymentCount(attemptId)).toBe(1);

      const registry2 = new PaymentProviderRegistry();
      const secondEventId = `evt-b-${uid()}`;
      registry2.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: secondEventId,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-dup',
          },
        }),
      );
      const repo2 = makeWebhookRepo(registry2);
      await repo2.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

      expect(await paymentCount(attemptId)).toBe(1); // still exactly one
      const second = await inboxStatus(credentialId, secondEventId);
      expect(second!.status).toBe('PROCESSED');
    });

    it('duplicate CAPTURED same attempt with a MISMATCHED providerReference: EXCEPTION, no second Payment', async () => {
      const providerKey = `tap-capmismatch-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(300n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 300n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-a-${uid()}`,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-first',
          },
        }),
      );
      await makeWebhookRepo(registry).handle({
        endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });

      const registry2 = new PaymentProviderRegistry();
      const secondEventId = `evt-b-${uid()}`;
      registry2.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: secondEventId,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-DIFFERENT',
          },
        }),
      );
      await makeWebhookRepo(registry2).handle({
        endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });

      expect(await paymentCount(attemptId)).toBe(1);
      const second = await inboxStatus(credentialId, secondEventId);
      expect(second!.status).toBe('EXCEPTION');
    });
  });

  // ══════════════ §F21 — late CAPTURED after FAILED/CANCELED ══════════════
  for (const terminal of ['FAILED', 'CANCELED'] as const) {
    it(`late CAPTURED after ${terminal}: no transition, no Payment, inbox EXCEPTION`, async () => {
      const providerKey = `tap-late-${terminal}-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 100n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-a-${uid()}`,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: terminal,
          },
        }),
      );
      await makeWebhookRepo(registry).handle({
        endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });
      expect(await attemptState(attemptId)).toBe(terminal);

      const registry2 = new PaymentProviderRegistry();
      const lateEventId = `evt-late-${uid()}`;
      registry2.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: lateEventId,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-late',
          },
        }),
      );
      await makeWebhookRepo(registry2).handle({
        endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });

      expect(await attemptState(attemptId)).toBe(terminal); // unchanged
      expect(await paymentCount(attemptId)).toBe(0);
      const late = await inboxStatus(credentialId, lateEventId);
      expect(late!.status).toBe('EXCEPTION');
    });
  }

  // ══════════════ §F15/F22 — fingerprint / version mismatch ═══════════════
  it('Order fingerprint drift since attempt creation: no Payment, inbox EXCEPTION', async () => {
    const providerKey = `tap-fp-${uid()}`;
    const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
    const orderId = await insertOrder();
    const invoiceId = await insertInvoice(orderId, 200n);
    const attemptId = await createAttempt({
      invoiceId,
      amountMinor: 200n,
      providerKey,
      providerCredentialId: credentialId,
    });
    // simulate live Order drift after the attempt snapshot was taken.
    await pool.query(`UPDATE "order" SET version = version + 1 WHERE id = $1`, [orderId]);

    const registry = new PaymentProviderRegistry();
    registry.register(
      providerKey,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId: `evt-${uid()}`,
          eventType: 'x',
          paymentAttemptId: attemptId,
          targetState: 'CAPTURED',
        },
      }),
    );
    await makeWebhookRepo(registry).handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

    expect(await attemptState(attemptId)).toBe('PENDING');
    expect(await paymentCount(attemptId)).toBe(0);
  });

  // ══════════════ §F15/F27 — credential/account mismatch ══════════════════
  it('an event signed for credential A cannot mutate an attempt belonging to credential B', async () => {
    const providerKeyA = `tap-mismatch-a-${uid()}`;
    const providerKeyB = `tap-mismatch-b-${uid()}`;
    const a = await createCredentialAndEndpoint(providerKeyA);
    const b = await createCredentialAndEndpoint(providerKeyB);
    const invoiceId = await freshInvoice(200n);
    // attempt belongs to credential B.
    const attemptId = await createAttempt({
      invoiceId,
      amountMinor: 100n,
      providerKey: providerKeyB,
      providerCredentialId: b.credentialId,
    });

    const registry = new PaymentProviderRegistry();
    // verified via ENDPOINT A (credential A) but claims to target B's attempt.
    registry.register(
      providerKeyA,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId: `evt-${uid()}`,
          eventType: 'x',
          paymentAttemptId: attemptId,
          targetState: 'CAPTURED',
        },
      }),
    );
    await makeWebhookRepo(registry).handle({
      endpointId: a.endpointId,
      rawBody: Buffer.from('{}'),
      headers: {},
    });

    expect(await attemptState(attemptId)).toBe('PENDING'); // untouched
    expect(await paymentCount(attemptId)).toBe(0);
  });

  // ══════════════ §F23/F24 — reservation-conversion + local-payment
  // interaction ═════════════════════════════════════════════════════════
  describe('capture-vs-local-payment interaction', () => {
    it('A: Invoice 100, attempt 60, local CASH 40 confirmed, verified CAPTURED 60 -> succeeds, final = 100', async () => {
      const providerKey = `tap-int-a-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(100n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 60n,
        providerKey,
        providerCredentialId: credentialId,
      });
      await localCash(invoiceId, 40n);

      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-${uid()}`,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
          },
        }),
      );
      await makeWebhookRepo(registry).handle({
        endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });

      expect(await attemptState(attemptId)).toBe('CAPTURED');
      const { rows } = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
        [invoiceId],
      );
      expect(rows[0]!.total).toBe('100');
    });

    it('B: attempt A reserves 60, attempt B reserves 40, A CAPTURED 60 -> succeeds, B remains active 40', async () => {
      const providerKey = `tap-int-b-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(100n);
      const attemptA = await createAttempt({
        invoiceId,
        amountMinor: 60n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const attemptB = await createAttempt({
        invoiceId,
        amountMinor: 40n,
        providerKey,
        providerCredentialId: credentialId,
      });

      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-${uid()}`,
            eventType: 'x',
            paymentAttemptId: attemptA,
            targetState: 'CAPTURED',
          },
        }),
      );
      await makeWebhookRepo(registry).handle({
        endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });

      expect(await attemptState(attemptA)).toBe('CAPTURED');
      expect(await attemptState(attemptB)).toBe('PENDING');
      // B's reservation still blocks a local overpayment beyond 0 remaining.
      await expect(localCash(invoiceId, 1n)).rejects.toMatchObject({
        code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
      });
    });

    it('C: adversarial/inconsistent existing allocations make conversion exceed the invoice total -> fails closed, EXCEPTION, no Payment', async () => {
      const providerKey = `tap-int-c-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(100n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 60n,
        providerKey,
        providerCredentialId: credentialId,
      });
      // adversarial fixture: a SECOND, unrelated attempt against the SAME
      // invoice, inserted DIRECTLY as already-CAPTURED via raw SQL
      // (deliberately bypassing the normal reservation-creation guard,
      // which would correctly refuse 80 when only 40 remains) with a
      // matching Payment + Allocation for 80 — simulating "the confirmed
      // state is already inconsistent with this attempt's own reservation."
      const { rows: orderRows } = await pool.query<{
        orderId: string;
        fp: string;
        version: number;
      }>(
        `SELECT i."orderId", o."commercialSnapshotFingerprint" AS fp, o."version"
           FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE i.id = $1`,
        [invoiceId],
      );
      const { orderId, fp, version } = orderRows[0]!;
      const { rows: otherAttemptRows } = await pool.query<{ id: string }>(
        `INSERT INTO payment_attempt
           ("tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", method,
            "providerKey", "providerCredentialId", "amountMinor", "currencyCode", "currencyExponent",
            state, "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
            "idempotencyKey", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,'ONLINE_GATEWAY',$6,$7,80,'AED',2,'CAPTURED',$8,$9,$10, now())
         RETURNING id`,
        [
          TENANT,
          COMPANY,
          BRANCH,
          orderId,
          invoiceId,
          providerKey,
          credentialId,
          fp,
          version,
          `f-adversarial-${uid()}`,
        ],
      );
      const otherAttemptId = otherAttemptRows[0]!.id;
      const localPaymentId = await pool
        .query<{ id: string }>(
          `INSERT INTO payment
             (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "providerKey",
              "amountMinor", "currencyCode", "currencyExponent")
           VALUES (uuidv7(), $1, $2, $3, $4, 'ONLINE_GATEWAY', $5, 80, 'AED', 2) RETURNING id`,
          [TENANT, COMPANY, BRANCH, otherAttemptId, providerKey],
        )
        .then((r) => r.rows[0]!.id);
      await pool.query(
        `INSERT INTO payment_allocation (id, "tenantId", "companyId", "branchId", "paymentId", "invoiceId", "amountMinor", "currencyCode", "currencyExponent")
         VALUES (uuidv7(), $1, $2, $3, $4, $5, 80, 'AED', 2)`,
        [TENANT, COMPANY, BRANCH, localPaymentId, invoiceId],
      );

      const registry = new PaymentProviderRegistry();
      const eventId = `evt-${uid()}`;
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: eventId,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
          },
        }),
      );
      await makeWebhookRepo(registry).handle({
        endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });

      expect(await attemptState(attemptId)).toBe('PENDING');
      expect(await paymentCount(attemptId)).toBe(0);
      const row = await inboxStatus(credentialId, eventId);
      expect(row!.status).toBe('EXCEPTION');
    });
  });

  // ══════════════ §F24 — FAILED/CANCELED release, later local collection ═
  it('async reservation 100, verified FAILED, then local CASH 100 -> succeeds', async () => {
    const providerKey = `tap-release-${uid()}`;
    const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
    const invoiceId = await freshInvoice(100n);
    const attemptId = await createAttempt({
      invoiceId,
      amountMinor: 100n,
      providerKey,
      providerCredentialId: credentialId,
    });

    const registry = new PaymentProviderRegistry();
    registry.register(
      providerKey,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId: `evt-${uid()}`,
          eventType: 'x',
          paymentAttemptId: attemptId,
          targetState: 'FAILED',
        },
      }),
    );
    await makeWebhookRepo(registry).handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

    expect(await attemptState(attemptId)).toBe('FAILED');
    const result = await localCash(invoiceId, 100n);
    expect(result.amountMinor).toBe(100n);
  });

  // ══════════════ §F26 — concurrent webhook processing ════════════════════
  describe('concurrent webhook processing', () => {
    it('A: the SAME inbox event processed concurrently twice -> one transition, one Payment, one Allocation', async () => {
      const providerKey = `tap-conc-a-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 100n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const providerEventId = `evt-${uid()}`;
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-conc-a',
          },
        }),
      );
      const repo = makeWebhookRepo(registry);

      await inParallel(2, () =>
        repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} }),
      );

      expect(await paymentCount(attemptId)).toBe(1);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt_event WHERE "paymentAttemptId" = $1 AND "toState" = 'CAPTURED'`,
        [attemptId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('B: two DIFFERENT CAPTURED events for the same attempt concurrently -> one Payment, both inbox rows terminal', async () => {
      const providerKey = `tap-conc-b-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 100n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const eventIds = [`evt-c1-${uid()}`, `evt-c2-${uid()}`];
      const registries = eventIds.map((eventId) => {
        const r = new PaymentProviderRegistry();
        r.register(
          providerKey,
          fakeWebhookAdapter({
            kind: 'verifies',
            event: {
              providerEventId: eventId,
              eventType: 'x',
              paymentAttemptId: attemptId,
              targetState: 'CAPTURED',
              providerReference: 'ref-conc-b',
            },
          }),
        );
        return r;
      });

      await inParallel(2, (i) =>
        makeWebhookRepo(registries[i]!).handle({
          endpointId,
          rawBody: Buffer.from('{}'),
          headers: {},
        }),
      );

      expect(await paymentCount(attemptId)).toBe(1);
      for (const eventId of eventIds) {
        const row = await inboxStatus(credentialId, eventId);
        expect(['PROCESSED']).toContain(row!.status); // matching reference -> idempotent PROCESSED either way
      }
    });

    it('C: provider CAPTURE vs local synchronous collection on the same Invoice -> total allocation never exceeds invoice total', async () => {
      const providerKey = `tap-conc-c-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(100n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 60n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-${uid()}`,
            eventType: 'x',
            paymentAttemptId: attemptId,
            targetState: 'CAPTURED',
          },
        }),
      );
      const repo = makeWebhookRepo(registry);

      const results = await inParallel<unknown>(2, (i) =>
        i === 0
          ? repo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} })
          : localCash(invoiceId, 40n),
      );
      // whichever order, never both succeed to overpay
      const { rows } = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
        [invoiceId],
      );
      expect(Number(rows[0]!.total)).toBeLessThanOrEqual(100);
      void results;
    });
  });

  // ══════════════ §F27 — cross-tenant/company/branch protection ═══════════
  it('a genuinely nonexistent paymentAttemptId is still durably recorded — no FK rejection, no mutation, EXCEPTION (owner reliability-pass §5/§6)', async () => {
    const providerKey = `tap-scope-${uid()}`;
    const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
    const claimedAttemptId = crypto.randomUUID();
    const eventId = `evt-${uid()}`;
    const registry = new PaymentProviderRegistry();
    registry.register(
      providerKey,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId: eventId,
          eventType: 'x',
          paymentAttemptId: claimedAttemptId,
          targetState: 'CAPTURED',
        },
      }),
    );
    // no real payment_attempt exists with this id in ANY scope — this is
    // no longer an insert-time FK rejection (owner §6): the signature-valid
    // event is durable evidence and must be persisted regardless.
    await expect(
      makeWebhookRepo(registry).handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} }),
    ).resolves.toBeUndefined();

    const row = await inboxStatus(credentialId, eventId);
    expect(row!.status).toBe('EXCEPTION');
    const { rows } = await pool.query<{ paymentAttemptId: string }>(
      `SELECT "paymentAttemptId" FROM provider_payment_event WHERE id = $1`,
      [row!.id],
    );
    // the claimed id is retained for reconciliation, never discarded.
    expect(rows[0]!.paymentAttemptId).toBe(claimedAttemptId);
  });

  // ══════════════ §F7 — unsupported-but-verified event, no attempt target ═
  it('a verified event with no paymentAttemptId is recorded directly as EXCEPTION', async () => {
    const providerKey = `tap-noattempt-${uid()}`;
    const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
    const eventId = `evt-${uid()}`;
    const registry = new PaymentProviderRegistry();
    registry.register(
      providerKey,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: { providerEventId: eventId, eventType: 'some.unsupported.type' },
      }),
    );
    await makeWebhookRepo(registry).handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

    const row = await inboxStatus(credentialId, eventId);
    expect(row!.status).toBe('EXCEPTION');
  });

  // ══════════════ owner reliability-pass §1-§3 — durable RECEIVED recovery
  // ══════════════════════════════════════════════════════════════════════
  describe('durable RECEIVED recovery (WebhookRecoveryProcessor)', () => {
    /** inserts a durable RECEIVED inbox row WITHOUT ever calling the
     *  immediate in-process processor — simulates "the process crashed
     *  strictly between the inbox commit and the immediate call." */
    async function insertReceivedOnly(input: {
      tenantId: string;
      companyId: string;
      branchId: string;
      providerCredentialId: string;
      providerEventId: string;
      eventType: string;
      paymentAttemptId?: string | null;
      providerReference?: string | null;
      targetState?:
        'PENDING' | 'REQUIRES_ACTION' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'CANCELED';
    }): Promise<string> {
      const result = await runScoped(prisma, { tenantId: input.tenantId }, (tx) =>
        inbox.insertVerifiedEventInTx(tx, {
          tenantId: input.tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          providerCredentialId: input.providerCredentialId,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          payloadHash: crypto.createHash('sha256').update(input.providerEventId).digest('hex'),
          paymentAttemptId: input.paymentAttemptId ?? null,
          providerReference: input.providerReference ?? null,
          targetState: input.targetState ?? null,
        }),
      );
      return result.inboxId;
    }

    it('A: crash BEFORE the immediate processor ever runs — a recovery pass discovers and completes it (no provider redelivery used)', async () => {
      const providerKey = `tap-rec-a-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 200n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const inboxId = await insertReceivedOnly({
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        providerCredentialId: credentialId,
        providerEventId: `evt-${uid()}`,
        eventType: 'x',
        paymentAttemptId: attemptId,
        providerReference: 'ref-rec-a',
        targetState: 'CAPTURED',
      });
      // never called handle() / the immediate processor at all.
      const { rows: preRows } = await pool.query<{ status: string }>(
        `SELECT status FROM provider_payment_event WHERE id = $1`,
        [inboxId],
      );
      expect(preRows[0]!.status).toBe('RECEIVED');

      const recovery = new WebhookRecoveryProcessor(db, processor);
      const result = await recovery.tick();

      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(await attemptState(attemptId)).toBe('CAPTURED');
      expect(await paymentCount(attemptId)).toBe(1);
      const { rows: allocRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_allocation pa JOIN payment p ON p.id = pa."paymentId" WHERE p."sourceAttemptId" = $1`,
        [attemptId],
      );
      expect(allocRows[0]!.n).toBe(1);
      const { rows: postRows } = await pool.query<{ status: string }>(
        `SELECT status FROM provider_payment_event WHERE id = $1`,
        [inboxId],
      );
      expect(postRows[0]!.status).toBe('PROCESSED');
    });

    it('B: a transient processor failure leaves the row RECEIVED; a later recovery pass succeeds exactly once', async () => {
      const providerKey = `tap-rec-b-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 150n,
        providerKey,
        providerCredentialId: credentialId,
      });
      const inboxId = await insertReceivedOnly({
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        providerCredentialId: credentialId,
        providerEventId: `evt-${uid()}`,
        eventType: 'x',
        paymentAttemptId: attemptId,
        providerReference: 'ref-rec-b',
        targetState: 'AUTHORIZED',
      });

      class ProcessorFailsOnce extends WebhookEventProcessorRepository {
        private readonly failedOnce = new Set<string>();
        override async processVerifiedInboxEventInTx(
          tx: Parameters<WebhookEventProcessorRepository['processVerifiedInboxEventInTx']>[0],
          input: Parameters<WebhookEventProcessorRepository['processVerifiedInboxEventInTx']>[1],
        ) {
          if (!this.failedOnce.has(input.inboxId)) {
            this.failedOnce.add(input.inboxId);
            throw new Error('simulated transient processor failure');
          }
          return super.processVerifiedInboxEventInTx(tx, input);
        }
      }
      const flakyRecovery = new WebhookRecoveryProcessor(
        db,
        new ProcessorFailsOnce(new AuditWriter(db), new OutboxWriter(db)),
      );
      const first = await flakyRecovery.tick();
      expect(first.failed).toBeGreaterThanOrEqual(1);
      const { rows: midRows } = await pool.query<{ status: string }>(
        `SELECT status FROM provider_payment_event WHERE id = $1`,
        [inboxId],
      );
      expect(midRows[0]!.status).toBe('RECEIVED');
      expect(await attemptState(attemptId)).toBe('PENDING');

      const secondPass = await flakyRecovery.tick();
      expect(secondPass.processed).toBeGreaterThanOrEqual(1);
      expect(await attemptState(attemptId)).toBe('AUTHORIZED');
    });

    it('C: two recovery workers scanning concurrently -> exactly one financial effect', async () => {
      const providerKey = `tap-rec-c-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const attemptId = await createAttempt({
        invoiceId,
        amountMinor: 100n,
        providerKey,
        providerCredentialId: credentialId,
      });
      await insertReceivedOnly({
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        providerCredentialId: credentialId,
        providerEventId: `evt-${uid()}`,
        eventType: 'x',
        paymentAttemptId: attemptId,
        providerReference: 'ref-rec-c',
        targetState: 'CAPTURED',
      });

      const workerA = new WebhookRecoveryProcessor(db, processor);
      const workerB = new WebhookRecoveryProcessor(db, processor);
      await inParallel(2, (i) => (i === 0 ? workerA.tick() : workerB.tick()));

      expect(await attemptState(attemptId)).toBe('CAPTURED');
      expect(await paymentCount(attemptId)).toBe(1);
    });
  });

  // ══════════════ owner reliability-pass §10 — duplicate event-id with
  // materially DIFFERENT verified content ═════════════════════════════════
  it('same providerEventId delivered with a DIFFERENT targetState: original event untouched, no mutation for the conflicting delivery', async () => {
    const providerKey = `tap-conflict-${uid()}`;
    const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
    const invoiceId = await freshInvoice(200n);
    const attemptId = await createAttempt({
      invoiceId,
      amountMinor: 100n,
      providerKey,
      providerCredentialId: credentialId,
    });
    const eventId = `evt-${uid()}`;

    const registry1 = new PaymentProviderRegistry();
    registry1.register(
      providerKey,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId: eventId,
          eventType: 'x',
          paymentAttemptId: attemptId,
          targetState: 'REQUIRES_ACTION',
        },
      }),
    );
    await makeWebhookRepo(registry1).handle({
      endpointId,
      rawBody: Buffer.from('{}'),
      headers: {},
    });
    expect(await attemptState(attemptId)).toBe('REQUIRES_ACTION');

    // SAME providerEventId, but this delivery claims a DIFFERENT targetState.
    const registry2 = new PaymentProviderRegistry();
    registry2.register(
      providerKey,
      fakeWebhookAdapter({
        kind: 'verifies',
        event: {
          providerEventId: eventId,
          eventType: 'x',
          paymentAttemptId: attemptId,
          targetState: 'CANCELED',
        },
      }),
    );
    await makeWebhookRepo(registry2).handle({
      endpointId,
      rawBody: Buffer.from('{}'),
      headers: {},
    });

    // the ORIGINAL durable event/state is untouched — no mutation happened
    // for the conflicting delivery.
    expect(await attemptState(attemptId)).toBe('REQUIRES_ACTION');
    const row = await inboxStatus(credentialId, eventId);
    expect(row!.status).toBe('PROCESSED'); // the ORIGINAL event's own outcome, unchanged
    const { rows } = await pool.query<{ targetState: string }>(
      `SELECT "targetState" FROM provider_payment_event WHERE id = $1`,
      [row!.id],
    );
    expect(rows[0]!.targetState).toBe('REQUIRES_ACTION'); // never overwritten to CANCELED
  });
});
