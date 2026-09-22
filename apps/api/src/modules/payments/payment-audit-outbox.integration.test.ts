import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, inParallel, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped, type PrismaClient } from '@flower/db';
import { DbService, RequestContext, runWithContext, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import type { DomainError } from '../../common/errors/domain-error.js';
import { PaymentCollectionRepository } from './payment-collection.repository.js';
import { PaymentAttemptReservationRepository } from './payment-attempt-reservation.repository.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import { PaymentAttemptRepository } from './payment-attempt.repository.js';
import { WebhookBootstrapRepository } from './webhook-bootstrap.repository.js';
import { ProviderPaymentEventInboxRepository } from './provider-payment-event-inbox.repository.js';
import { WebhookEventProcessorRepository } from './webhook-event-processor.repository.js';
import { PaymentWebhookRepository } from './payment-webhook.repository.js';
import { WebhookRecoveryProcessor } from './webhook-recovery.repository.js';
import type {
  PaymentProvider,
  PaymentProviderInitiationResult,
  VerifiedProviderWebhookEvent,
} from './payment-provider.port.js';

/**
 * Task 3b.5 Checkpoint G — audit completion, business outbox, rollback
 * atomicity, replay/idempotency non-duplication, realtime branch-isolation
 * envelope probes, and the remaining concurrent-recovery adversarial hard
 * gates. Mirrors the exact fixture/harness conventions established across
 * A-F's own test files (real Postgres via `@flower/testing`, no HTTP/NestJS
 * bootstrap needed for any of this — every class under test takes its
 * dependencies directly).
 *
 * NO refund/settlement/AR/Advance/PostingEngine/Invoice.invoicePaymentStatus
 * code is exercised anywhere in this file.
 */
const TENANT = 'f1000000-1111-7111-8111-111111111111';
const COMPANY = 'f3000000-3333-7333-8333-333333333333';
const COMPANY_2 = 'f4000000-4444-7444-8444-444444444444';
const BRANCH = 'f6000000-6666-7666-8666-666666666666';
const BRANCH_2 = 'f7000000-7777-7777-8777-777777777777';
const CATEGORY = 'f9000000-9999-7999-8999-999999999999';
const PRODUCT = 'fa000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const VARIANT = 'fb000000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function fakeWebhookAdapter(
  behavior: { kind: 'verifies'; event: VerifiedProviderWebhookEvent } | { kind: 'rejects' },
): PaymentProvider & { verifyCallCount: number } {
  const adapter = {
    verifyCallCount: 0,
    async createIntent(): Promise<PaymentProviderInitiationResult> {
      throw new Error('not implemented — never called in this file');
    },
    async authorize(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async capture(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async refund(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async getStatus(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async verifyWebhook(): Promise<VerifiedProviderWebhookEvent> {
      adapter.verifyCallCount += 1;
      if (behavior.kind === 'rejects') throw new Error('simulated invalid signature');
      return behavior.event;
    },
  };
  return adapter;
}

function fakeCreateIntentAdapter(
  behavior: { kind: 'result'; result: PaymentProviderInitiationResult } | { kind: 'throws' },
): PaymentProvider & { callCount: number } {
  const adapter = {
    callCount: 0,
    async createIntent(): Promise<PaymentProviderInitiationResult> {
      adapter.callCount += 1;
      if (behavior.kind === 'throws') throw new Error('simulated transport failure');
      return behavior.result;
    },
    async authorize(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async capture(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async refund(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async getStatus(): Promise<unknown> {
      throw new Error('not implemented');
    },
    async verifyWebhook(): Promise<VerifiedProviderWebhookEvent> {
      throw new Error('not implemented');
    },
  };
  return adapter;
}

describe('Checkpoint G — audit / business outbox / rollback / realtime-isolation / concurrent-recovery (integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let collection: PaymentCollectionRepository;
  let reservation: PaymentAttemptReservationRepository;
  let providerConfig: ProviderConfigRepository;
  let bootstrap: WebhookBootstrapRepository;
  const inbox = new ProviderPaymentEventInboxRepository();
  let processor: WebhookEventProcessorRepository;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    collection = new PaymentCollectionRepository(new AuditWriter(db), new OutboxWriter(db));
    reservation = new PaymentAttemptReservationRepository(
      new AuditWriter(db),
      new OutboxWriter(db),
    );
    providerConfig = new ProviderConfigRepository(db);
    bootstrap = new WebhookBootstrapRepository(db);
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
       VALUES ($1, 'pg-3b5', 'pg-3b5', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000f0000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    for (const [id, name] of [
      [COMPANY, 'Co'],
      [COMPANY_2, 'Co 2'],
    ] as const) {
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, $3, 'AED', 'Asia/Dubai', now())`,
        [id, TENANT, name],
      );
    }
    for (const [id, companyId, name] of [
      [BRANCH, COMPANY, 'Main'],
      [BRANCH_2, COMPANY, 'Second'],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [id, TENANT, companyId, name],
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
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  const uid = (): string => crypto.randomUUID();
  let seq = 0;

  async function insertOrder(companyId = COMPANY, branchId = BRANCH): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [id, TENANT, companyId, branchId, `fp-${id}`],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-G-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function insertInvoice(
    orderId: string,
    totalAmountMinor = 500n,
    companyId = COMPANY,
    branchId = BRANCH,
  ): Promise<string> {
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
      [lineId, TENANT, companyId, orderId, PRODUCT, VARIANT, totalAmountMinor],
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
        companyId,
        branchId,
        orderId,
        `INV-G-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    return invoiceId;
  }

  async function freshInvoice(
    totalAmountMinor = 500n,
    companyId = COMPANY,
    branchId = BRANCH,
  ): Promise<string> {
    const orderId = await insertOrder(companyId, branchId);
    return insertInvoice(orderId, totalAmountMinor, companyId, branchId);
  }

  async function createCredentialAndEndpoint(
    providerKey: string,
    companyId = COMPANY,
    branchId = BRANCH,
  ): Promise<{ credentialId: string; endpointId: string }> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, status,
          "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, $4, 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
       RETURNING id`,
      [TENANT, companyId, branchId, providerKey],
    );
    const credentialId = rows[0]!.id;
    const { rows: epRows } = await pool.query<{ id: string }>(
      `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
       VALUES (uuidv7(), $1, $2, $3, $4) RETURNING id`,
      [TENANT, companyId, branchId, credentialId],
    );
    return { credentialId, endpointId: epRows[0]!.id };
  }

  function auditCount(action: string, resourceId: string): Promise<number> {
    return pool
      .query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND "resourceId" = $2`,
        [action, resourceId],
      )
      .then((r) => Number(r.rows[0]!.n));
  }
  function outboxCount(eventType: string, aggregateId: string): Promise<number> {
    return pool
      .query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox WHERE "eventType" = $1 AND "aggregateId" = $2`,
        [eventType, aggregateId],
      )
      .then((r) => Number(r.rows[0]!.n));
  }
  async function outboxRow(
    eventType: string,
    aggregateId: string,
  ): Promise<{
    tenantId: string;
    companyId: string | null;
    branchId: string | null;
    payload: Record<string, unknown>;
  }> {
    const { rows } = await pool.query(
      `SELECT "tenantId", "companyId", "branchId", payload FROM outbox WHERE "eventType" = $1 AND "aggregateId" = $2 ORDER BY "createdAt" DESC LIMIT 1`,
      [eventType, aggregateId],
    );
    return rows[0];
  }

  // ══════════════ §G3/§G4/§G6/§G7 — C/D synchronous audit + outbox ════════
  describe('C/D synchronous audit + outbox', () => {
    it('one payment.recorded audit + one payments.payment_recorded outbox, bounded payload, one payment_attempt.state_changed pair', async () => {
      const invoiceId = await freshInvoice(200n);
      const result = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        collection.captureSingleTenderInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'CASH',
          amountMinor: 200n,
          createdByUserId: null,
          actingUserId: null,
          idempotencyKey: `g-cd-${uid()}`,
        }),
      );

      expect(await auditCount('payment.recorded', result.paymentId)).toBe(1);
      expect(await outboxCount('payments.payment_recorded', result.paymentId)).toBe(1);
      expect(await auditCount('payment_attempt.state_changed', result.paymentAttemptId)).toBe(1);
      expect(await outboxCount('payments.attempt_state_changed', result.paymentAttemptId)).toBe(1);

      const row = await outboxRow('payments.payment_recorded', result.paymentId);
      expect(row.tenantId).toBe(TENANT);
      expect(row.companyId).toBe(COMPANY);
      expect(row.branchId).toBe(BRANCH);
      expect(Object.keys(row.payload).sort()).toEqual(
        [
          'paymentId',
          'invoiceId',
          'paymentGroupId',
          'method',
          'amountMinor',
          'currencyCode',
          'currencyExponent',
        ].sort(),
      );
      expect(row.payload['amountMinor']).toBe('200');
      // never customer PII / actor token / provider credential / secret.
      const blob = JSON.stringify(row.payload);
      expect(blob).not.toMatch(/secret|token|credential/i);
    });

    it('Multi Payment: exactly one payment.recorded + one attempt_state_changed PER component', async () => {
      const invoiceId = await freshInvoice(150n);
      const result = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        collection.captureSynchronousTendersInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          amountMinor: 150n,
          tenders: [
            { method: 'CASH', amountMinor: 100n },
            { method: 'BANK_TRANSFER', amountMinor: 50n },
          ],
          createdByUserId: null,
          actingUserId: null,
          idempotencyKey: `g-multi-${uid()}`,
        }),
      );
      for (const p of result.payments) {
        expect(await auditCount('payment.recorded', p.paymentId)).toBe(1);
        expect(await outboxCount('payments.payment_recorded', p.paymentId)).toBe(1);
        expect(await auditCount('payment_attempt.state_changed', p.paymentAttemptId)).toBe(1);
      }
    });
  });

  // ══════════════ §G5/§G7 — E Phase-1 reservation + Phase-2 transitions ═══
  describe('E Phase-1/Phase-2 audit + outbox', () => {
    it('Phase-1 reservation: audited, NO outbox event for creation', async () => {
      const providerKey = `tap-g-e1-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g-e1-key-${uid()}`,
        }),
      );
      expect(await auditCount('payment_attempt.reserved', reserved.paymentAttemptId)).toBe(1);
      expect(await outboxCount('payments.attempt_state_changed', reserved.paymentAttemptId)).toBe(
        0,
      );
    });

    it('Phase-2 real transition: audit + outbox; same-state result: neither', async () => {
      const providerKey = `tap-g-e2-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g-e2-key-${uid()}`,
        }),
      );

      // same-state PENDING -> PENDING: no audit, no outbox.
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.applyProviderInitiationResultInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          paymentAttemptId: reserved.paymentAttemptId,
          invoiceId,
          resultState: 'PENDING',
        }),
      );
      expect(await auditCount('payment_attempt.state_changed', reserved.paymentAttemptId)).toBe(0);

      // real transition: PENDING -> REQUIRES_ACTION.
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.applyProviderInitiationResultInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          paymentAttemptId: reserved.paymentAttemptId,
          invoiceId,
          resultState: 'REQUIRES_ACTION',
        }),
      );
      expect(await auditCount('payment_attempt.state_changed', reserved.paymentAttemptId)).toBe(1);
      expect(await outboxCount('payments.attempt_state_changed', reserved.paymentAttemptId)).toBe(
        1,
      );
    });
  });

  // ══════════════ §G8 — provider_payment_event.exception audit ═══════════
  describe('provider_payment_event.exception audit', () => {
    it('an EXCEPTION finalization writes exactly one bounded, reason-coded audit row and NO outbox row', async () => {
      const providerKeyA = `tap-g8-a-${uid()}`;
      const providerKeyB = `tap-g8-b-${uid()}`;
      const a = await createCredentialAndEndpoint(providerKeyA);
      const b = await createCredentialAndEndpoint(providerKeyB);
      const invoiceId = await freshInvoice(200n);
      // attempt belongs to credential B.
      const attemptB = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey: providerKeyB,
          providerCredentialId: b.credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g8-key-${uid()}`,
        }),
      );

      const registry = new PaymentProviderRegistry();
      const eventId = `evt-${uid()}`;
      registry.register(
        providerKeyA,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: eventId,
            eventType: 'x',
            paymentAttemptId: attemptB.paymentAttemptId,
            targetState: 'CAPTURED',
          },
        }),
      );
      const webhookRepo = new PaymentWebhookRepository(db, bootstrap, registry, inbox, processor);
      await webhookRepo.handle({
        endpointId: a.endpointId,
        rawBody: Buffer.from('{}'),
        headers: {},
      });

      const { rows: inboxRows } = await pool.query<{ id: string }>(
        `SELECT id FROM provider_payment_event WHERE "providerCredentialId" = $1 AND "providerEventId" = $2`,
        [a.credentialId, eventId],
      );
      const inboxId = inboxRows[0]!.id;
      expect(await auditCount('provider_payment_event.exception', inboxId)).toBe(1);
      expect(await outboxCount('provider_payment_event.exception', inboxId)).toBe(0);

      const { rows: auditRows } = await pool.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_log WHERE action = 'provider_payment_event.exception' AND "resourceId" = $1`,
        [inboxId],
      );
      expect(auditRows[0]!.after['reason']).toBe('UNKNOWN_OR_CROSS_SCOPE_ATTEMPT');
      const blob = JSON.stringify(auditRows[0]!.after);
      expect(blob).not.toMatch(/secret|signature|header/i);
    });
  });

  // ══════════════ §G9 — replay/idempotency: no duplicate audit/outbox ═════
  describe('replay/idempotency non-duplication', () => {
    it('F: duplicate webhook replay (same providerEventId) creates no duplicate payment/attempt audit or outbox', async () => {
      const providerKey = `tap-g9-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g9-key-${uid()}`,
        }),
      );
      const eventId = `evt-${uid()}`;
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: eventId,
            eventType: 'x',
            paymentAttemptId: reserved.paymentAttemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-g9',
          },
        }),
      );
      const webhookRepo = new PaymentWebhookRepository(db, bootstrap, registry, inbox, processor);

      await webhookRepo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });
      await webhookRepo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM payment WHERE "sourceAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      expect(rows).toHaveLength(1);
      expect(await auditCount('payment.recorded', rows[0]!.id)).toBe(1);
      expect(await outboxCount('payments.payment_recorded', rows[0]!.id)).toBe(1);
      expect(await auditCount('payment_attempt.state_changed', reserved.paymentAttemptId)).toBe(1);
    });

    it('at-least-once recovery-worker delivery (concurrent) creates no duplicate audit/outbox', async () => {
      const providerKey = `tap-g9b-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g9b-key-${uid()}`,
        }),
      );
      const eventId = `evt-${uid()}`;
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: eventId,
            eventType: 'x',
            paymentAttemptId: reserved.paymentAttemptId,
            targetState: 'CAPTURED',
            providerReference: 'ref-g9b',
          },
        }),
      );
      const webhookRepo = new PaymentWebhookRepository(db, bootstrap, registry, inbox, processor);
      await webhookRepo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

      const recoveryA = new WebhookRecoveryProcessor(db, processor);
      const recoveryB = new WebhookRecoveryProcessor(db, processor);
      await inParallel(2, (i) => (i === 0 ? recoveryA.tick() : recoveryB.tick()));

      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM payment WHERE "sourceAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      expect(rows).toHaveLength(1);
      expect(await auditCount('payment.recorded', rows[0]!.id)).toBe(1);
      expect(await outboxCount('payments.payment_recorded', rows[0]!.id)).toBe(1);
    });
  });

  // ══════════════ §G10 — rollback atomicity ═══════════════════════════════
  describe('rollback atomicity', () => {
    it('A: C single payment — outer transaction aborts -> attempt/event/payment/allocation/audit/outbox ALL disappear', async () => {
      const invoiceId = await freshInvoice(200n);
      let attemptId!: string;
      let paymentId!: string;
      await expect(
        runScoped(prisma, { tenantId: TENANT }, async (tx) => {
          const result = await collection.captureSingleTenderInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'CASH',
            amountMinor: 200n,
            createdByUserId: null,
            actingUserId: null,
            idempotencyKey: `g10a-${uid()}`,
          });
          attemptId = result.paymentAttemptId;
          paymentId = result.paymentId;
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      const { rows: attemptRows } = await pool.query(
        `SELECT 1 FROM payment_attempt WHERE id = $1`,
        [attemptId],
      );
      expect(attemptRows).toHaveLength(0);
      const { rows: paymentRows } = await pool.query(`SELECT 1 FROM payment WHERE id = $1`, [
        paymentId,
      ]);
      expect(paymentRows).toHaveLength(0);
      expect(await auditCount('payment.recorded', paymentId)).toBe(0);
      expect(await outboxCount('payments.payment_recorded', paymentId)).toBe(0);
      expect(await auditCount('payment_attempt.state_changed', attemptId)).toBe(0);
      expect(await outboxCount('payments.attempt_state_changed', attemptId)).toBe(0);
    });

    it('B: D Multi Payment (N components) — outer transaction aborts -> ZERO components survive', async () => {
      const invoiceId = await freshInvoice(150n);
      let paymentIds: string[] = [];
      let attemptIds: string[] = [];
      await expect(
        runScoped(prisma, { tenantId: TENANT }, async (tx) => {
          const result = await collection.captureSynchronousTendersInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            amountMinor: 150n,
            tenders: [
              { method: 'CASH', amountMinor: 100n },
              { method: 'BANK_TRANSFER', amountMinor: 50n },
            ],
            createdByUserId: null,
            actingUserId: null,
            idempotencyKey: `g10b-${uid()}`,
          });
          paymentIds = result.payments.map((p) => p.paymentId);
          attemptIds = result.payments.map((p) => p.paymentAttemptId);
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      for (const paymentId of paymentIds) {
        const { rows } = await pool.query(`SELECT 1 FROM payment WHERE id = $1`, [paymentId]);
        expect(rows).toHaveLength(0);
        expect(await auditCount('payment.recorded', paymentId)).toBe(0);
      }
      for (const attemptId of attemptIds) {
        const { rows } = await pool.query(`SELECT 1 FROM payment_attempt WHERE id = $1`, [
          attemptId,
        ]);
        expect(rows).toHaveLength(0);
      }
    });

    it('C: F verified CAPTURED — Phase-2 transaction aborts -> Payment/Allocation/audit/outbox roll back, inbox/attempt untouched, recovery can retry', async () => {
      const providerKey = `tap-g10c-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 200n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g10c-key-${uid()}`,
        }),
      );
      const inboxResult = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        inbox.insertVerifiedEventInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          providerCredentialId: credentialId,
          providerEventId: `evt-${uid()}`,
          eventType: 'x',
          payloadHash: 'hash',
          paymentAttemptId: reserved.paymentAttemptId,
          providerReference: 'ref-g10c',
          targetState: 'CAPTURED',
        }),
      );

      await expect(
        runScoped(prisma, { tenantId: TENANT }, async (tx) => {
          await processor.processVerifiedInboxEventInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            inboxId: inboxResult.inboxId,
          });
          throw new Error('force rollback after Payment creation');
        }),
      ).rejects.toThrow('force rollback');

      // Payment never survives; inbox reverts to RECEIVED (whole tx rolled back).
      const { rows: paymentRows } = await pool.query(
        `SELECT 1 FROM payment WHERE "sourceAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      expect(paymentRows).toHaveLength(0);
      const { rows: inboxRows } = await pool.query<{ status: string }>(
        `SELECT status FROM provider_payment_event WHERE id = $1`,
        [inboxResult.inboxId],
      );
      expect(inboxRows[0]!.status).toBe('RECEIVED');
      const { rows: attemptRows } = await pool.query<{ state: string }>(
        `SELECT state FROM payment_attempt WHERE id = $1`,
        [reserved.paymentAttemptId],
      );
      expect(attemptRows[0]!.state).toBe('PENDING');

      // recovery can retry safely, now succeeding for real.
      const recovery = new WebhookRecoveryProcessor(db, processor);
      const result = await recovery.tick();
      expect(result.processed).toBeGreaterThanOrEqual(1);
      const { rows: finalPaymentRows } = await pool.query(
        `SELECT 1 FROM payment WHERE "sourceAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      expect(finalPaymentRows).toHaveLength(1);
    });
  });

  // ══════════════ §G11/§G12 — realtime branch-isolation envelope probe ════
  describe('realtime branch-isolation (outbox envelope probe)', () => {
    it('Company A / Branch X payment -> outbox row scoped exactly to X; Branch Y and Company 2 unaffected', async () => {
      const invoiceX = await freshInvoice(100n, COMPANY, BRANCH);
      const resultX = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        collection.captureSingleTenderInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId: invoiceX,
          method: 'CASH',
          amountMinor: 100n,
          createdByUserId: null,
          actingUserId: null,
          idempotencyKey: `g12-x-${uid()}`,
        }),
      );
      const row = await outboxRow('payments.payment_recorded', resultX.paymentId);
      expect(row.tenantId).toBe(TENANT);
      expect(row.companyId).toBe(COMPANY);
      expect(row.branchId).toBe(BRANCH);

      // a DIFFERENT branch (Y) never gets X's row.
      const { rows: branchYRows } = await pool.query(
        `SELECT 1 FROM outbox WHERE "eventType" = 'payments.payment_recorded' AND "aggregateId" = $1 AND "branchId" = $2`,
        [resultX.paymentId, BRANCH_2],
      );
      expect(branchYRows).toHaveLength(0);

      // a DIFFERENT company never gets it either.
      const { rows: company2Rows } = await pool.query(
        `SELECT 1 FROM outbox WHERE "eventType" = 'payments.payment_recorded' AND "aggregateId" = $1 AND "companyId" = $2`,
        [resultX.paymentId, COMPANY_2],
      );
      expect(company2Rows).toHaveLength(0);
    });
  });

  // ══════════════ §G16 — recovery multi-instance adversarial ══════════════
  it('two recovery instances + multiple RECEIVED events + one deliberately failing: healthy ones process, failing stays RECEIVED, later retry succeeds, no duplicates', async () => {
    const providerKey = `tap-g16-${uid()}`;
    const { credentialId } = await createCredentialAndEndpoint(providerKey);

    // two healthy events + one that will fail once via a Phase-2 test double.
    const invoices = await Promise.all([
      freshInvoice(100n),
      freshInvoice(100n),
      freshInvoice(100n),
    ]);
    const attempts = await Promise.all(
      invoices.map((invoiceId) =>
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          reservation.reserveAsyncAttemptInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 100n,
            providerKey,
            providerCredentialId: credentialId,
            createdByUserId: uid(),
            actingUserId: null,
            idempotencyKey: `g16-key-${uid()}`,
          }),
        ),
      ),
    );

    const eventIds = attempts.map(() => `evt-${uid()}`);
    // insert RECEIVED rows directly (bypassing signature verification, which
    // is proven exhaustively elsewhere) to control eventType/targetState —
    // this test targets the recovery loop, not the webhook ack path.
    const inboxIds: string[] = [];
    for (const [i, attempt] of attempts.entries()) {
      const result = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        inbox.insertVerifiedEventInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          providerCredentialId: credentialId,
          providerEventId: eventIds[i]!,
          eventType: 'x',
          payloadHash: `hash-${i}`,
          paymentAttemptId: attempt.paymentAttemptId,
          targetState: 'CAPTURED',
        }),
      );
      inboxIds.push(result.inboxId);
    }

    const failingInboxId = inboxIds[2]!;
    // two recovery instances tick CONCURRENTLY against the SAME batch, so
    // the poisoned candidate can receive up to one attempt from EACH
    // instance within that single wave — the fake must fail both of those
    // deterministically (regardless of which instance calls it) so the row
    // provably stays RECEIVED after the wave, succeeding only on the later,
    // separate retry below.
    class FailsTwiceForOne extends WebhookEventProcessorRepository {
      private attemptCount = 0;
      override async processVerifiedInboxEventInTx(
        tx: Parameters<WebhookEventProcessorRepository['processVerifiedInboxEventInTx']>[0],
        input: Parameters<WebhookEventProcessorRepository['processVerifiedInboxEventInTx']>[1],
      ) {
        if (input.inboxId === failingInboxId && this.attemptCount < 2) {
          this.attemptCount += 1;
          throw new Error('simulated failure for this one event');
        }
        return super.processVerifiedInboxEventInTx(tx, input);
      }
    }
    const flaky = new FailsTwiceForOne(new AuditWriter(db), new OutboxWriter(db));
    const recoveryA = new WebhookRecoveryProcessor(db, flaky);
    const recoveryB = new WebhookRecoveryProcessor(db, flaky);

    await inParallel(2, (i) => (i === 0 ? recoveryA.tick() : recoveryB.tick()));

    // healthy ones processed.
    expect(await attemptStateOf(attempts[0]!.paymentAttemptId)).toBe('CAPTURED');
    expect(await attemptStateOf(attempts[1]!.paymentAttemptId)).toBe('CAPTURED');
    // failing one remains RECEIVED / PENDING.
    const { rows: failingRows } = await pool.query<{ status: string }>(
      `SELECT status FROM provider_payment_event WHERE id = $1`,
      [failingInboxId],
    );
    expect(failingRows[0]!.status).toBe('RECEIVED');
    expect(await attemptStateOf(attempts[2]!.paymentAttemptId)).toBe('PENDING');

    // later retry succeeds.
    const retryResult = await recoveryA.tick();
    expect(retryResult.processed).toBeGreaterThanOrEqual(1);
    expect(await attemptStateOf(attempts[2]!.paymentAttemptId)).toBe('CAPTURED');

    // no duplicates for ANY of the three.
    for (const attempt of attempts) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment WHERE "sourceAttemptId" = $1`,
        [attempt.paymentAttemptId],
      );
      expect((rows[0] as { n: number }).n).toBe(1);
    }
  });

  async function attemptStateOf(attemptId: string): Promise<string> {
    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM payment_attempt WHERE id = $1`,
      [attemptId],
    );
    return rows[0]!.state;
  }

  // ══════════════ §G17/§G18 — E same-key concurrent recovery hard gates ═══
  describe('E same-key concurrent recovery hard gates', () => {
    function makeAttemptRepo(registry: PaymentProviderRegistry): PaymentAttemptRepository {
      return new PaymentAttemptRepository(db, reservation, providerConfig, registry);
    }

    it('§G17: concurrent identical requests -> one PaymentAttempt total, provider may be invoked more than once, ONE logical transition/event', async () => {
      const providerKey = `tap-g17-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      // Phase-1 attempt already exists PENDING (simulating "shared HTTP
      // idempotency claim absent/released").
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 150n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g17-key-shared`,
        }),
      );
      // a fixed principal must issue every concurrent call for the DB
      // fallback (createdByUserId) to correlate them to the SAME row —
      // re-derive it from the row itself.
      const { rows: actorRows } = await pool.query<{ createdByUserId: string }>(
        `SELECT "createdByUserId" FROM payment_attempt WHERE id = $1`,
        [reserved.paymentAttemptId],
      );
      const actorUserId = actorRows[0]!.createdByUserId;

      // retry-safe fake: always returns the SAME logical intent/reference.
      const registry = new PaymentProviderRegistry();
      const adapter = fakeCreateIntentAdapter({
        kind: 'result',
        result: { state: 'AUTHORIZED', providerReference: 'g17-shared-ref' },
      });
      registry.register(providerKey, adapter);
      const repo = makeAttemptRepo(registry);

      const { RequestContext, runWithContext } = await import('@flower/backend');
      const ctx = new RequestContext({
        requestId: uid(),
        tenantId: TENANT,
        userId: actorUserId,
        accountType: 'USER',
      });
      const call = () =>
        runWithContext(ctx, () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 150n,
            providerKey,
            idempotencyKey: 'g17-key-shared',
          }),
        );

      const results = await inParallel(3, () => call());
      // every settled result (fulfilled or a safely-caught retryable
      // rejection) must reference the SAME attempt id — assert on the
      // fulfilled ones, which must exist since the adapter never throws.
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof call>>> =>
          r.status === 'fulfilled',
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const f of fulfilled) {
        expect(f.value.paymentAttemptId).toBe(reserved.paymentAttemptId);
        expect(f.value.state).toBe('AUTHORIZED');
      }
      expect(adapter.callCount).toBeGreaterThanOrEqual(1); // may be >1 — never required to be exactly 1

      // exactly one attempt row, one real transition, one event, reservation
      // never duplicated.
      const { rows: allAttempts } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt WHERE "idempotencyKey" = 'g17-key-shared'`,
      );
      expect((allAttempts[0] as { n: number }).n).toBe(1);
      const { rows: events } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt_event WHERE "paymentAttemptId" = $1 AND "toState" = 'AUTHORIZED'`,
        [reserved.paymentAttemptId],
      );
      expect((events[0] as { n: number }).n).toBe(1);
      expect(await auditCount('payment_attempt.state_changed', reserved.paymentAttemptId)).toBe(1);
    });

    it('§G18: concurrent requests with the SAME key but a DIFFERENT amount -> IDEMPOTENCY_KEY_REUSED, original attempt unchanged, no second reservation', async () => {
      const providerKey = `tap-g18-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const actorUserId = uid();
      const idempotencyKey = 'g18-key-shared';
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 60n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: actorUserId,
          actingUserId: null,
          idempotencyKey,
        }),
      );

      const registry = new PaymentProviderRegistry();
      const adapter = fakeCreateIntentAdapter({ kind: 'result', result: { state: 'AUTHORIZED' } });
      registry.register(providerKey, adapter);
      const repo = makeAttemptRepo(registry);

      const { RequestContext, runWithContext } = await import('@flower/backend');
      const ctx = new RequestContext({
        requestId: uid(),
        tenantId: TENANT,
        userId: actorUserId,
        accountType: 'USER',
      });

      const results = await inParallel(3, () =>
        runWithContext(ctx, () =>
          repo.createAsyncAttemptForBranchScoped({
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'ONLINE_GATEWAY',
            amountMinor: 70n, // DIFFERENT amount, same key
            providerKey,
            idempotencyKey,
          }),
        ),
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.length).toBe(3);
      for (const r of rejected) {
        expect((r.reason as DomainError).code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect(adapter.callCount).toBe(0); // never called for the mismatched semantic operation

      const { rows } = await pool.query<{ amountMinor: string; state: string }>(
        `SELECT "amountMinor"::text AS "amountMinor", state FROM payment_attempt WHERE id = $1`,
        [reserved.paymentAttemptId],
      );
      expect(rows[0]!.amountMinor).toBe('60'); // unchanged
      expect(rows[0]!.state).toBe('PENDING');
      const { rows: countRows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_attempt WHERE "idempotencyKey" = $1`,
        [idempotencyKey],
      );
      expect((countRows[0] as { n: number }).n).toBe(1); // no second reservation
    });
  });

  // ══════════════ Checkpoint G proof pass §3 — audit actor attribution ═══
  describe('audit actor attribution (Checkpoint G proof pass §3)', () => {
    async function actorOf(
      action: string,
      resourceId: string,
    ): Promise<{ actorUserId: string | null; actorAccountType: string }> {
      const { rows } = await pool.query<{ actorUserId: string | null; actorAccountType: string }>(
        `SELECT "actorUserId", "actorAccountType" FROM audit_log WHERE action = $1 AND "resourceId" = $2`,
        [action, resourceId],
      );
      return rows[0]!;
    }

    it('C/D: a user-initiated synchronous Payment carries the authenticated request actor on its audit rows', async () => {
      const actorUserId = uid();
      const invoiceId = await freshInvoice(200n);
      const ctx = new RequestContext({
        requestId: uid(),
        tenantId: TENANT,
        userId: actorUserId,
        accountType: 'OWNER',
      });

      // `PaymentCollectionRepository` takes tenant/company/branch as EXPLICIT
      // input (it never reads `RequestContext` itself) — but `AuditWriter
      // .record` always falls back to the CALLING request's own ALS context
      // for `actorUserId`/`actorAccountType` when neither is passed
      // explicitly (which none of this module's audit.record calls ever
      // do). Wrapping the call in `runWithContext` is what the real HTTP
      // path already does (the auth guard establishes this context once per
      // request, and it propagates through every layer via Node's
      // AsyncLocalStorage) — this proves that mechanism actually attributes
      // the audit row correctly, not merely that it compiles.
      const result = await runWithContext(ctx, () =>
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          collection.captureSingleTenderInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            invoiceId,
            method: 'CASH',
            amountMinor: 200n,
            createdByUserId: actorUserId,
            actingUserId: actorUserId,
            idempotencyKey: `g3-cd-${uid()}`,
          }),
        ),
      );

      const paymentAudit = await actorOf('payment.recorded', result.paymentId);
      expect(paymentAudit.actorUserId).toBe(actorUserId);
      expect(paymentAudit.actorAccountType).toBe('OWNER');

      const attemptAudit = await actorOf('payment_attempt.state_changed', result.paymentAttemptId);
      expect(attemptAudit.actorUserId).toBe(actorUserId);
      expect(attemptAudit.actorAccountType).toBe('OWNER');
    });

    it('E: a user-initiated async reservation and its Phase-2 transition carry the authenticated request actor', async () => {
      const providerKey = `tap-g3-e-${uid()}`;
      await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const actorUserId = uid();
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeCreateIntentAdapter({ kind: 'result', result: { state: 'REQUIRES_ACTION' } }),
      );
      const repo = new PaymentAttemptRepository(db, reservation, providerConfig, registry);
      const ctx = new RequestContext({
        requestId: uid(),
        tenantId: TENANT,
        userId: actorUserId,
        accountType: 'USER',
      });

      const applied = await runWithContext(ctx, () =>
        repo.createAsyncAttemptForBranchScoped({
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey,
          idempotencyKey: `g3-e-key-${uid()}`,
        }),
      );

      const reservedAudit = await actorOf('payment_attempt.reserved', applied.paymentAttemptId);
      expect(reservedAudit.actorUserId).toBe(actorUserId);
      expect(reservedAudit.actorAccountType).toBe('USER');

      const transitionAudit = await actorOf(
        'payment_attempt.state_changed',
        applied.paymentAttemptId,
      );
      expect(transitionAudit.actorUserId).toBe(actorUserId);
      expect(transitionAudit.actorAccountType).toBe('USER');
    });

    it('F: a webhook-driven Payment and transition are NEVER attributed to a fabricated human actor', async () => {
      const providerKey = `tap-g3-f-${uid()}`;
      const { credentialId, endpointId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(), // the attempt's OWN business attribution — irrelevant to the audit actor below
          actingUserId: null,
          idempotencyKey: `g3-f-key-${uid()}`,
        }),
      );
      const registry = new PaymentProviderRegistry();
      registry.register(
        providerKey,
        fakeWebhookAdapter({
          kind: 'verifies',
          event: {
            providerEventId: `evt-${uid()}`,
            eventType: 'x',
            paymentAttemptId: reserved.paymentAttemptId,
            targetState: 'CAPTURED',
          },
        }),
      );
      const webhookRepo = new PaymentWebhookRepository(db, bootstrap, registry, inbox, processor);
      // deliberately NOT wrapped in `runWithContext` — a webhook request
      // carries no session/JWT/ALS context at all, exactly like production.
      await webhookRepo.handle({ endpointId, rawBody: Buffer.from('{}'), headers: {} });

      const { rows: paymentRows } = await pool.query<{ id: string }>(
        `SELECT id FROM payment WHERE "sourceAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      const paymentAudit = await actorOf('payment.recorded', paymentRows[0]!.id);
      expect(paymentAudit.actorUserId).toBeNull();
      expect(paymentAudit.actorAccountType).toBe('SYSTEM');

      const transitionAudit = await actorOf(
        'payment_attempt.state_changed',
        reserved.paymentAttemptId,
      );
      expect(transitionAudit.actorUserId).toBeNull();
      expect(transitionAudit.actorAccountType).toBe('SYSTEM');
    });

    it('F: a recovery-worker-driven transition is likewise never attributed to a fabricated human actor', async () => {
      const providerKey = `tap-g3-recovery-${uid()}`;
      const { credentialId } = await createCredentialAndEndpoint(providerKey);
      const invoiceId = await freshInvoice(200n);
      const reserved = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        reservation.reserveAsyncAttemptInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: 100n,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: uid(),
          actingUserId: null,
          idempotencyKey: `g3-recovery-key-${uid()}`,
        }),
      );
      const inboxResult = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        inbox.insertVerifiedEventInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          providerCredentialId: credentialId,
          providerEventId: `evt-${uid()}`,
          eventType: 'x',
          payloadHash: 'hash',
          paymentAttemptId: reserved.paymentAttemptId,
          targetState: 'CAPTURED',
        }),
      );
      // driven by the recovery worker's own `tick()` — no HTTP request, no
      // ALS context, ever.
      const recovery = new WebhookRecoveryProcessor(db, processor);
      const tickResult = await recovery.tick();
      expect(tickResult.processed).toBeGreaterThanOrEqual(1);
      void inboxResult;

      const { rows: paymentRows } = await pool.query<{ id: string }>(
        `SELECT id FROM payment WHERE "sourceAttemptId" = $1`,
        [reserved.paymentAttemptId],
      );
      const paymentAudit = await actorOf('payment.recorded', paymentRows[0]!.id);
      expect(paymentAudit.actorUserId).toBeNull();
      expect(paymentAudit.actorAccountType).toBe('SYSTEM');
    });
  });
});
