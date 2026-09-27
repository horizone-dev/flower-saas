import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped, ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import {
  InvoiceIssuanceRepository,
  type IssueFinalInvoiceInput,
} from '../orders/invoice-issuance.repository.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import { CustomerInvoiceArRepository } from './customer-invoice-ar.repository.js';
import { CreditOverrideAuthorizationService } from './credit-override-authorization.service.js';
import { OpeningBalanceRepository } from './opening-balance.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { PolicyEngine } from '../access/policy-engine.js';
import { RequestContext } from '../../common/context/index.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import type { DbService } from '../../common/data/index.js';

const TEST_POLICY = {
  taxPriceMode: 'TAX_EXCLUSIVE',
  taxRoundingScope: 'LINE',
  taxRoundingMode: 'HALF_UP',
} as const;

/**
 * Task 3b.6 Checkpoint F Final Hardening (§14/§15/§16/§17) — the REAL
 * production C credit-authorization path (`InvoiceIssuanceRepository` ->
 * `CustomerInvoiceArRepository.lockAndAuthorizeCredit`), not the pure
 * `evaluateCreditAuthorization` function in isolation, proven alongside the
 * REAL `OpeningBalanceRepository`. Mirrors
 * `customer-invoice-ar.integration.test.ts`'s own fixture harness exactly.
 */
