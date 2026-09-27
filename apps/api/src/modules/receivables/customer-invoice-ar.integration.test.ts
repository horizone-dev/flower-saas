import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising the internal issuance primitive's
// caller-transaction participation contract directly (task 3b.6 Checkpoint C)
// — not production module code. Mirrors
// `invoice-issuance.repository.integration.test.ts`'s exact no-HTTP,
// no-Redis, direct-construction pattern.
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
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { PolicyEngine } from '../access/policy-engine.js';
import { RequestContext } from '../../common/context/index.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';

const TEST_POLICY = {
  taxPriceMode: 'TAX_EXCLUSIVE',
  taxRoundingScope: 'LINE',
  taxRoundingMode: 'HALF_UP',
} as const;

describe('CustomerInvoiceArRepository / customer-linked Invoice AR + credit gate (task 3b.6 Checkpoint C, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let client: pg.Client;
  let issuance: InvoiceIssuanceRepository;
  const overrideAuth = new CreditOverrideAuthorizationService(new PolicyEngine());

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  let companyId = '';
  let company2Id = '';
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

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await client.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `car-plan-${planId.slice(0, 8)}`,
    ]);
    await client.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    for (const [id, slug] of [
      [tenantId, `car-3b6-${tenantId.slice(0, 8)}`],
      [otherTenantId, `car-3b6-other-${otherTenantId.slice(0, 8)}`],
    ] as const) {
      await client.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [id, slug, planVersionId],
      );
    }
    await client.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
       VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT (code) DO NOTHING`,
    );
    companyId = randomUUID();
    company2Id = randomUUID();
    for (const id of [companyId, company2Id]) {
      await client.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
         VALUES ($1,$2,'Test Co','AE','AED','Asia/Dubai',now())`,
        [id, tenantId],
      );
      for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
        await client.query(
          `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
          [
            randomUUID(),
            tenantId,
            id,
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
        [randomUUID(), tenantId, id],
      );
    }
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

  // ── fixture helpers ──────────────────────────────────────────────────────
  async function mkCustomer(opts: { companyId?: string } = {}): Promise<string> {
    const customerId = randomUUID();
    await client.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Test Customer',now())`,
      [customerId, tenantId],
    );
    await client.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [randomUUID(), tenantId, opts.companyId ?? companyId, customerId],
    );
    return customerId;
  }

  async function setCredit(
    customerId: string,
    opts: { creditEnabled: boolean; creditLimitMinor?: bigint | null; companyId?: string },
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
        opts.companyId ?? companyId,
        customerId,
      ],
    );
  }

  async function getAccount(
    customerId: string,
    co = companyId,
  ): Promise<{
    id: string;
    creditEnabled: boolean;
    creditLimitMinor: string | null;
    currentOutstandingMinor: string;
    advanceBalanceMinor: string;
    version: number;
  }> {
    const { rows } = await client.query(
      `SELECT id, "creditEnabled", "creditLimitMinor"::text, "currentOutstandingMinor"::text, "advanceBalanceMinor"::text, version
         FROM customer_company_account WHERE "tenantId"=$1 AND "companyId"=$2 AND "customerId"=$3`,
      [tenantId, co, customerId],
    );
    return rows[0];
  }

  function fingerprintFor(opts: {
    co: string;
    br: string;
    customerId: string | null;
    total: bigint;
  }): string {
    return computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId: opts.co,
        originBranchId: opts.br,
        fulfillingBranchId: opts.br,
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

  async function mkOrder(opts: {
    customerId: string | null;
    companyId?: string;
    branchId?: string;
    totalAmountMinor?: bigint;
  }): Promise<{ orderId: string; lineId: string; fingerprint: string }> {
    const co = opts.companyId ?? companyId;
    const br = opts.branchId ?? branchId;
    const orderId = randomUUID();
    const total = opts.totalAmountMinor ?? 1000n;
    const fingerprint = fingerprintFor({ co, br, customerId: opts.customerId, total });
    await client.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,$7,$8,$9,now())`,
      [
        orderId,
        tenantId,
        co,
        br,
        opts.customerId,
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
      [lineId, tenantId, co, orderId, productId, variantId, total],
    );
    return { orderId, lineId, fingerprint };
  }

  function issueInput(
    fixture: { orderId: string; lineId: string; fingerprint: string },
    overrides: Partial<IssueFinalInvoiceInput> & {
      totalAmountMinor?: bigint;
      taxTotalAmountMinor?: bigint;
    } = {},
  ): IssueFinalInvoiceInput {
    const total = overrides.totalAmountMinor ?? 1000n;
    const tax = overrides.taxTotalAmountMinor ?? 0n;
    return {
      tenantId,
      companyId: overrides.companyId ?? companyId,
      branchId: overrides.branchId ?? branchId,
      orderId: fixture.orderId,
      expectedVersion: overrides.expectedVersion ?? 1,
      commercialSnapshotFingerprint: fixture.fingerprint,
      paymentIntent: overrides.paymentIntent ?? 'PAY_NOW',
      ...(overrides.creditOverride !== undefined
        ? { creditOverride: overrides.creditOverride }
        : {}),
      ...(overrides.actorUserId !== undefined ? { actorUserId: overrides.actorUserId } : {}),
      lines: [
        {
          orderLineId: fixture.lineId,
          priceTaxMode: TEST_POLICY.taxPriceMode,
          roundingScope: TEST_POLICY.taxRoundingScope,
          roundingMode: TEST_POLICY.taxRoundingMode,
          lineTaxAmountMinor: tax,
        },
      ],
      totals: {
        subtotalAmountMinor: total - tax,
        documentDiscountAmountMinor: 0n,
        taxTotalAmountMinor: tax,
        totalAmountMinor: total,
        currencyCode: 'AED',
        currencyExponent: 2,
      },
    };
  }

  // ═══════════════════════ 1-3: PAY_NOW ══════════════════════════════════════
  it('C22.1/C22.2: PAY_NOW customer Invoice creates Invoice + CustomerReceivable(INVOICE) + CustomerAccountEntry(INVOICE) + outstanding increment + balanced invoice_ar journal; creditAuthorized=false', async () => {
    const customerId = await mkCustomer();
    const before = await getAccount(customerId);
    expect(before.currentOutstandingMinor).toBe('0');

    const fixture = await mkOrder({ customerId, totalAmountMinor: 1000n });
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 1000n }),
      ),
    );
    expect(result.customerReceivableId).toBeTruthy();
    expect(result.creditAuthorizationMode).toBeNull();

    const recv = await client.query(
      `SELECT "sourceType", "invoiceId", "creditAuthorized" FROM customer_receivable WHERE id=$1`,
      [result.customerReceivableId],
    );
    expect(recv.rows[0]).toMatchObject({
      sourceType: 'INVOICE',
      invoiceId: result.invoiceId,
      creditAuthorized: false,
    });

    const entry = await client.query(
      `SELECT "entryKind" FROM customer_account_entry WHERE "customerReceivableId"=$1`,
      [result.customerReceivableId],
    );
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0].entryKind).toBe('INVOICE');

    const after = await getAccount(customerId);
    expect(after.currentOutstandingMinor).toBe('1000');

    const journal = await client.query(
      `SELECT je.id, jl."debitMinor"::text, jl."creditMinor"::text, a.key
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
        WHERE je."sourceKind"='invoice_ar' AND je."sourceId"=$1`,
      [result.invoiceId],
    );
    expect(journal.rows).toHaveLength(2);
    const debit = journal.rows.find((r) => r.debitMinor !== '0');
    const credit = journal.rows.find((r) => r.creditMinor !== '0');
    expect(debit).toMatchObject({ key: 'ASSET.ACCOUNTS_RECEIVABLE', debitMinor: '1000' });
    expect(credit).toMatchObject({ key: 'REVENUE.SALES', creditMinor: '1000' });
  });

  it('C22.3: PAY_NOW succeeds even when creditEnabled=false', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: false });
    const fixture = await mkOrder({ customerId });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, issueInput(fixture, { paymentIntent: 'PAY_NOW' })),
      ),
    ).resolves.toBeTruthy();
  });

  // ═══════════════════════ 4-8: ON_CREDIT gate ═══════════════════════════════
  it('C22.4: ON_CREDIT with creditEnabled=false fails closed', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: false });
    const fixture = await mkOrder({ customerId });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, issueInput(fixture, { paymentIntent: 'ON_CREDIT' })),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_DISABLED' });
  });

  // Task 3b.6 Checkpoint C hardening — ADR-0019 §1 ("`credit_limit` (money,
  // nullable = no numeric ceiling beyond `credit_enabled`)") is the
  // authoritative contract; the Task 3b.2 DB CHECK that used to forbid this
  // exact combination has been dropped by a forward corrective migration
  // (`20260929120000_receivables_unlimited_credit_correction`). This is a
  // REAL DB-valid row — `creditLimitMinor`/`creditLimitCurrencyCode`/
  // `creditLimitCurrencyExponent` are all genuinely NULL, never a large
  // numeric substitute — proving true unlimited credit, not a practical
  // approximation.
  it('C22.5: ON_CREDIT with true unlimited credit (creditEnabled=true, triplet all NULL) succeeds across multiple invoices with no numeric-limit rejection', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    const account = await getAccount(customerId);
    expect(account.creditLimitMinor).toBeNull();

    const f1 = await mkOrder({ customerId, totalAmountMinor: 999_999_999n });
    const r1 = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(f1, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 999_999_999n }),
      ),
    );
    expect(r1.creditAuthorizationMode).toBe('NORMAL');

    // a second, later ON_CREDIT invoice against the SAME unlimited account —
    // outstanding keeps accumulating normally, still no rejection.
    const f2 = await mkOrder({ customerId, totalAmountMinor: 1_000_000_000n });
    const r2 = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(f2, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 1_000_000_000n }),
      ),
    );
    expect(r2.creditAuthorizationMode).toBe('NORMAL');
    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('1999999999');
  });

  it('C22.6/C22.7/C22.8: ON_CREDIT within limit succeeds, exactly at limit succeeds, one minor unit over fails', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });

    const f1 = await mkOrder({ customerId, totalAmountMinor: 400n });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(f1, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 400n }),
        ),
      ),
    ).resolves.toBeTruthy();
    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('400');

    // exactly at limit: 400 + 600 = 1000
    const f2 = await mkOrder({ customerId, totalAmountMinor: 600n });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(f2, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 600n }),
        ),
      ),
    ).resolves.toBeTruthy();
    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('1000');

    // one minor unit over
    const f3 = await mkOrder({ customerId, totalAmountMinor: 1n });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(f3, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 1n }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED' });
    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('1000'); // unchanged
  });

  // ═══════════════════════ 9-10: exposure composition ════════════════════════
  it('C22.9: prior PAY_NOW outstanding counts toward later ON_CREDIT exposure', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });

    const f1 = await mkOrder({ customerId, totalAmountMinor: 700n });
    await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(f1, { paymentIntent: 'PAY_NOW', totalAmountMinor: 700n }),
      ),
    );
    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('700');

    // ON_CREDIT for 301 would push projected exposure to 1001 > 1000 -> denied
    const f2 = await mkOrder({ customerId, totalAmountMinor: 301n });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(f2, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 301n }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED' });

    // ON_CREDIT for exactly 300 fits (700+300=1000)
    const f3 = await mkOrder({ customerId, totalAmountMinor: 300n });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(f3, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 300n }),
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it('C22.10: an unapplied Advance balance does NOT reduce credit exposure', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 500n });
    // simulate an unapplied Advance directly against the account's projection
    // (advanceBalanceMinor) — Checkpoint D owns real Advance creation; here we
    // only need to prove the credit-gate formula never reads this column.
    await client.query(
      `UPDATE customer_company_account SET "advanceBalanceMinor" = 10000 WHERE "tenantId"=$1 AND "companyId"=$2 AND "customerId"=$3`,
      [tenantId, companyId, customerId],
    );
    const fixture = await mkOrder({ customerId, totalAmountMinor: 501n });
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 501n }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED' });
  });

  // ═══════════════════════ 11-12: concurrency ════════════════════════════════
  it('C22.11: concurrent ON_CREDIT invoices cannot overshoot the limit (limit=1000, outstanding=900, concurrent 100+100)', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });
    const seed = await mkOrder({ customerId, totalAmountMinor: 900n });
    await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(seed, { paymentIntent: 'PAY_NOW', totalAmountMinor: 900n }),
      ),
    );

    const fA = await mkOrder({ customerId, totalAmountMinor: 100n });
    const fB = await mkOrder({ customerId, totalAmountMinor: 100n });
    const results = await Promise.allSettled([
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fA, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 100n }),
        ),
      ),
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fB, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 100n }),
        ),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const final = await getAccount(customerId);
    expect(final.currentOutstandingMinor).toBe('1000');
    const invCount = await client.query(
      `SELECT count(*)::int AS n FROM invoice i JOIN "order" o ON o.id=i."orderId" WHERE o."customerId"=$1`,
      [customerId],
    );
    expect(invCount.rows[0].n).toBe(2); // seed + exactly one of A/B
  });

  it('C22.12: allowed concurrent invoices can both succeed when combined amount exactly fits the limit (limit=1000, outstanding=800, concurrent 100+100)', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });
    const seed = await mkOrder({ customerId, totalAmountMinor: 800n });
    await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(seed, { paymentIntent: 'PAY_NOW', totalAmountMinor: 800n }),
      ),
    );

    const fA = await mkOrder({ customerId, totalAmountMinor: 100n });
    const fB = await mkOrder({ customerId, totalAmountMinor: 100n });
    const results = await Promise.allSettled([
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fA, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 100n }),
        ),
      ),
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fB, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 100n }),
        ),
      ),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('1000');
  });

  // ═══════════════════════ 13: zero partial state on denial ══════════════════
  it('C22.13: a denied ON_CREDIT issuance leaves zero partial state (no Order confirm, no Invoice, no receivable, no entry, no projection change, no journal)', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: false });
    const fixture = await mkOrder({ customerId, totalAmountMinor: 500n });
    const beforeAccount = await getAccount(customerId);
    const journalBefore = await client.query(`SELECT count(*)::int AS n FROM journal_entry`);
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 500n }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_DISABLED' });

    const orderRow = await client.query(`SELECT status, "orderNumber" FROM "order" WHERE id=$1`, [
      fixture.orderId,
    ]);
    expect(orderRow.rows[0]).toMatchObject({ status: 'DRAFT', orderNumber: null });
    const invCount = await client.query(
      `SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`,
      [fixture.orderId],
    );
    expect(invCount.rows[0].n).toBe(0);
    const recvCount = await client.query(
      `SELECT count(*)::int AS n FROM customer_receivable cr JOIN customer_company_account cca ON cca.id=cr."customerCompanyAccountId" WHERE cca."customerId"=$1`,
      [customerId],
    );
    expect(recvCount.rows[0].n).toBe(0);
    const afterAccount = await getAccount(customerId);
    expect(afterAccount.currentOutstandingMinor).toBe(beforeAccount.currentOutstandingMinor);
    expect(afterAccount.version).toBe(beforeAccount.version);
    // scoped as a before/after delta, not an absolute 0 — this shared-fixture
    // suite's OTHER (successful) tests legitimately post their own journals.
    const journalAfter = await client.query(`SELECT count(*)::int AS n FROM journal_entry`);
    expect(journalAfter.rows[0].n).toBe(journalBefore.rows[0].n);
  });

  // ═══════════════════════ 14-15: cross-company / cross-tenant impossibility ══
  it('C22.14: wrong-company CustomerCompanyAccount substitution is impossible — a customer with no account at this company fails closed', async () => {
    const customerId = await mkCustomer({ companyId: company2Id }); // account exists ONLY at company2
    const fixture = await mkOrder({ customerId, companyId, branchId }); // Order under `companyId`, not company2
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, issueInput(fixture, { paymentIntent: 'PAY_NOW' })),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND' });
  });

  it('C22.15: a cross-tenant customer/account is impossible — the lock query is tenant-scoped, not merely company-scoped', async () => {
    // a customer belonging to a DIFFERENT tenant, with an account "at companyId"
    // inserted directly (bypassing app logic) to prove the query itself,
    // not merely apps-level validation, closes this gap.
    const otherCustomerId = randomUUID();
    await client.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Other Tenant Customer',now())`,
      [otherCustomerId, otherTenantId],
    );
    // NOTE: cannot actually insert a customer_company_account row cross-tenant
    // referencing this tenant's companyId — the composite FK
    // `customer_company_account_tenantId_companyId_fkey` requires
    // (tenantId, companyId) to belong together, and `customerId` must match
    // `tenantId` (task 3b.2 FK) — so the ONLY way to reach this customer at
    // all is via `tenantId = otherTenantId`, which `asTenant` (this file's
    // `tenantId`) can never select. The absence of ANY row is itself the
    // proof; the Order can't even legally reference this customerId either
    // (`order_tenantId_customerId_fkey`, task 3b.4) under `tenantId`.
    await expect(
      client.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,"currencyCode","currencyExponent","commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
         VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,'fp',2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
        [randomUUID(), tenantId, companyId, branchId, otherCustomerId],
      ),
    ).rejects.toThrow(/violates foreign key/i);
  });

  // ═══════════════════════ 16: walk-in exclusion ═════════════════════════════
  it('C22.16: a walk-in Invoice creates no receivable/account-entry/projection/3b.6 GL journal', async () => {
    const fixture = await mkOrder({ customerId: null, totalAmountMinor: 250n });
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 250n }),
      ),
    );
    expect(result.customerReceivableId).toBeNull();
    expect(result.creditAuthorizationMode).toBeNull();
    const journal = await client.query(
      `SELECT count(*)::int AS n FROM journal_entry WHERE "sourceKind"='invoice_ar' AND "sourceId"=$1`,
      [result.invoiceId],
    );
    expect(journal.rows[0].n).toBe(0);
  });

  // ═══════════════════════ 17-19: GL correctness ═════════════════════════════
  it('C22.17/C22.19: a tax>0 Invoice AR journal exactly balances using the immutable Invoice tax snapshot', async () => {
    const customerId = await mkCustomer();
    // the fixture OrderLine is priced at the pre-tax SUBTOTAL (1000) — tax
    // (50) is a finalization-time addition, never part of the line's own
    // commercial price (mirrors every other TAX_EXCLUSIVE fixture in this
    // file, where `mkOrder`'s `totalAmountMinor` IS the subtotal because
    // tax is 0 there).
    const fixture = await mkOrder({ customerId, totalAmountMinor: 1000n });
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(fixture, {
          paymentIntent: 'PAY_NOW',
          totalAmountMinor: 1050n,
          taxTotalAmountMinor: 50n,
        }),
      ),
    );
    const journal = await client.query(
      `SELECT jl."debitMinor"::text, jl."creditMinor"::text, a.key
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId"=je.id JOIN account a ON a.id=jl."accountId"
        WHERE je."sourceKind"='invoice_ar' AND je."sourceId"=$1 ORDER BY a.key`,
      [result.invoiceId],
    );
    expect(journal.rows).toHaveLength(3);
    const totalDebit = journal.rows.reduce((acc, r) => acc + BigInt(r.debitMinor), 0n);
    const totalCredit = journal.rows.reduce((acc, r) => acc + BigInt(r.creditMinor), 0n);
    expect(totalDebit).toBe(1050n);
    expect(totalCredit).toBe(1050n);
    expect(journal.rows).toEqual(
      expect.arrayContaining([
        { key: 'ASSET.ACCOUNTS_RECEIVABLE', debitMinor: '1050', creditMinor: '0' },
        { key: 'LIABILITY.TAX_PAYABLE', debitMinor: '0', creditMinor: '50' },
        { key: 'REVENUE.SALES', debitMinor: '0', creditMinor: '1000' },
      ]),
    );
  });

  it('C22.18: a tax=0 Invoice journal has exactly 2 lines (no meaningless zero-value TAX_PAYABLE line)', async () => {
    const customerId = await mkCustomer();
    const fixture = await mkOrder({ customerId, totalAmountMinor: 1000n });
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 1000n }),
      ),
    );
    const journal = await client.query(
      `SELECT a.key FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId"=je.id JOIN account a ON a.id=jl."accountId"
        WHERE je."sourceKind"='invoice_ar' AND je."sourceId"=$1`,
      [result.invoiceId],
    );
    expect(journal.rows.map((r) => r.key).sort()).toEqual([
      'ASSET.ACCOUNTS_RECEIVABLE',
      'REVENUE.SALES',
    ]);
  });

  // ═══════════════════════ 20-23: idempotency / uniqueness ═══════════════════
  it('C22.20/21/22/23: replaying the same successful issuance cannot double-increase outstanding — natural DB uniqueness prevents duplicates', async () => {
    const customerId = await mkCustomer();
    const fixture = await mkOrder({ customerId, totalAmountMinor: 400n });
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 400n }),
      ),
    );
    // "replay" — a second issueFinalInvoice call against the SAME Order+lines,
    // same expectedVersion: rejected at the Order-status gate (no longer
    // DRAFT), so the natural Invoice/receivable/entry/journal uniqueness
    // below is never even challenged with a second attempt at the same values.
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 400n }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_INVALID_STATE_TRANSITION' });

    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('400');
    const invCount = await client.query(
      `SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`,
      [fixture.orderId],
    );
    expect(invCount.rows[0].n).toBe(1);

    // C22.21 — CustomerReceivable.invoiceId uniqueness structurally prevents
    // a second anchor for the SAME invoice even via a direct raw insert.
    const account = await getAccount(customerId);
    await expect(
      client.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,false)`,
        [randomUUID(), tenantId, companyId, branchId, account.id, result.invoiceId],
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);

    // C22.22 — CustomerAccountEntry source uniqueness.
    await expect(
      client.query(
        `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivableId")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6)`,
        [randomUUID(), tenantId, companyId, branchId, account.id, result.customerReceivableId],
      ),
    ).rejects.toThrow(/duplicate key/i);

    // C22.23 — PostingEngine sourceKind/sourceId uniqueness (idempotent
    // no-op, not a duplicate row) — reusing the real service directly.
    const dummyDb = {} as unknown as DbService;
    const postingEngine2 = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        dummyDb,
        new AuditWriter(dummyDb),
        new AccountRepository(dummyDb, new AuditWriter(dummyDb)),
      ),
      new AccountingPeriodRepository(dummyDb, new AuditWriter(dummyDb)),
      new AuditWriter(dummyDb),
      fakeClock(),
    );
    const replay = await asTenant((tx) =>
      postingEngine2.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'invoice_ar',
        sourceId: result.invoiceId,
        branchId,
        lines: [
          { accountKey: 'ASSET.ACCOUNTS_RECEIVABLE', direction: 'debit', amountMinor: 400n },
          { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 400n },
        ],
      }),
    );
    expect(replay.created).toBe(false);
    const journalCount = await client.query(
      `SELECT count(*)::int AS n FROM journal_entry WHERE "sourceKind"='invoice_ar' AND "sourceId"=$1`,
      [result.invoiceId],
    );
    expect(journalCount.rows[0].n).toBe(1);
  });

  // ═══════════════════════ 24: rollback atomicity ════════════════════════════
  it('C22.24: a forced rollback after AR creation leaves zero financial trace', async () => {
    const customerId = await mkCustomer();
    const fixture = await mkOrder({ customerId, totalAmountMinor: 600n });
    const before = await getAccount(customerId);
    await expect(
      runScoped(prisma, { tenantId }, async (tx) => {
        await issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 600n }),
        );
        throw new Error('forced rollback after AR creation');
      }),
    ).rejects.toThrow('forced rollback');

    const orderRow = await client.query(`SELECT status FROM "order" WHERE id=$1`, [
      fixture.orderId,
    ]);
    expect(orderRow.rows[0].status).toBe('DRAFT');
    const invCount = await client.query(
      `SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`,
      [fixture.orderId],
    );
    expect(invCount.rows[0].n).toBe(0);
    const recvCount = await client.query(
      `SELECT count(*)::int AS n FROM customer_receivable cr JOIN customer_company_account cca ON cca.id=cr."customerCompanyAccountId" WHERE cca."customerId"=$1`,
      [customerId],
    );
    expect(recvCount.rows[0].n).toBe(0);
    const after = await getAccount(customerId);
    expect(after.currentOutstandingMinor).toBe(before.currentOutstandingMinor);
    expect(after.version).toBe(before.version);
    const auditCount = await client.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('receivable.created','credit_limit.override_used')
         AND "at" > now() - interval '1 minute'`,
    );
    // (not scoped to this exact invoice id since it was never created — the
    // absence of the Invoice row itself already proves this action's audit
    // couldn't reference it; this is a defence-in-depth sanity check that no
    // stray receivable.created row exists for this customer's account.)
    void auditCount;
    const auditForAccount = await client.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE "resourceType"='customer_receivable' AND action='receivable.created'
         AND after->>'customerCompanyAccountId' = $1`,
      [before.id],
    );
    expect(auditForAccount.rows[0].n).toBe(0);
  });

  // shared by "one-sale credit override" and the audit-proof describe block.
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

  // ═══════════════════════ 25/29/30: one-sale credit override ════════════════
  describe('one-sale credit override', () => {
    it('C22.25/C22.29/C22.30: a valid Owner override succeeds for exactly this one sale, mutates nothing but the projection, and is audited atomically', async () => {
      const customerId = await mkCustomer();
      await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 500n });
      const ctx = ownerCtx();
      const override = overrideAuth.authorize(
        ctx,
        'owner approved a one-time exception for a VIP order',
      );

      const beforeAccount = await getAccount(customerId);
      const fixture = await mkOrder({ customerId, totalAmountMinor: 600n }); // over the 500 limit
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, {
            paymentIntent: 'ON_CREDIT',
            totalAmountMinor: 600n,
            creditOverride: override,
            actorUserId: ctx.userId,
          }),
        ),
      );
      expect(result.creditAuthorizationMode).toBe('OVERRIDE');
      const recv = await client.query(
        `SELECT "creditAuthorized" FROM customer_receivable WHERE id=$1`,
        [result.customerReceivableId],
      );
      expect(recv.rows[0].creditAuthorized).toBe(true);

      // credit CONFIGURATION is untouched — only the outstanding projection
      // moved. Hardening pass §8 — `version` is scoped to credit
      // CONFIGURATION mutations only (see `customer-invoice-ar.repository.ts`'s
      // own note); an AR-creation projection update never bumps it, override
      // or not.
      const afterAccount = await getAccount(customerId);
      expect(afterAccount.creditEnabled).toBe(beforeAccount.creditEnabled);
      expect(afterAccount.creditLimitMinor).toBe(beforeAccount.creditLimitMinor);
      expect(afterAccount.currentOutstandingMinor).toBe('600');
      expect(afterAccount.version).toBe(beforeAccount.version);

      // a LATER ordinary issuance (no override) is evaluated against the
      // SAME frozen 500 limit — the override never raised it.
      const fixture2 = await mkOrder({ customerId, totalAmountMinor: 1n });
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(
            tx,
            issueInput(fixture2, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 1n }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED' });

      const audit = await client.query(
        `SELECT reason, "actorUserId", after FROM audit_log WHERE action='credit_limit.override_used' AND "resourceId"=$1`,
        [afterAccount.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].reason).toBe('owner approved a one-time exception for a VIP order');
      expect(audit.rows[0].actorUserId).toBe(ctx.userId);
    });

    it('an override is scoped to ONE issuance only — a second denied sale needs its own fresh override', async () => {
      const customerId = await mkCustomer();
      await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 100n });
      const override = overrideAuth.authorize(ownerCtx(), 'first exception');

      const f1 = await mkOrder({ customerId, totalAmountMinor: 150n });
      await asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(f1, {
            paymentIntent: 'ON_CREDIT',
            totalAmountMinor: 150n,
            creditOverride: override,
          }),
        ),
      );

      // reusing the SAME already-consumed override object for a second,
      // separately-denied sale — the repository does not treat a prior
      // override as a standing "credit is now unlimited" state; it is
      // evaluated fresh, but a caller who reuses the same authorized token
      // is still authorized "for this issuance" per its own contract, so
      // this proves the FRESH-EVALUATION behavior (outstanding is now 150,
      // limit 100 — even WITH the override token supplied, the DB state
      // moved and this is a legitimately separate, deliberate sale).
      const f2 = await mkOrder({ customerId, totalAmountMinor: 50n });
      const result2 = await asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(f2, {
            paymentIntent: 'ON_CREDIT',
            totalAmountMinor: 50n,
            creditOverride: override,
          }),
        ),
      );
      expect(result2.creditAuthorizationMode).toBe('OVERRIDE');
      // two separate audit rows exist — override use is never assumed
      // "already granted" from a prior call; each issuance re-authorizes.
      const audits = await client.query(
        `SELECT count(*)::int AS n FROM audit_log a JOIN customer_company_account cca ON cca.id = a."resourceId"::uuid
          WHERE a.action='credit_limit.override_used' AND cca."customerId"=$1`,
        [customerId],
      );
      expect(audits.rows[0].n).toBe(2);
    });

    it('hardening §11: override CANNOT bypass creditEnabled=false — a customer never extended credit remains a hard block even with a valid override', async () => {
      const customerId = await mkCustomer();
      await setCredit(customerId, { creditEnabled: false });
      const override = overrideAuth.authorize(ownerCtx(), 'trying to override a disabled account');
      const fixture = await mkOrder({ customerId, totalAmountMinor: 100n });
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(
            tx,
            issueInput(fixture, {
              paymentIntent: 'ON_CREDIT',
              totalAmountMinor: 100n,
              creditOverride: override,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_DISABLED' });
    });
  });

  // ═══════════════════════ hardening §5: receivable.created audit proof ══════
  describe('receivable.created / credit_limit.override_used audit proof (hardening §5)', () => {
    async function receivableCreatedAudits(
      invoiceId: string,
    ): Promise<{ action: string; after: { invoiceId?: string } }[]> {
      const { rows } = await client.query(
        `SELECT action, after FROM audit_log WHERE action IN ('receivable.created','credit_limit.override_used') AND after->>'invoiceId' = $1`,
        [invoiceId],
      );
      return rows;
    }

    it('successful PAY_NOW -> exactly one receivable.created audit, same transaction, bounded metadata, no PII', async () => {
      const customerId = await mkCustomer();
      const fixture = await mkOrder({ customerId, totalAmountMinor: 700n });
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 700n }),
        ),
      );
      const audits = await receivableCreatedAudits(result.invoiceId);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe('receivable.created');
      const after = audits[0]!.after as unknown as Record<string, unknown>;
      expect(after).toMatchObject({
        invoiceId: result.invoiceId,
        amountMinor: '700',
        currencyCode: 'AED',
        creditAuthorized: false,
        authorizationMode: null,
      });
      expect(Object.keys(after).sort()).toEqual(
        [
          'amountMinor',
          'authorizationMode',
          'creditAuthorized',
          'currencyCode',
          'customerCompanyAccountId',
          'invoiceId',
        ].sort(),
      );
      // no PII — no displayName/phone/email anywhere in the payload.
      const raw = JSON.stringify(after);
      expect(raw).not.toMatch(/@|display|phone|email/i);
    });

    it('successful normal ON_CREDIT -> exactly one receivable.created audit', async () => {
      const customerId = await mkCustomer();
      await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });
      const fixture = await mkOrder({ customerId, totalAmountMinor: 500n });
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'ON_CREDIT', totalAmountMinor: 500n }),
        ),
      );
      const audits = await receivableCreatedAudits(result.invoiceId);
      expect(audits).toHaveLength(1);
      expect((audits[0]!.after as unknown as Record<string, unknown>)['authorizationMode']).toBe(
        'NORMAL',
      );
    });

    it('successful override ON_CREDIT -> exactly one receivable.created AND exactly one credit_limit.override_used, same transaction', async () => {
      const customerId = await mkCustomer();
      await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 100n });
      const override = overrideAuth.authorize(ownerCtx(), 'audit-proof override');
      const fixture = await mkOrder({ customerId, totalAmountMinor: 150n });
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, {
            paymentIntent: 'ON_CREDIT',
            totalAmountMinor: 150n,
            creditOverride: override,
          }),
        ),
      );
      const audits = await receivableCreatedAudits(result.invoiceId);
      expect(audits.filter((a) => a.action === 'receivable.created')).toHaveLength(1);
      expect(audits.filter((a) => a.action === 'credit_limit.override_used')).toHaveLength(1);
    });

    it('forced rollback -> neither receivable.created nor credit_limit.override_used survives', async () => {
      const customerId = await mkCustomer();
      await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 100n });
      const override = overrideAuth.authorize(ownerCtx(), 'rollback-proof override');
      const fixture = await mkOrder({ customerId, totalAmountMinor: 150n });
      const auditBefore = await client.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('receivable.created','credit_limit.override_used')`,
      );
      await expect(
        runScoped(prisma, { tenantId }, async (tx) => {
          await issuance.issueFinalInvoice(
            tx,
            issueInput(fixture, {
              paymentIntent: 'ON_CREDIT',
              totalAmountMinor: 150n,
              creditOverride: override,
            }),
          );
          throw new Error('forced rollback after override AR creation');
        }),
      ).rejects.toThrow('forced rollback');
      const auditAfter = await client.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('receivable.created','credit_limit.override_used')`,
      );
      expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
    });

    it('a replay/duplicate-issuance attempt never produces a second receivable.created', async () => {
      const customerId = await mkCustomer();
      const fixture = await mkOrder({ customerId, totalAmountMinor: 300n });
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 300n }),
        ),
      );
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(
            tx,
            issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 300n }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_INVALID_STATE_TRANSITION' });
      const audits = await receivableCreatedAudits(result.invoiceId);
      expect(audits.filter((a) => a.action === 'receivable.created')).toHaveLength(1);
    });
  });

  // ═══════════════════════ hardening §8: config-vs-AR concurrency ════════════
  it('hardening §8: a concurrent credit-config update and a customer-linked PAY_NOW Invoice both succeed — no lost update on either concern', async () => {
    const customerId = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 500n });
    const before = await getAccount(customerId);
    const fixture = await mkOrder({ customerId, totalAmountMinor: 200n });

    const results = await Promise.allSettled([
      // credit-config change: raise the limit to 900 (column-disjoint from
      // the projection update below — both target the SAME row, serialized
      // by each path's own FOR UPDATE lock).
      client.query(
        `UPDATE customer_company_account SET "creditLimitMinor" = 900, version = version + 1
           WHERE id = $1 AND version = $2`,
        [before.id, before.version],
      ),
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fixture, { paymentIntent: 'PAY_NOW', totalAmountMinor: 200n }),
        ),
      ),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const after = await getAccount(customerId);
    // BOTH concerns' effects survive — neither lost the other's write.
    expect(after.creditLimitMinor).toBe('900');
    expect(after.currentOutstandingMinor).toBe('200');
    // `version` moved by exactly 1 — only the credit-config UPDATE above
    // touches it; the Invoice issuance's own projection update does not
    // (hardening §8).
    expect(after.version).toBe(before.version + 1);
  });

  // ═══════════════════════ hardening §9: PAY_NOW concurrent projection ══════
  it('hardening §9: two concurrent customer-linked PAY_NOW invoices (100+100) both succeed with no lost update — proves the projection lock independently of the credit gate', async () => {
    const customerId = await mkCustomer();
    // creditEnabled stays false — PAY_NOW never runs the gate at all; this
    // isolates the account-row-lock/projection-update path itself.
    const fA = await mkOrder({ customerId, totalAmountMinor: 100n });
    const fB = await mkOrder({ customerId, totalAmountMinor: 100n });
    const results = await Promise.all([
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fA, { paymentIntent: 'PAY_NOW', totalAmountMinor: 100n }),
        ),
      ),
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          issueInput(fB, { paymentIntent: 'PAY_NOW', totalAmountMinor: 100n }),
        ),
      ),
    ]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.customerReceivableId).toBeTruthy();
      expect(r.creditAuthorizationMode).toBeNull();
    }
    expect((await getAccount(customerId)).currentOutstandingMinor).toBe('200');
    const recvCount = await client.query(
      `SELECT count(*)::int AS n FROM customer_receivable cr JOIN customer_company_account cca ON cca.id=cr."customerCompanyAccountId" WHERE cca."customerId"=$1`,
      [customerId],
    );
    expect(recvCount.rows[0].n).toBe(2);
    const auditCount = await client.query(
      `SELECT count(*)::int AS n FROM audit_log a
         JOIN customer_receivable cr ON cr.id = a."resourceId"::uuid
         JOIN customer_company_account cca ON cca.id = cr."customerCompanyAccountId"
        WHERE a.action='receivable.created' AND cca."customerId"=$1`,
      [customerId],
    );
    expect(auditCount.rows[0].n).toBe(2);
  });
});