describe('OpeningBalanceRepository vs real C credit-authorization path (Checkpoint F Final Hardening, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let client: pg.Client;
  let issuance: InvoiceIssuanceRepository;
  let openingBalance: OpeningBalanceRepository;
  const overrideAuth = new CreditOverrideAuthorizationService(new PolicyEngine());

  const tenantId = randomUUID();
  let companyId = '';
  let branchId = '';
  let productId = '';
  let variantId = '';

  function fakeClock(): SystemClock {
    return { now: () => new Date('2026-06-15T10:00:00Z') } as unknown as SystemClock;
  }

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runScoped(prisma, { tenantId }, fn);
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    client = new pg.Client({ connectionString: stack.postgres.url });
    await client.connect();

    const dummyDb = {} as unknown as DbService;
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        dummyDb,
        new AuditWriter(dummyDb),
        new AccountRepository(dummyDb, new AuditWriter(dummyDb)),
      ),
      new AccountingPeriodRepository(dummyDb, new AuditWriter(dummyDb)),
      new AuditWriter(dummyDb),
      fakeClock(),
    );
    const customerInvoiceAr = new CustomerInvoiceArRepository(
      postingEngine,
      new AuditWriter(dummyDb),
    );
    issuance = new InvoiceIssuanceRepository(
      new AuditWriter(dummyDb),
      fakeClock(),
      customerInvoiceAr,
    );
    openingBalance = new OpeningBalanceRepository(
      postingEngine,
      new CompanyFinancialConfigRepository(
        dummyDb,
        new AuditWriter(dummyDb),
        new AccountRepository(dummyDb, new AuditWriter(dummyDb)),
      ),
      new AuditWriter(dummyDb),
      new OutboxWriter(dummyDb),
    );

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await client.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `obc-plan-${planId.slice(0, 8)}`,
    ]);
    await client.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    await client.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
      [tenantId, `obc-3b6-${tenantId.slice(0, 8)}`, planVersionId],
    );
    await client.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
       VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT (code) DO NOTHING`,
    );
    companyId = randomUUID();
    await client.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
       VALUES ($1,$2,'Test Co','AE','AED','Asia/Dubai',now())`,
      [companyId, tenantId],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await client.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          randomUUID(),
          tenantId,
          companyId,
          a.key,
          a.category,
          a.defaultDisplayCode,
          a.defaultDisplayName,
        ],
      );
    }
    await client.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2026-01-01','2026-12-31','OPEN',now())`,
      [randomUUID(), tenantId, companyId],
    );
    branchId = randomUUID();
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main',now())`,
      [branchId, tenantId, companyId],
    );
    const categoryId = randomUUID();
    await client.query(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'flowers','Flowers',now())`,
      [categoryId, tenantId],
    );
    productId = randomUUID();
    await client.query(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy",status,"updatedAt")
       VALUES ($1,$2,$3,'rose','Rose','STOCKED','ACTIVE',now())`,
      [productId, tenantId, categoryId],
    );
    variantId = randomUUID();
    await client.query(
      `INSERT INTO variant (id,"tenantId","productId","nameEn",status,"baseUomCode","updatedAt")
       VALUES ($1,$2,$3,'Rose','ACTIVE','piece',now())`,
      [variantId, tenantId, productId],
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  // ── fixture helpers (mirrors customer-invoice-ar.integration.test.ts) ────
  async function mkCustomer(): Promise<string> {
    const customerId = randomUUID();
    await client.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Test Customer',now())`,
      [customerId, tenantId],
    );
    await client.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [randomUUID(), tenantId, companyId, customerId],
    );
    return customerId;
  }

  async function setCredit(
    customerId: string,
    opts: { creditEnabled: boolean; creditLimitMinor?: bigint | null },
  ): Promise<void> {
    const limitFields =
      opts.creditLimitMinor !== undefined && opts.creditLimitMinor !== null
        ? { minor: opts.creditLimitMinor, code: 'AED', exp: 2 }
        : { minor: null, code: null, exp: null };
    await client.query(
      `UPDATE customer_company_account
          SET "creditEnabled" = $1, "creditLimitMinor" = $2, "creditLimitCurrencyCode" = $3, "creditLimitCurrencyExponent" = $4
        WHERE "tenantId" = $5 AND "companyId" = $6 AND "customerId" = $7`,
      [
        opts.creditEnabled,
        limitFields.minor,
        limitFields.code,
        limitFields.exp,
        tenantId,
        companyId,
        customerId,
      ],
    );
  }

  async function getAccount(
    customerId: string,
  ): Promise<{ currentOutstandingMinor: string; advanceBalanceMinor: string }> {
    const { rows } = await client.query(
      `SELECT "currentOutstandingMinor"::text, "advanceBalanceMinor"::text
         FROM customer_company_account WHERE "tenantId"=$1 AND "companyId"=$2 AND "customerId"=$3`,
      [tenantId, companyId, customerId],
    );
    return rows[0];
  }

  function fingerprintFor(opts: { customerId: string | null; total: bigint }): string {
    return computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId: opts.customerId,
        kind: 'WALK_IN',
        currencyCode: 'AED',
        lines: [
          {
            productId,
            variantId,
            quantity: '1.0000',
            selectedUomCode: 'piece',
            baseUomCode: 'piece',
            conversionNumerator: '1',
            conversionDenominator: '1',
            unitPriceAmountMinor: opts.total.toString(),
            unitPriceCurrencyCode: 'AED',
            unitPriceCurrencyExponent: 2,
            discountMode: 'NONE',
            discountBps: null,
            discountAmountMinor: '0',
            taxCategoryKey: null,
            rateBps: null,
            effectiveFrom: null,
            resolutionSource: 'NONE',
          },
        ],
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      },
      TEST_POLICY,
    );
  }

  async function mkOrder(
    customerId: string,
    totalAmountMinor = 200,
  ): Promise<{
    orderId: string;
    lineId: string;
    fingerprint: string;
  }> {
    const orderId = randomUUID();
    const fingerprint = fingerprintFor({ customerId, total: BigInt(totalAmountMinor) });
    await client.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,$7,$8,$9,now())`,
      [
        orderId,
        tenantId,
        companyId,
        branchId,
        customerId,
        fingerprint,
        TEST_POLICY.taxPriceMode,
        TEST_POLICY.taxRoundingScope,
        TEST_POLICY.taxRoundingMode,
      ],
    );
    const lineId = randomUUID();
    await client.query(
      `INSERT INTO order_line
         (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
          "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
          "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
          "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'NONE','piece','Piece','piece',1,1,'Rose','Rose',now())`,
      [lineId, tenantId, companyId, orderId, productId, variantId, totalAmountMinor],
    );
    return { orderId, lineId, fingerprint };
  }

  function issueInput(
    fixture: { orderId: string; lineId: string; fingerprint: string },
    overrides: Partial<IssueFinalInvoiceInput> & { totalAmountMinor?: bigint } = {},
  ): IssueFinalInvoiceInput {
    const total = overrides.totalAmountMinor ?? 200n;
    return {
      tenantId,
      companyId,
      branchId,
      orderId: fixture.orderId,
      expectedVersion: overrides.expectedVersion ?? 1,
      commercialSnapshotFingerprint: fixture.fingerprint,
      paymentIntent: overrides.paymentIntent ?? 'ON_CREDIT',
      ...(overrides.creditOverride !== undefined
        ? { creditOverride: overrides.creditOverride }
        : {}),
      lines: [
        {
          orderLineId: fixture.lineId,
          priceTaxMode: TEST_POLICY.taxPriceMode,
          roundingScope: TEST_POLICY.taxRoundingScope,
          roundingMode: TEST_POLICY.taxRoundingMode,
          lineTaxAmountMinor: 0n,
        },
      ],
      totals: {
        subtotalAmountMinor: total,
        documentDiscountAmountMinor: 0n,
        taxTotalAmountMinor: 0n,
        totalAmountMinor: total,
        currencyCode: 'AED',
        currencyExponent: 2,
      },
    };
  }

  function ownerCtx(): RequestContext {
    return new RequestContext({
      requestId: 'req-override',
      tenantId,
      userId: randomUUID(),
      accountType: 'OWNER',
      mfaLevel: 'STEP_UP',
      companyScope: 'ALL',
      branchScope: 'ALL',
      effectivePermissions: ['customers:credit:override'],
    });
  }

  function createOpening(customerId: string, amountMinor: bigint, effectiveDate = '2026-01-10') {
    return asTenant((tx) =>
      openingBalance.createInTx(tx, {
        tenantId,
        companyId,
        branchId,
        customerId,
        type: 'RECEIVABLE',
        amountMinor,
        effectiveDate,
        actorUserId: null,
      }),
    );
  }

  // ═══════════════════════ §14 real concurrency ═════════════════════════════
  it('§14: creditLimit=1000 — concurrent (A) Opening Receivable=900 vs (B) real ON_CREDIT Invoice=200 -> exactly one valid serial outcome, no lost update', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });
    const fixture = await mkOrder(customerId, 200);

    // two independent Prisma-scoped transactions racing concurrently.
    const results = await Promise.allSettled([
      createOpening(customerId, 900n),
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, issueInput(fixture, { paymentIntent: 'ON_CREDIT' })),
      ),
    ]);

    const openingResult = results[0];
    const invoiceResult = results[1];
    const account = await getAccount(customerId);
    const outstanding = BigInt(account.currentOutstandingMinor);

    if (openingResult.status === 'fulfilled' && invoiceResult.status === 'rejected') {
      // CASE 1 — Opening won first: outstanding=900, 900+200 > 1000 -> Invoice denied.
      expect(outstanding).toBe(900n);
    } else if (openingResult.status === 'fulfilled' && invoiceResult.status === 'fulfilled') {
      // CASE 2 — Invoice won first (outstanding=200), Opening is historical
      // reality and is NOT gated by credit authorization at all -> both
      // succeed, final = 1100 (allowed to exceed the limit).
      expect(outstanding).toBe(1100n);
    } else {
      throw new Error(
        `unexpected outcome: opening=${openingResult.status}, invoice=${invoiceResult.status}`,
      );
    }
    // Opening Balance itself never calls the credit gate — proven separately
    // and unconditionally by §15/§17 below (creditDisabled/overLimit never
    // block Opening creation on their own).
  });

  // ═══════════════════════ §15 functional (real C path) ═════════════════════
  it('§15.A: creditEnabled=false — Opening Receivable succeeds; a REAL ON_CREDIT invoice is then rejected CUSTOMER_CREDIT_DISABLED', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: false });
    await expect(createOpening(customerId, 500n)).resolves.toBeDefined();

    const fixture = await mkOrder(customerId, 100);
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 100n }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_DISABLED' });
  });

  it('§15.B: creditLimit=100 — Opening Receivable=500 succeeds; a REAL ON_CREDIT invoice without override is rejected CUSTOMER_CREDIT_LIMIT_EXCEEDED', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 100n });
    await expect(createOpening(customerId, 500n)).resolves.toBeDefined();

    const fixture = await mkOrder(customerId, 50);
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 50n }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED' });
  });

  it('§15.C: same over-limit state — a valid frozen C Owner override still behaves exactly per its own frozen contract (succeeds, audited)', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 100n });
    await createOpening(customerId, 500n);

    const fixture = await mkOrder(customerId, 50);
    const override = overrideAuth.authorize(ownerCtx(), 'F-hardening override proof');
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(fixture, {
          paymentIntent: 'ON_CREDIT',
          creditOverride: override,
          totalAmountMinor: 50n,
        }),
      ),
    );
    expect(result.creditAuthorizationMode).toBe('OVERRIDE');
    const account = await getAccount(customerId);
    expect(BigInt(account.currentOutstandingMinor)).toBe(550n); // 500 opening + 50 invoice
  });

  // ═══════════════════════ §17 opening never mutates credit config ══════════
  it('§17: creating an Opening Receivable never mutates creditEnabled/creditLimitMinor/version', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 300n });
    const { rows: before } = await client.query(
      `SELECT "creditEnabled", "creditLimitMinor"::text, version FROM customer_company_account WHERE "tenantId"=$1 AND "companyId"=$2 AND "customerId"=$3`,
      [tenantId, companyId, customerId],
    );
    await createOpening(customerId, 700n); // exceeds the 300 limit — still allowed
    const { rows: after } = await client.query(
      `SELECT "creditEnabled", "creditLimitMinor"::text, version FROM customer_company_account WHERE "tenantId"=$1 AND "companyId"=$2 AND "customerId"=$3`,
      [tenantId, companyId, customerId],
    );
    expect(after[0]).toEqual(before[0]);
  });
});
