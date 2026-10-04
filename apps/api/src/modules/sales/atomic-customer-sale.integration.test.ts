import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test of the internal identified-customer atomic sale and the
// frozen 3b.6 primitives it composes — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { AccountRepository } from '../accounting/account.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { PolicyEngine } from '../access/policy-engine.js';
import { CreditNoteRepository } from '../orders/credit-note.repository.js';
import {
  computeCommercialSnapshotFingerprintV2,
  type CommercialSnapshotLine,
} from '../orders/commercial-snapshot.js';
import { InvoiceIssuanceRepository } from '../orders/invoice-issuance.repository.js';
import { OrderRepository } from '../orders/order.repository.js';
import { TaxFinalizationService } from '../orders/tax-finalization.service.js';
import { PaymentCollectionRepository } from '../payments/payment-collection.repository.js';
import { CreditOverrideAuthorizationService } from '../receivables/credit-override-authorization.service.js';
import { CustomerAccountReadRepository } from '../receivables/customer-account-read.repository.js';
import { CustomerAdvanceApplicationRepository } from '../receivables/customer-advance-application.repository.js';
import { CustomerInvoiceArRepository } from '../receivables/customer-invoice-ar.repository.js';
import { CustomerReceiptEffectsRepository } from '../receivables/customer-receipt-effects.repository.js';
import { PaymentAdvanceConversionRepository } from '../receivables/payment-advance-conversion.repository.js';
import { PaymentCustomerAttributionRepository } from '../receivables/payment-customer-attribution.repository.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  AtomicWalkInSaleService,
  type CompleteCustomerSaleInTxInput,
  type CompleteCustomerSaleResult,
  type CustomerSaleAdvanceInput,
  type SaleTenderInput,
} from './atomic-walk-in-sale.service.js';
import type { SalePlan } from './sale-plan.js';
import { WalkInSaleJournalRepository } from './walk-in-sale-journal.repository.js';

/**
 * Task 3b.9 Checkpoint D — the IDENTIFIED-CUSTOMER atomic sale, against real PostgreSQL:
 * customer PAY_NOW / ON_CREDIT, with local tenders and CustomerAdvance applications,
 * through the frozen 3b.6 accounting (invoice_ar → customer_receipt_payment →
 * payment_allocation → customer_advance_application) — and NEVER the anonymous
 * `walk_in_sale` journal.
 */

// ── instrumentation: observe (and optionally fault) every statement / model call ──
type TxEvent =
  | { kind: 'sql'; text: string; values: unknown[] }
  | { kind: 'model'; name: string; args: unknown[] }
  | { kind: 'tx-control'; name: string };

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function observe(tx: ScopedTx, onEvent: (e: TxEvent) => void): ScopedTx {
  const textOf = (first: unknown): string => {
    if (typeof first === 'string') return norm(first);
    if (Array.isArray(first)) return norm((first as string[]).join('?'));
    return norm(((first as { strings?: string[] } | undefined)?.strings ?? []).join('?'));
  };
  return new Proxy(tx as unknown as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop !== 'string') return value;
      if (
        prop === '$queryRaw' ||
        prop === '$executeRaw' ||
        prop === '$queryRawUnsafe' ||
        prop === '$executeRawUnsafe'
      ) {
        return (first: unknown, ...values: unknown[]) => {
          onEvent({ kind: 'sql', text: textOf(first), values });
          return (value as (...a: unknown[]) => unknown).call(target, first, ...values);
        };
      }
      if (prop === '$transaction' || prop === '$connect' || prop === '$disconnect') {
        return (...a: unknown[]) => {
          onEvent({ kind: 'tx-control', name: prop });
          return (value as (...x: unknown[]) => unknown).apply(target, a);
        };
      }
      if (!prop.startsWith('$') && value !== null && typeof value === 'object') {
        return new Proxy(value as object, {
          get(delegate, op) {
            const f = Reflect.get(delegate, op, delegate) as unknown;
            if (typeof f === 'function' && typeof op === 'string') {
              return (...a: unknown[]) => {
                onEvent({ kind: 'model', name: `${prop}.${op}`, args: a });
                return (f as (...x: unknown[]) => unknown).apply(delegate, a);
              };
            }
            return f;
          },
        });
      }
      return value;
    },
  }) as unknown as ScopedTx;
}

function lockTrace(events: TxEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind === 'tx-control') {
      out.push(`TX-CONTROL:${e.name}`);
    } else if (e.kind === 'model') {
      if (
        /^(order\.update|invoice\.create|orderLine\.update|customerReceivable\.create|customerAdvanceApplication\.create)$/.test(
          e.name,
        )
      ) {
        out.push(e.name);
      }
    } else {
      const t = e.text;
      if (/FROM "order" .*FOR UPDATE/.test(t)) out.push('order:FOR UPDATE');
      else if (/FROM "order" .*FOR SHARE/.test(t)) out.push('order:FOR SHARE');
      else if (/FROM "order_line" .*FOR UPDATE/.test(t)) out.push('order_line:FOR UPDATE');
      else if (/FROM "customer_company_account" .*FOR UPDATE/.test(t))
        out.push('account:FOR UPDATE');
      else if (/FROM "customer_advance" .*FOR UPDATE/.test(t)) out.push('advance:FOR UPDATE');
      else if (/INSERT INTO "document_number_counter"/.test(t)) {
        out.push(`counter:${String(e.values.find((v) => v === 'ORDER' || v === 'INVOICE'))}`);
      } else if (/FROM "invoice" .*FOR UPDATE/.test(t)) out.push('invoice:FOR UPDATE');
      else if (/INSERT INTO "payment_attempt"/.test(t)) out.push('INSERT payment_attempt');
      else if (/INSERT INTO "payment" /.test(t)) out.push('INSERT payment');
      else if (/INSERT INTO "payment_allocation"/.test(t)) out.push('INSERT payment_allocation');
      else if (/FROM "company" .*FOR SHARE/.test(t)) out.push('company:FOR SHARE');
      else if (/FROM "accounting_period" .*FOR SHARE/.test(t))
        out.push('accounting_period:FOR SHARE');
      else if (/FOR UPDATE/.test(t)) out.push(`OTHER:FOR UPDATE:${t.slice(0, 70)}`);
    }
  }
  return out;
}

class InjectedFault extends Error {
  constructor(label: string) {
    super(`INJECTED_FAULT:${label}`);
  }
}

describe('AtomicWalkInSaleService — identified-customer sale (task 3b.9 Checkpoint D, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let db: DbService;
  let prisma: PrismaClient;
  let svc: AtomicWalkInSaleService;

  let audit: AuditWriter;
  let outbox: OutboxWriter;
  let engine: PostingEngineService;
  let companyConfig: CompanyFinancialConfigRepository;
  let issuance: InvoiceIssuanceRepository;
  let finalization: TaxFinalizationService;
  let collection: PaymentCollectionRepository;
  let walkInJournal: WalkInSaleJournalRepository;
  let invoiceAr: CustomerInvoiceArRepository;
  let advanceApplication: CustomerAdvanceApplicationRepository;
  let conversion: PaymentAdvanceConversionRepository;
  let creditOverride: CreditOverrideAuthorizationService;
  let effects: CustomerReceiptEffectsRepository;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let orderRepo: OrderRepository;
  const read = new CustomerAccountReadRepository();

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actor = randomUUID();

  let productId = '';
  let variantId = '';

  interface Co {
    companyId: string;
    branchId: string;
    siblingBranchId: string;
    currency: 'AED' | 'KWD';
    exponent: number;
  }
  interface Cust {
    customerId: string;
    ccaId: string;
    co: Co;
  }
  let aed: Co;
  let aed2: Co;
  let kwd: Co;
  let closed: Co;

  const fakeClock = { now: () => new Date('2026-06-15T10:00:00Z') } as unknown as SystemClock;
  const asTenant = <T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> =>
    runScoped(prisma, { tenantId }, fn);

  // ── authorization contexts for the credit-limit override ─────────────────────
  const mkCtx = (o: { permissions?: string[]; stepUp?: boolean; userId?: string | null }) =>
    new RequestContext({
      requestId: randomUUID(),
      tenantId,
      accountType: 'USER',
      userId: o.userId === undefined ? actor : o.userId,
      mfaLevel: o.stepUp === false ? 'NONE' : 'STEP_UP',
      effectivePermissions: o.permissions ?? ['customers:credit:override'],
      entitlements: ['customers'],
    });
  const ownerCtx = (): RequestContext => mkCtx({});
  const noStepUpCtx = (): RequestContext => mkCtx({ stepUp: false });
  const noPermissionCtx = (): RequestContext => mkCtx({ permissions: ['customers:view'] });

  // ── fixtures ────────────────────────────────────────────────────────────────
  async function makeCompany(
    tid: string,
    o: { currency: 'AED' | 'KWD'; period: 'open' | 'closed'; tz?: string },
  ): Promise<Co> {
    const co: Co = {
      companyId: randomUUID(),
      branchId: randomUUID(),
      siblingBranchId: randomUUID(),
      currency: o.currency,
      exponent: o.currency === 'KWD' ? 3 : 2,
    };
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Sale Co','AE',$3,$4,'ACTIVE',now())`,
      [co.companyId, tid, o.currency, o.tz ?? 'Asia/Dubai'],
    );
    for (const [id, name] of [
      [co.branchId, 'Main'],
      [co.siblingBranchId, 'Sibling'],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [id, tid, co.companyId, name],
      );
    }
    if (tid === tenantId) {
      await asTenant((tx) =>
        accounts.ensureDefaultAccounts(tx, { tenantId: tid, companyId: co.companyId }),
      );
      const period = await asTenant((tx) =>
        periods.create(tx, {
          tenantId: tid,
          companyId: co.companyId,
          startDate: new Date('2026-06-01T00:00:00Z'),
          endDate: new Date('2026-06-30T00:00:00Z'),
        }),
      );
      if (o.period === 'closed') {
        await asTenant((tx) =>
          periods.close(tx, {
            tenantId: tid,
            companyId: co.companyId,
            id: period.id,
            expectedVersion: period.version,
            closedByUserId: null,
          }),
        );
      }
    }
    return co;
  }

  type Credit = { enabled: false } | { enabled: true; limit: bigint | null };

  /** a customer + its company account (credit configured per `credit`) */
  async function mkCustomer(
    co: Co,
    credit: Credit = { enabled: true, limit: null },
  ): Promise<Cust> {
    const customerId = randomUUID();
    const ccaId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Customer',now())`,
      [customerId, tenantId],
    );
    const limited = credit.enabled && credit.limit !== null;
    await pool.query(
      `INSERT INTO customer_company_account
         (id,"tenantId","companyId","customerId","creditEnabled","creditLimitMinor","creditLimitCurrencyCode","creditLimitCurrencyExponent","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [
        ccaId,
        tenantId,
        co.companyId,
        customerId,
        credit.enabled,
        limited ? (credit as { limit: bigint }).limit.toString() : null,
        limited ? co.currency : null,
        limited ? co.exponent : null,
      ],
    );
    return { customerId, ccaId, co };
  }

  /** a customer with NO account at this company (the account exists nowhere) */
  async function mkBareCustomer(): Promise<string> {
    const customerId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Bare',now())`,
      [customerId, tenantId],
    );
    return customerId;
  }

  /** a genuine PAYMENT-sourced CustomerAdvance: a raw unapplied CUSTOMER_RECEIPT converted by the REAL primitive */
  async function mkAdvance(
    c: Cust,
    amountMinor: bigint,
    branchId: string = c.co.branchId,
  ): Promise<string> {
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,$7,$8,'CAPTURED',$9, now())`,
      [
        attemptId,
        tenantId,
        c.co.companyId,
        branchId,
        c.ccaId,
        amountMinor.toString(),
        c.co.currency,
        c.co.exponent,
        `idem-${attemptId}`,
      ],
    );
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,$7,$8)`,
      [
        paymentId,
        tenantId,
        c.co.companyId,
        branchId,
        attemptId,
        amountMinor.toString(),
        c.co.currency,
        c.co.exponent,
      ],
    );
    const converted = await asTenant((tx) =>
      conversion.convertInTx(tx, {
        tenantId,
        companyId: c.co.companyId,
        branchId,
        customerId: c.customerId,
        paymentId,
        amountMinor,
        actorUserId: null,
      }),
    );
    return converted.advanceId;
  }

  interface LineSpec {
    quantity: string;
    unitPriceAmountMinor: bigint;
    discountAmountMinor?: bigint;
    rateBps: number | null;
  }
  interface OrderSpec {
    lines: LineSpec[];
    taxPriceMode?: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
    kind?: string;
    status?: 'DRAFT' | 'HELD' | 'CANCELLED';
  }
  interface MadeOrder {
    orderId: string;
    co: Co;
    branchId: string;
    customerId: string | null;
    version: number;
  }
  const one = (priceMinor: bigint, rateBps: number | null = 500): OrderSpec => ({
    lines: [{ quantity: '1.0000', unitPriceAmountMinor: priceMinor, rateBps }],
  });

  function snapshotLine(spec: LineSpec, co: Co): CommercialSnapshotLine {
    const amount = spec.discountAmountMinor ?? 0n;
    return {
      productId,
      variantId,
      quantity: spec.quantity,
      selectedUomCode: 'piece',
      baseUomCode: 'piece',
      conversionNumerator: '1',
      conversionDenominator: '1',
      unitPriceAmountMinor: spec.unitPriceAmountMinor.toString(),
      unitPriceCurrencyCode: co.currency,
      unitPriceCurrencyExponent: co.exponent,
      discountMode: amount > 0n ? 'AMOUNT' : 'NONE',
      discountBps: null,
      discountAmountMinor: amount.toString(),
      taxCategoryKey: spec.rateBps === null ? null : 'STANDARD',
      rateBps: spec.rateBps,
      effectiveFrom: spec.rateBps === null ? null : '2020-01-01',
      resolutionSource: spec.rateBps === null ? 'NONE' : 'VARIANT',
    };
  }

  /** one DRAFT order (customer-linked unless `customerId` is null), with a REAL frozen fingerprint */
  async function mkOrder(
    co: Co,
    customerId: string | null,
    spec: OrderSpec,
    branchId: string = co.branchId,
  ): Promise<MadeOrder> {
    const taxPriceMode = spec.taxPriceMode ?? 'TAX_EXCLUSIVE';
    const kind = spec.kind ?? 'WALK_IN';
    const fingerprint = computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId: co.companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId,
        kind,
        currencyCode: co.currency,
        lines: spec.lines.map((l) => snapshotLine(l, co)),
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      },
      { taxPriceMode, taxRoundingScope: 'LINE', taxRoundingMode: 'HALF_UP' },
    );
    const orderId = randomUUID();
    await pool.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountAmountMinor",
          "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,$6,'DRAFT',$7,$8,'NONE',0,$9,2,$10,'LINE','HALF_UP',now())`,
      [
        orderId,
        tenantId,
        co.companyId,
        branchId,
        customerId,
        kind,
        co.currency,
        co.exponent,
        fingerprint,
        taxPriceMode,
      ],
    );
    for (const [i, l] of spec.lines.entries()) {
      const amount = l.discountAmountMinor ?? 0n;
      await pool.query(
        `INSERT INTO order_line
           (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
            "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
            "discountMode","discountBps","discountAmountMinor",
            "taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
            "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
            "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot",
            "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15,
                 CASE WHEN $15::int IS NULL THEN NULL ELSE '2020-01-01'::date END,$16,
                 'piece','Piece','piece',1,1,'Rose','Rose',now())`,
        [
          randomUUID(),
          tenantId,
          co.companyId,
          orderId,
          i + 1,
          productId,
          variantId,
          l.quantity,
          l.unitPriceAmountMinor.toString(),
          co.currency,
          co.exponent,
          amount > 0n ? 'AMOUNT' : 'NONE',
          amount.toString(),
          l.rateBps === null ? null : 'STANDARD',
          l.rateBps,
          l.rateBps === null ? 'NONE' : 'VARIANT',
        ],
      );
    }
    let version = 1;
    if (spec.status === 'HELD' || spec.status === 'CANCELLED') {
      await pool.query(`UPDATE "order" SET status = $2, version = version + 1 WHERE id = $1`, [
        orderId,
        spec.status,
      ]);
      version = 2;
    }
    return { orderId, co, branchId, customerId, version };
  }

  const cash = (amountMinor: bigint): SaleTenderInput => ({ method: 'CASH', amountMinor });
  const bank = (amountMinor: bigint): SaleTenderInput => ({ method: 'BANK_TRANSFER', amountMinor });
  const card = (amountMinor: bigint): SaleTenderInput => ({ method: 'CARD_TERMINAL', amountMinor });
  const other = (amountMinor: bigint): SaleTenderInput => ({ method: 'OTHER_MANUAL', amountMinor });
  const adv = (advanceId: string, amountMinor: bigint): CustomerSaleAdvanceInput => ({
    advanceId,
    amountMinor,
  });

  interface SaleParts {
    intent?: string;
    tenders?: readonly SaleTenderInput[];
    advances?: readonly CustomerSaleAdvanceInput[];
    reason?: string | null;
    ctx?: RequestContext | null;
  }
  function saleInput(
    o: MadeOrder,
    p: SaleParts = {},
    over: Partial<CompleteCustomerSaleInTxInput> = {},
  ): CompleteCustomerSaleInTxInput {
    return {
      tenantId,
      companyId: o.co.companyId,
      branchId: o.branchId,
      orderId: o.orderId,
      expectedVersion: o.version,
      paymentIntent: p.intent ?? 'PAY_NOW',
      tenders: p.tenders ?? [],
      advances: p.advances ?? [],
      ...(p.reason !== undefined ? { creditLimitExceptionReason: p.reason } : {}),
      operationKey: `op-${randomUUID()}`,
      actorUserId: actor,
      authorizationContext: p.ctx === undefined ? null : p.ctx,
      ...over,
    };
  }
  const sale = (
    o: MadeOrder,
    p: SaleParts = {},
    over: Partial<CompleteCustomerSaleInTxInput> = {},
    service: AtomicWalkInSaleService = svc,
  ): Promise<CompleteCustomerSaleResult> =>
    asTenant((tx) => service.completeCustomerSaleInTx(tx, saleInput(o, p, over)));

  // ── readers ──────────────────────────────────────────────────────────────────
  const q = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

  async function invoiceOf(orderId: string) {
    const r = (
      await q<{ id: string; invoiceNumber: string; status: string; total: string; tax: string }>(
        `SELECT id, "invoiceNumber", "invoicePaymentStatus" AS status,
                "totalAmountMinor"::text AS total, "taxTotalAmountMinor"::text AS tax
           FROM invoice WHERE "orderId" = $1`,
        [orderId],
      )
    )[0];
    return r
      ? {
          id: r.id,
          number: r.invoiceNumber,
          status: r.status,
          total: BigInt(r.total),
          tax: BigInt(r.tax),
        }
      : null;
  }

  async function receivablesOf(invoiceId: string) {
    return q<{ id: string; sourceType: string; creditAuthorized: boolean; cca: string }>(
      `SELECT id, "sourceType", "creditAuthorized", "customerCompanyAccountId" AS cca
         FROM customer_receivable WHERE "invoiceId" = $1`,
      [invoiceId],
    );
  }

  async function paymentsOf(invoiceId: string) {
    const rows = await q<{
      paymentId: string;
      allocationId: string;
      method: string;
      amount: string;
      allocAmount: string;
      groupId: string | null;
      state: string;
    }>(
      `SELECT p.id AS "paymentId", pa.id AS "allocationId", p.method, p."amountMinor"::text AS amount,
              pa."amountMinor"::text AS "allocAmount", p."paymentGroupId" AS "groupId", att.state
         FROM payment_allocation pa
         JOIN payment p ON p.id = pa."paymentId"
         JOIN payment_attempt att ON att.id = p."sourceAttemptId"
        WHERE pa."invoiceId" = $1
        ORDER BY p."createdAt", p.id`,
      [invoiceId],
    );
    return rows.map((r) => ({
      ...r,
      amount: BigInt(r.amount),
      allocAmount: BigInt(r.allocAmount),
    }));
  }

  async function applicationsOf(receivableId: string) {
    const rows = await q<{
      id: string;
      advanceId: string;
      amount: string;
      createdBy: string | null;
    }>(
      `SELECT id, "customerAdvanceId" AS "advanceId", "amountMinor"::text AS amount, "createdByUserId" AS "createdBy"
         FROM customer_advance_application WHERE "customerReceivableId" = $1 ORDER BY "createdAt", id`,
      [receivableId],
    );
    return rows.map((r) => ({ ...r, amount: BigInt(r.amount) }));
  }

  async function accountOf(ccaId: string) {
    const r = (
      await q<{ o: string; a: string }>(
        `SELECT "currentOutstandingMinor"::text AS o, "advanceBalanceMinor"::text AS a FROM customer_company_account WHERE id = $1`,
        [ccaId],
      )
    )[0]!;
    return { outstanding: BigInt(r.o), advance: BigInt(r.a) };
  }

  async function advanceAvailable(_c: Cust, advanceId: string): Promise<bigint> {
    const r = (
      await q<{ principal: string; applied: string }>(
        `SELECT ca."amountMinor"::text AS principal,
                COALESCE((SELECT SUM(caa."amountMinor") FROM customer_advance_application caa WHERE caa."customerAdvanceId" = ca.id), 0)::text AS applied
           FROM customer_advance ca WHERE ca.id = $1`,
        [advanceId],
      )
    )[0]!;
    return BigInt(r.principal) - BigInt(r.applied);
  }

  /** every journal produced by THIS sale, rendered `kind|Dr KEY n;Cr KEY n` and sorted */
  async function saleJournals(invoiceId: string): Promise<string[]> {
    const pays = await paymentsOf(invoiceId);
    const rec = (await receivablesOf(invoiceId))[0];
    const apps = rec ? await applicationsOf(rec.id) : [];
    const ids = [
      invoiceId,
      ...pays.map((p) => p.paymentId),
      ...pays.map((p) => p.allocationId),
      ...apps.map((a) => a.id),
    ];
    const entries = await q<{ id: string; sourceKind: string }>(
      `SELECT id, "sourceKind" FROM journal_entry WHERE "tenantId" = $1 AND "sourceId" = ANY($2::text[])`,
      [tenantId, ids],
    );
    const out: string[] = [];
    for (const e of entries) {
      const lines = await q<{ key: string; debit: string; credit: string }>(
        `SELECT a."key" AS key, jl."debitMinor"::text AS debit, jl."creditMinor"::text AS credit
           FROM journal_line jl JOIN account a ON a.id = jl."accountId" WHERE jl."journalEntryId" = $1`,
        [e.id],
      );
      const rendered = lines
        .map((l) => ({ ...l, d: BigInt(l.debit), c: BigInt(l.credit) }))
        .sort((x, y) =>
          x.d > 0n !== y.d > 0n ? (x.d > 0n ? -1 : 1) : x.key < y.key ? -1 : x.key > y.key ? 1 : 0,
        )
        .map((l) => (l.d > 0n ? `Dr ${l.key} ${l.d}` : `Cr ${l.key} ${l.c}`));
      out.push(`${e.sourceKind}|${rendered.join(';')}`);
    }
    return out.sort();
  }

  /** net AR on the books for THIS sale's journals: Σ Dr AR − Σ Cr AR */
  async function arNet(invoiceId: string): Promise<{ ar: bigint; unapplied: bigint }> {
    const pays = await paymentsOf(invoiceId);
    const rec = (await receivablesOf(invoiceId))[0];
    const apps = rec ? await applicationsOf(rec.id) : [];
    const ids = [
      invoiceId,
      ...pays.map((p) => p.paymentId),
      ...pays.map((p) => p.allocationId),
      ...apps.map((a) => a.id),
    ];
    const r = (
      await q<{ ar: string; unapplied: string }>(
        `SELECT COALESCE(SUM(CASE WHEN a."key" = 'ASSET.ACCOUNTS_RECEIVABLE' THEN jl."debitMinor" - jl."creditMinor" END), 0)::text AS ar,
                COALESCE(SUM(CASE WHEN a."key" = 'LIABILITY.UNAPPLIED_RECEIPTS' THEN jl."creditMinor" - jl."debitMinor" END), 0)::text AS unapplied
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl."journalEntryId"
           JOIN account a ON a.id = jl."accountId"
          WHERE je."tenantId" = $1 AND je."sourceId" = ANY($2::text[])`,
        [tenantId, ids],
      )
    )[0]!;
    return { ar: BigInt(r.ar), unapplied: BigInt(r.unapplied) };
  }

  const EFFECT_TABLES = [
    'invoice',
    'payment_attempt',
    'payment_attempt_event',
    'payment',
    'payment_allocation',
    'journal_entry',
    'journal_line',
    'audit_log',
    'outbox',
    'customer_receivable',
    'customer_account_entry',
    'customer_advance',
    'customer_advance_application',
    'credit_note',
    'refund',
  ] as const;

  /** every table a sale touches + order state + customer projections + the company counters */
  async function snapshot(): Promise<Record<string, number | string>> {
    const out: Record<string, number | string> = {};
    for (const t of EFFECT_TABLES) {
      out[t] = (
        await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" = $1`, [
          tenantId,
        ])
      )[0]!.n;
    }
    out['orders'] = String(
      (
        await q<{ s: string | null }>(
          `SELECT string_agg(id::text || ':' || status || ':' || version::text || ':' || coalesce("orderNumber", ''), ',' ORDER BY id) AS s FROM "order" WHERE "tenantId" = $1`,
          [tenantId],
        )
      )[0]!.s,
    );
    out['accounts'] = String(
      (
        await q<{ s: string | null }>(
          `SELECT string_agg(id::text || ':' || "currentOutstandingMinor"::text || '/' || "advanceBalanceMinor"::text, ',' ORDER BY id) AS s FROM customer_company_account WHERE "tenantId" = $1`,
          [tenantId],
        )
      )[0]!.s,
    );
    out['counters'] = String(
      (
        await q<{ s: string | null }>(
          `SELECT string_agg("companyId"::text || ':' || "documentType" || ':' || "nextNumber"::text, ',' ORDER BY "companyId", "documentType") AS s FROM document_number_counter WHERE "tenantId" = $1`,
          [tenantId],
        )
      )[0]!.s,
    );
    return out;
  }

  async function nextNumbers(co: Co): Promise<{ order: string; invoice: string }> {
    const rows = await q<{ documentType: string; nextNumber: string }>(
      `SELECT "documentType", "nextNumber"::text AS "nextNumber" FROM document_number_counter WHERE "tenantId" = $1 AND "companyId" = $2`,
      [tenantId, co.companyId],
    );
    const n = (type: string, prefix: string): string =>
      `${prefix}-${String(rows.find((r) => r.documentType === type)?.nextNumber ?? '1').padStart(6, '0')}`;
    return { order: n('ORDER', 'ORD'), invoice: n('INVOICE', 'INV') };
  }

  async function auditActions(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const r of await q<{ k: string; n: number }>(
      `SELECT 'audit:' || action AS k, count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 GROUP BY action
       UNION ALL
       SELECT 'outbox:' || "eventType", count(*)::int FROM outbox WHERE "tenantId" = $1 GROUP BY "eventType"`,
      [tenantId],
    )) {
      m.set(r.k, r.n);
    }
    return m;
  }
  const diff = (
    before: Map<string, number>,
    after: Map<string, number>,
  ): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, n] of after) {
      const d = n - (before.get(k) ?? 0);
      if (d !== 0) out[k] = d;
    }
    return out;
  };

  // ── setup ───────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();

    audit = new AuditWriter(db);
    outbox = new OutboxWriter(db);
    accounts = new AccountRepository(db, audit);
    periods = new AccountingPeriodRepository(db, audit);
    companyConfig = new CompanyFinancialConfigRepository(db, audit, accounts);
    engine = new PostingEngineService(companyConfig, periods, audit, fakeClock);
    effects = new CustomerReceiptEffectsRepository(engine, audit);
    invoiceAr = new CustomerInvoiceArRepository(engine, audit);
    issuance = new InvoiceIssuanceRepository(
      audit,
      fakeClock,
      new CustomerInvoiceArRepository(engine, audit),
    );
    finalization = new TaxFinalizationService(issuance);
    collection = new PaymentCollectionRepository(
      audit,
      outbox,
      new PaymentCustomerAttributionRepository(),
      effects,
    );
    walkInJournal = new WalkInSaleJournalRepository(engine, companyConfig);
    advanceApplication = new CustomerAdvanceApplicationRepository(engine, audit, effects, outbox);
    conversion = new PaymentAdvanceConversionRepository(
      engine,
      audit,
      new PaymentCustomerAttributionRepository(),
      outbox,
    );
    creditOverride = new CreditOverrideAuthorizationService(new PolicyEngine());
    svc = new AtomicWalkInSaleService(
      db,
      finalization,
      collection,
      walkInJournal,
      invoiceAr,
      advanceApplication,
      creditOverride,
    );
    // the REAL frozen cancellation path (real CreditNoteRepository); only its permission gate
    // (not under test) is allowed so the frozen 3b.8 rules are what answers.
    orderRepo = new OrderRepository(
      db,
      audit,
      fakeClock,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { can: () => ({ allowed: true }) } as unknown as PolicyEngine,
      {} as never,
      new CreditNoteRepository(engine, audit),
    );

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `csale-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [id, `csale-${id.slice(0, 8)}`, planVersionId],
      );
    }
    await pool.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr")
       VALUES ('AED',2,'AED','x','x'),('KWD',3,'KWD','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel",active,"updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN',true,now()) ON CONFLICT (code) DO NOTHING`,
    );
    const categoryId = randomUUID();
    productId = randomUUID();
    variantId = randomUUID();
    await pool.query(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'flowers','Flowers',now())`,
      [categoryId, tenantId],
    );
    await pool.query(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy",status,"updatedAt")
       VALUES ($1,$2,$3,'rose','Rose','STOCKED','ACTIVE',now())`,
      [productId, tenantId, categoryId],
    );
    await pool.query(
      `INSERT INTO variant (id,"tenantId","productId","nameEn",status,"baseUomCode","updatedAt")
       VALUES ($1,$2,$3,'Rose','ACTIVE','piece',now())`,
      [variantId, tenantId, productId],
    );

    aed = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
    aed2 = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
    kwd = await makeCompany(tenantId, { currency: 'KWD', period: 'open', tz: 'Asia/Kuwait' });
    closed = await makeCompany(tenantId, { currency: 'AED', period: 'closed' });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await db?.onModuleDestroy();
    await stack?.stop();
  });

  /** a rejection leaves NO effect anywhere and burns nothing */
  async function expectRejected(
    o: MadeOrder,
    run: () => Promise<unknown>,
    code: string,
    status?: number,
  ): Promise<DomainError> {
    const before = await snapshot();
    const err = await run().then(
      () => {
        throw new Error(`expected ${code} but the call succeeded`);
      },
      (e: unknown) => e,
    );
    expect(err, String(err)).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    if (status !== undefined) expect((err as DomainError).status).toBe(status);
    expect(await snapshot()).toEqual(before);
    expect(await invoiceOf(o.orderId)).toBeNull();
    return err as DomainError;
  }

  const TOTAL = 10_500n; // 10 000 + 5 % tax
  const TAX = 500n;

  const receipt = (account: string, amt: bigint): string =>
    `customer_receipt_payment|Dr ${account} ${amt};Cr LIABILITY.UNAPPLIED_RECEIPTS ${amt}`;
  const allocation = (amt: bigint): string =>
    `payment_allocation|Dr LIABILITY.UNAPPLIED_RECEIPTS ${amt};Cr ASSET.ACCOUNTS_RECEIVABLE ${amt}`;
  const advanceJournal = (amt: bigint): string =>
    `customer_advance_application|Dr LIABILITY.CUSTOMER_ADVANCES ${amt};Cr ASSET.ACCOUNTS_RECEIVABLE ${amt}`;
  const invoiceArJournal = (total: bigint, tax: bigint): string =>
    `invoice_ar|Dr ASSET.ACCOUNTS_RECEIVABLE ${total};${tax > 0n ? `Cr LIABILITY.TAX_PAYABLE ${tax};` : ''}Cr REVENUE.SALES ${total - tax}`;
  const ACCOUNT_OF: Record<string, string> = {
    CASH: 'ASSET.CASH_ON_HAND',
    BANK_TRANSFER: 'ASSET.BANK',
    CARD_TERMINAL: 'ASSET.PAYMENT_CLEARING',
    OTHER_MANUAL: 'ASSET.PAYMENT_CLEARING',
  };

  /** the full set of proofs for one successful customer sale */
  async function expectCustomerSale(
    c: Cust,
    o: MadeOrder,
    res: CompleteCustomerSaleResult,
    p: {
      intent: 'PAY_NOW' | 'ON_CREDIT';
      tenders: SaleTenderInput[];
      advances: { id: string; amount: bigint }[];
      total?: bigint;
      tax?: bigint;
      status: string;
      accountBefore?: { outstanding: bigint; advance: bigint };
    },
  ): Promise<void> {
    const total = p.total ?? TOTAL;
    const tax = p.tax ?? TAX;
    const tenderSum = p.tenders.reduce((a, t) => a + t.amountMinor, 0n);
    const advSum = p.advances.reduce((a, x) => a + x.amount, 0n);
    const remainder = total - tenderSum - advSum;
    const inv = (await invoiceOf(o.orderId))!;
    expect(inv).not.toBeNull();
    expect(inv.total).toBe(total);
    expect(inv.tax).toBe(tax);
    expect(inv.status).toBe(p.status);
    expect(res.invoicePaymentStatus).toBe(p.status);
    expect(res.outstandingMinor).toBe(remainder);
    expect(res.paymentIntent).toBe(p.intent);
    expect(
      (
        await q<{ n: number }>(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
          o.orderId,
        ])
      )[0]!.n,
    ).toBe(1);

    // — exactly ONE receivable lifecycle: INVOICE-sourced, creditAuthorized only for ON_CREDIT
    const recs = await receivablesOf(inv.id);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      sourceType: 'INVOICE',
      creditAuthorized: p.intent === 'ON_CREDIT',
      cca: c.ccaId,
    });
    expect(res.customerReceivableId).toBe(recs[0]!.id);
    expect(res.customerId).toBe(c.customerId);
    expect(res.customerCompanyAccountId).toBe(c.ccaId);

    // — payments: REAL tenders only (credit is never a Payment), exact amounts
    const pays = await paymentsOf(inv.id);
    expect(pays.map((x) => [x.method, x.amount])).toEqual(
      p.tenders.map((t) => [t.method, t.amountMinor]),
    );
    for (const x of pays) {
      expect(x.allocAmount).toBe(x.amount);
      expect(x.state).toBe('CAPTURED');
    }
    expect(pays.some((x) => x.method === 'CREDIT')).toBe(false);
    if (p.tenders.length > 1) {
      expect(new Set(pays.map((x) => x.groupId)).size).toBe(1);
      expect(pays[0]!.groupId).toBe(res.paymentGroupId);
    } else {
      expect(res.paymentGroupId).toBeNull();
    }
    expect(res.payments.map((x) => [x.method, x.amountMinor])).toEqual(
      p.tenders.map((t) => [t.method, t.amountMinor]),
    );

    // — advance applications: exactly the planned amounts, in ascending advance-id order
    const apps = await applicationsOf(recs[0]!.id);
    const wanted = [...p.advances].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(res.advanceApplications.map((a) => [a.advanceId, a.amountMinor])).toEqual(
      wanted.map((a) => [a.id, a.amount]),
    );
    expect(
      [...apps]
        .sort((a, b) => (a.advanceId < b.advanceId ? -1 : 1))
        .map((a) => [a.advanceId, a.amount]),
    ).toEqual(wanted.map((a) => [a.id, a.amount]));
    for (const a of apps) expect(a.createdBy).toBe(actor); // the acting user is recorded, never dropped

    // — accounting: ONLY the frozen 3b.6 journals, never the anonymous one
    const journals = await saleJournals(inv.id);
    const expected = [
      invoiceArJournal(total, tax),
      ...p.tenders.flatMap((t) => [
        receipt(ACCOUNT_OF[t.method]!, t.amountMinor),
        allocation(t.amountMinor),
      ]),
      ...p.advances.map((a) => advanceJournal(a.amount)),
    ].sort();
    expect(journals).toEqual(expected);
    expect(journals.some((j) => j.startsWith('walk_in_sale'))).toBe(false);
    expect(
      (
        await q(
          `SELECT 1 FROM journal_entry WHERE "tenantId" = $1 AND "sourceKind" = 'walk_in_sale' AND "sourceId" = $2`,
          [tenantId, inv.id],
        )
      ).length,
    ).toBe(0);
    // the books agree with the receivable: AR nets to the remainder; every receipt was allocated
    const net = await arNet(inv.id);
    expect(net.ar).toBe(remainder);
    expect(net.unapplied).toBe(0n);

    // — the customer account projection
    const acct = await accountOf(c.ccaId);
    const before = p.accountBefore ?? { outstanding: 0n, advance: 0n };
    expect(acct.outstanding).toBe(before.outstanding + remainder);
    expect(acct.advance).toBe(before.advance - advSum);

    // — the frozen read model reflects it, with the projection integrity intact
    const summary = await asTenant((tx) =>
      read.getSummary(tx, {
        tenantId,
        companyId: o.co.companyId,
        branchId: o.branchId,
        customerId: c.customerId,
      }),
    );
    expect(summary.branchFinancials.receivableOutstandingMinor).toBe(
      before.outstanding + remainder,
    );
    expect(summary.branchFinancials.unappliedReceiptMinor).toBe(0n);
    expect(summary.credit.creditExposureMinor).toBe(before.outstanding + remainder);
    expect(summary.credit.projectionIntegrity).toEqual({
      receivableProjectionMatches: true,
      advanceProjectionMatches: true,
    });

    // — authority metadata: advances never inherit payments:collect
    expect(res.authorities.paymentCollection).toBe(p.tenders.length > 0);
    expect(res.authorities.advanceApplication).toBe(p.advances.length > 0);
    expect(res.authorities.permissionKeys).toEqual(
      [
        ...(p.tenders.length > 0 ? ['payments:collect'] : []),
        ...(p.advances.length > 0 ? ['receivables:advance:apply'] : []),
        ...(res.creditAuthorizationMode === 'OVERRIDE' ? ['customers:credit:override'] : []),
      ].sort(),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // 1. customer PAY_NOW
  // ═════════════════════════════════════════════════════════════════════════════
  describe('customer PAY_NOW — final coverage equals the invoice total exactly', () => {
    interface Case {
      name: string;
      tenders: SaleTenderInput[];
      advances: bigint[]; // each becomes its own PAYMENT-sourced advance of exactly that principal
      advancePrincipal?: bigint[]; // defaults to the applied amounts
      status: string;
    }
    const cases: Case[] = [
      { name: 'A. CASH full', tenders: [cash(TOTAL)], advances: [], status: 'SETTLED' },
      { name: 'B. BANK_TRANSFER full', tenders: [bank(TOTAL)], advances: [], status: 'SETTLED' },
      {
        name: 'C. manual CARD_TERMINAL full',
        tenders: [card(TOTAL)],
        advances: [],
        status: 'PAID',
      },
      { name: 'D. OTHER_MANUAL full', tenders: [other(TOTAL)], advances: [], status: 'PAID' },
      {
        name: 'E. Multi Payment CASH + BANK + manual CARD',
        tenders: [cash(5_000n), bank(3_000n), card(2_500n)],
        advances: [],
        status: 'PAID',
      },
      {
        name: 'E2. Multi Payment CASH + CASH (one account)',
        tenders: [cash(6_000n), cash(4_500n)],
        advances: [],
        status: 'SETTLED',
      },
      { name: 'F. advance-only PAY_NOW', tenders: [], advances: [TOTAL], status: 'SETTLED' },
      {
        name: 'F2. advance-only, advance LARGER than the sale (partial use)',
        tenders: [],
        advances: [TOTAL],
        advancePrincipal: [20_000n],
        status: 'SETTLED',
      },
      { name: 'G. CASH + advance', tenders: [cash(8_500n)], advances: [2_000n], status: 'SETTLED' },
      {
        name: 'G2. manual CARD + advance',
        tenders: [card(8_500n)],
        advances: [2_000n],
        status: 'PAID',
      },
      {
        name: 'H. Multi Payment (CASH + BANK) + advance',
        tenders: [cash(4_000n), bank(4_500n)],
        advances: [2_000n],
        status: 'SETTLED',
      },
      {
        name: 'H2. two advances (ascending order) + CASH',
        tenders: [cash(5_500n)],
        advances: [3_000n, 2_000n],
        status: 'SETTLED',
      },
    ];
    it.each(cases.map((c) => [c.name, c] as const))('%s', async (_n, cs) => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const advances: { id: string; amount: bigint }[] = [];
      for (const [i, amount] of cs.advances.entries()) {
        const principal = cs.advancePrincipal?.[i] ?? amount;
        advances.push({ id: await mkAdvance(c, principal), amount });
      }
      const accountBefore = await accountOf(c.ccaId);
      const nums = await nextNumbers(aed);

      const res = await sale(o, {
        intent: 'PAY_NOW',
        tenders: cs.tenders,
        advances: advances.map((a) => adv(a.id, a.amount)),
      });

      expect(res.invoiceNumber).toBe(nums.invoice);
      expect(res.orderNumber).toBe(nums.order);
      expect(res.creditAuthorizationMode).toBeNull(); // PAY_NOW never runs the credit gate
      expect(res.outstandingMinor).toBe(0n);
      await expectCustomerSale(c, o, res, {
        intent: 'PAY_NOW',
        tenders: cs.tenders,
        advances,
        status: cs.status,
        accountBefore,
      });
      // the advance projection: only the applied part of each advance was spent
      for (const [i, a] of advances.entries()) {
        expect(await advanceAvailable(c, a.id)).toBe(
          (cs.advancePrincipal?.[i] ?? cs.advances[i]!) - a.amount,
        );
      }
    });

    it('the opaque operation key and the acting user reach EVERY PaymentAttempt / Payment, unchanged', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const key = `op-fixed-${randomUUID()}`;
      const res = await sale(o, { tenders: [cash(5_000n), bank(5_500n)] }, { operationKey: key });
      const attempts = await q<{ key: string; acting: string | null; created: string | null }>(
        `SELECT "idempotencyKey" AS key, "actingUserId" AS acting, "createdByUserId" AS created
           FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [res.invoiceId],
      );
      expect(attempts).toHaveLength(2);
      for (const a of attempts) expect(a).toEqual({ key, acting: actor, created: actor });
      const payments = await q<{ acting: string | null; created: string | null }>(
        `SELECT p."actingUserId" AS acting, p."createdByUserId" AS created
           FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1`,
        [res.invoiceId],
      );
      for (const p of payments) expect(p).toEqual({ acting: actor, created: actor });
    });

    it('PAY_NOW never needs credit: a customer with credit DISABLED, or a tiny limit, pays in full', async () => {
      for (const credit of [
        { enabled: false } as Credit,
        { enabled: true, limit: 100n } as Credit,
      ]) {
        const c = await mkCustomer(aed, credit);
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        const res = await sale(o, { intent: 'PAY_NOW', tenders: [cash(TOTAL)] });
        expect(res.creditAuthorizationMode).toBeNull();
        expect(res.outstandingMinor).toBe(0n);
      }
    });

    it('KWD 3-decimal customer PAY_NOW (Multi Payment + advance) is exact end to end', async () => {
      const c = await mkCustomer(kwd);
      const o = await mkOrder(kwd, c.customerId, one(12_345n)); // tax 617 → total 12 962
      const advanceId = await mkAdvance(c, 2_962n);
      const accountBefore = await accountOf(c.ccaId);
      const res = await sale(o, {
        intent: 'PAY_NOW',
        tenders: [cash(6_000n), bank(4_000n)],
        advances: [adv(advanceId, 2_962n)],
      });
      await expectCustomerSale(c, o, res, {
        intent: 'PAY_NOW',
        tenders: [cash(6_000n), bank(4_000n)],
        advances: [{ id: advanceId, amount: 2_962n }],
        total: 12_962n,
        tax: 617n,
        status: 'SETTLED',
        accountBefore,
      });
      expect(res.currencyExponent).toBe(3);
    });

    it('an OPENING-sourced advance (one per account + branch) spends exactly like a payment-sourced one', async () => {
      const c = await mkCustomer(aed);
      const id = randomUUID();
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',3000,'AED',2,'2026-01-05')`,
        [id, tenantId, aed.companyId, aed.branchId, c.ccaId],
      );
      await pool.query(
        `UPDATE customer_company_account SET "advanceBalanceMinor" = 3000 WHERE id = $1`,
        [c.ccaId],
      );
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const accountBefore = await accountOf(c.ccaId);
      const res = await sale(o, {
        intent: 'PAY_NOW',
        tenders: [cash(7_500n)],
        advances: [adv(id, 3_000n)],
      });
      await expectCustomerSale(c, o, res, {
        intent: 'PAY_NOW',
        tenders: [cash(7_500n)],
        advances: [{ id, amount: 3_000n }],
        status: 'SETTLED',
        accountBefore,
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. ON_CREDIT
  // ═════════════════════════════════════════════════════════════════════════════
  describe('ON_CREDIT — the remainder is the customer receivable; credit is never a payment', () => {
    interface Case {
      name: string;
      tenders: SaleTenderInput[];
      advances: bigint[];
      status: string;
    }
    const cases: Case[] = [
      {
        name: 'A. full credit (no tender, no advance)',
        tenders: [],
        advances: [],
        status: 'UNPAID',
      },
      {
        name: 'B. cash + remaining credit',
        tenders: [cash(4_000n)],
        advances: [],
        status: 'PARTIAL',
      },
      {
        name: 'C. bank + remaining credit',
        tenders: [bank(6_000n)],
        advances: [],
        status: 'PARTIAL',
      },
      {
        name: 'D. Multi Payment + remaining credit',
        tenders: [cash(2_000n), bank(1_500n), card(1_000n)],
        advances: [],
        status: 'PARTIAL',
      },
      { name: 'E. advance + remaining credit', tenders: [], advances: [3_000n], status: 'PARTIAL' },
      {
        name: 'F. tender + advance + remaining credit',
        tenders: [cash(2_500n)],
        advances: [3_000n],
        status: 'PARTIAL',
      },
      {
        name: 'F2. Multi + two advances + remaining credit',
        tenders: [cash(1_000n), card(500n)],
        advances: [2_000n, 1_000n],
        status: 'PARTIAL',
      },
    ];
    it.each(cases.map((c) => [c.name, c] as const))('%s', async (_n, cs) => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const advances: { id: string; amount: bigint }[] = [];
      for (const amount of cs.advances) advances.push({ id: await mkAdvance(c, amount), amount });
      const accountBefore = await accountOf(c.ccaId);

      const res = await sale(o, {
        intent: 'ON_CREDIT',
        tenders: cs.tenders,
        advances: advances.map((a) => adv(a.id, a.amount)),
      });

      const remainder =
        TOTAL -
        cs.tenders.reduce((a, t) => a + t.amountMinor, 0n) -
        advances.reduce((a, x) => a + x.amount, 0n);
      expect(remainder).toBeGreaterThan(0n);
      expect(res.creditAuthorizationMode).toBe('NORMAL');
      await expectCustomerSale(c, o, res, {
        intent: 'ON_CREDIT',
        tenders: cs.tenders,
        advances,
        status: cs.status,
        accountBefore,
      });
    });

    it('ON_CREDIT that leaves NOTHING outstanding is refused (SALE_ON_CREDIT_FULLY_COVERED) — never silently converted to PAY_NOW', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const advanceId = await mkAdvance(c, 4_000n);
      await expectRejected(
        o,
        () =>
          sale(o, {
            intent: 'ON_CREDIT',
            tenders: [cash(6_500n)],
            advances: [adv(advanceId, 4_000n)],
          }),
        'SALE_ON_CREDIT_FULLY_COVERED',
        422,
      );
      expect(await advanceAvailable(c, advanceId)).toBe(4_000n);
    });

    it('the credit gate never ran for PAY_NOW and ran with mode NORMAL for ON_CREDIT within limit', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const a = await sale(await mkOrder(aed, c.customerId, one(10_000n)), {
        intent: 'PAY_NOW',
        tenders: [cash(TOTAL)],
      });
      const b = await sale(await mkOrder(aed, c.customerId, one(10_000n)), { intent: 'ON_CREDIT' });
      expect(a.creditAuthorizationMode).toBeNull();
      expect(b.creditAuthorizationMode).toBe('NORMAL');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3. gates and pre-issuance validation
  // ═════════════════════════════════════════════════════════════════════════════
  describe('gates and pre-issuance validation (nothing is numbered, nothing is written)', () => {
    it('an ANONYMOUS order is refused by the customer path (SALE_ORDER_NOT_CUSTOMER_LINKED), and a customer order by the anonymous path (frozen)', async () => {
      const anon = await mkOrder(aed, null, one(10_000n));
      await expectRejected(
        anon,
        () => sale(anon, { tenders: [cash(TOTAL)] }),
        'SALE_ORDER_NOT_CUSTOMER_LINKED',
        409,
      );
      const c = await mkCustomer(aed);
      const linked = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(
        linked,
        () =>
          asTenant((tx) =>
            svc.completeAnonymousPayNowInTx(tx, {
              tenantId,
              companyId: aed.companyId,
              branchId: aed.branchId,
              orderId: linked.orderId,
              expectedVersion: 1,
              paymentIntent: 'PAY_NOW',
              tenders: [cash(TOTAL)],
              operationKey: 'op',
              actorUserId: actor,
            }),
          ),
        'SALE_ORDER_CUSTOMER_LINKED',
        409,
      );
    });

    it.each([
      ['HELD', 'ORDER_INVALID_STATE_TRANSITION'],
      ['CANCELLED', 'ORDER_INVALID_STATE_TRANSITION'],
    ] as const)('a %s order → %s', async (status, code) => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, { ...one(10_000n), status });
      await expectRejected(o, () => sale(o, { tenders: [cash(TOTAL)] }), code, 409);
    });

    it('an already-sold order, a stale version, a missing version, a missing operation key, a non-WALK_IN order', async () => {
      const c = await mkCustomer(aed);
      const sold = await mkOrder(aed, c.customerId, one(10_000n));
      await sale(sold, { tenders: [cash(TOTAL)] });
      const before = await snapshot();
      const err = await sale(sold, { tenders: [cash(TOTAL)] }).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('ORDER_INVALID_STATE_TRANSITION');
      expect(await snapshot()).toEqual(before);

      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, { tenders: [cash(TOTAL)] }, { expectedVersion: 9 }),
        'ORDER_VERSION_CONFLICT',
        409,
      );
      await expectRejected(
        o,
        () =>
          sale(o, { tenders: [cash(TOTAL)] }, { expectedVersion: undefined as unknown as number }),
        'ORDER_VERSION_REQUIRED',
        422,
      );
      await expectRejected(
        o,
        () => sale(o, { tenders: [cash(TOTAL)] }, { operationKey: ' ' }),
        'SALE_OPERATION_KEY_REQUIRED',
        422,
      );
      const pickup = await mkOrder(aed, c.customerId, { ...one(10_000n), kind: 'PICKUP' });
      await expectRejected(
        pickup,
        () => sale(pickup, { tenders: [cash(TOTAL)] }),
        'SALE_ORDER_KIND_UNSUPPORTED',
        409,
      );
    });

    const cases: [string, SaleParts, string, number][] = [
      ['an unknown intent', { intent: 'BNPL', tenders: [cash(TOTAL)] }, 'SALE_INTENT_INVALID', 422],
      ['PAY_NOW underpaid', { tenders: [cash(10_499n)] }, 'SALE_NOT_FULLY_RESOLVED', 422],
      ['PAY_NOW with no tender and no advance', {}, 'SALE_NOT_FULLY_RESOLVED', 422],
      ['PAY_NOW overpaid', { tenders: [cash(10_501n)] }, 'SALE_OVERPAYMENT_NOT_ALLOWED', 422],
      [
        'ONLINE_GATEWAY (provider-backed)',
        { tenders: [{ method: 'ONLINE_GATEWAY', amountMinor: TOTAL }] },
        'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
        422,
      ],
      [
        'a provider-backed CARD_TERMINAL',
        {
          tenders: [
            { method: 'CARD_TERMINAL', amountMinor: TOTAL, providerCredentialId: randomUUID() },
          ],
        },
        'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
        422,
      ],
      [
        'CREDIT used as a tender',
        { intent: 'ON_CREDIT', tenders: [{ method: 'CREDIT', amountMinor: 1_000n }] },
        'SALE_TENDER_METHOD_UNSUPPORTED',
        422,
      ],
      ['a zero tender', { tenders: [cash(TOTAL), bank(0n)] }, 'PAYMENT_INVALID_AMOUNT', 422],
      [
        'a tender in another currency',
        {
          tenders: [
            { method: 'CASH', amountMinor: TOTAL, currencyCode: 'USD', currencyExponent: 2 },
          ],
        },
        'PAYMENT_CURRENCY_MISMATCH',
        422,
      ],
      [
        'a duplicated advance id',
        {
          advances: [
            adv('11111111-1111-4111-8111-111111111111', 100n),
            adv('11111111-1111-4111-8111-111111111111', 100n),
          ],
          tenders: [cash(10_300n)],
        },
        'SALE_DUPLICATE_ADVANCE',
        422,
      ],
      [
        'a malformed advance id',
        { advances: [adv('not-a-uuid', 100n)], tenders: [cash(10_400n)] },
        'SALE_ADVANCE_INVALID',
        422,
      ],
      [
        'a zero advance amount',
        { advances: [adv('11111111-1111-4111-8111-111111111111', 0n)], tenders: [cash(TOTAL)] },
        'PAYMENT_INVALID_AMOUNT',
        422,
      ],
      [
        'an advance declared in another currency',
        {
          advances: [
            {
              advanceId: '11111111-1111-4111-8111-111111111111',
              amountMinor: 100n,
              currencyCode: 'KWD',
              currencyExponent: 3,
            },
          ],
          tenders: [cash(10_400n)],
        },
        'PAYMENT_CURRENCY_MISMATCH',
        422,
      ],
    ];
    it.each(cases)(
      '%s → %s before any number is allocated',
      async (_label, parts, code, status) => {
        const c = await mkCustomer(aed, { enabled: true, limit: 100_000n });
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        await expectRejected(o, () => sale(o, parts), code, status);
      },
    );

    it('a ZERO-TOTAL customer sale is refused too (SALE_ZERO_TOTAL_NOT_SUPPORTED — the owner ruling covers every party)', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, {
        lines: [
          {
            quantity: '1.0000',
            unitPriceAmountMinor: 10_000n,
            discountAmountMinor: 10_000n,
            rateBps: 500,
          },
        ],
      });
      await expectRejected(
        o,
        () => sale(o, { intent: 'ON_CREDIT' }),
        'SALE_ZERO_TOTAL_NOT_SUPPORTED',
        422,
      );
    });

    it("no customer field exists: a forged customerId / customerCompanyAccountId in the request is ignored — the ORDER's customer is used", async () => {
      const real = await mkCustomer(aed);
      const forged = await mkCustomer(aed);
      const o = await mkOrder(aed, real.customerId, one(10_000n));
      const forgedInput = {
        ...saleInput(o, { tenders: [cash(TOTAL)] }),
        customerId: forged.customerId,
        customerCompanyAccountId: forged.ccaId,
      } as CompleteCustomerSaleInTxInput;
      const res = await asTenant((tx) => svc.completeCustomerSaleInTx(tx, forgedInput));
      expect(res.customerId).toBe(real.customerId);
      expect(res.customerCompanyAccountId).toBe(real.ccaId);
      expect((await receivablesOf(res.invoiceId))[0]!.cca).toBe(real.ccaId);
      expect(await accountOf(forged.ccaId)).toEqual({ outstanding: 0n, advance: 0n });
    });

    it('a rejected request stops at the gate / pre-flight: the trace holds only the order, line and account locks — no number', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeCustomerSaleInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, { tenders: [cash(100n)] }),
        ),
      ).catch(() => undefined);
      expect(lockTrace(events)).toEqual([
        'order:FOR UPDATE',
        'order:FOR UPDATE',
        'order_line:FOR UPDATE',
      ]);
    });

    it('the version gate precedes plan validation: a stale version AND a bad payment answer ORDER_VERSION_CONFLICT after ONE lock', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const events: TxEvent[] = [];
      const err = await asTenant((tx) =>
        svc.completeCustomerSaleInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, { tenders: [cash(1n)] }, { expectedVersion: 7 }),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('ORDER_VERSION_CONFLICT');
      expect(lockTrace(events)).toEqual(['order:FOR UPDATE']);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 4. advance pre-checks (refused before any number)
  // ═════════════════════════════════════════════════════════════════════════════
  describe('advance validation (same tenant / company / branch / customer, currency, balance)', () => {
    const trace = async (o: MadeOrder, parts: SaleParts): Promise<string[]> => {
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeCustomerSaleInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, parts),
        ),
      ).catch(() => undefined);
      return lockTrace(events);
    };

    it('an unknown advance id → CUSTOMER_ADVANCE_NOT_FOUND (404), refused before numbering', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, { advances: [adv(randomUUID(), 1_000n)], tenders: [cash(9_500n)] }),
        'CUSTOMER_ADVANCE_NOT_FOUND',
        404,
      );
      expect(
        await trace(o, { advances: [adv(randomUUID(), 1_000n)], tenders: [cash(9_500n)] }),
      ).toEqual([
        'order:FOR UPDATE',
        'order:FOR UPDATE',
        'order_line:FOR UPDATE',
        'account:FOR UPDATE',
      ]);
    });

    it("ANOTHER customer's advance (same company) is the same non-disclosing 404", async () => {
      const mine = await mkCustomer(aed);
      const theirs = await mkCustomer(aed);
      const theirAdvance = await mkAdvance(theirs, 5_000n);
      const o = await mkOrder(aed, mine.customerId, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, { advances: [adv(theirAdvance, 1_000n)], tenders: [cash(9_500n)] }),
        'CUSTOMER_ADVANCE_NOT_FOUND',
        404,
      );
      expect(await advanceAvailable(theirs, theirAdvance)).toBe(5_000n);
      // refused by the pre-check itself — before any number, not by a later step
      expect(
        await trace(o, { advances: [adv(theirAdvance, 1_000n)], tenders: [cash(9_500n)] }),
      ).toEqual([
        'order:FOR UPDATE',
        'order:FOR UPDATE',
        'order_line:FOR UPDATE',
        'account:FOR UPDATE',
      ]);
    });

    it('an advance of the SAME customer in a SIBLING branch is a 404 (no cross-branch pooling) and is not spent', async () => {
      const c = await mkCustomer(aed);
      const siblingAdvance = await mkAdvance(c, 5_000n, aed.siblingBranchId);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, { advances: [adv(siblingAdvance, 1_000n)], tenders: [cash(9_500n)] }),
        'CUSTOMER_ADVANCE_NOT_FOUND',
        404,
      );
      expect(await advanceAvailable(c, siblingAdvance)).toBe(5_000n);
      expect(
        await trace(o, { advances: [adv(siblingAdvance, 1_000n)], tenders: [cash(9_500n)] }),
      ).toEqual([
        'order:FOR UPDATE',
        'order:FOR UPDATE',
        'order_line:FOR UPDATE',
        'account:FOR UPDATE',
      ]);
    });

    it("a customer's advance at ANOTHER company is not reachable (each company has its own account)", async () => {
      const mine = await mkCustomer(aed);
      const otherCompany = await mkCustomer(aed2);
      const foreign = await mkAdvance(otherCompany, 5_000n);
      const o = await mkOrder(aed, mine.customerId, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, { advances: [adv(foreign, 1_000n)], tenders: [cash(9_500n)] }),
        'CUSTOMER_ADVANCE_NOT_FOUND',
        404,
      );
    });

    it('an advance with too little available balance → CUSTOMER_ADVANCE_APPLICATION_INVALID (409), refused before numbering', async () => {
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, 1_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, { advances: [adv(advanceId, 1_001n)], tenders: [cash(9_499n)] }),
        'CUSTOMER_ADVANCE_APPLICATION_INVALID',
        409,
      );
      expect(
        await trace(o, { advances: [adv(advanceId, 1_001n)], tenders: [cash(9_499n)] }),
      ).toEqual([
        'order:FOR UPDATE',
        'order:FOR UPDATE',
        'order_line:FOR UPDATE',
        'account:FOR UPDATE',
      ]);
    });

    it('an advance already partly spent: only the remainder may be applied', async () => {
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, 3_000n);
      const first = await mkOrder(aed, c.customerId, one(10_000n));
      await sale(first, { advances: [adv(advanceId, 2_000n)], tenders: [cash(8_500n)] });
      const second = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(
        second,
        () => sale(second, { advances: [adv(advanceId, 1_500n)], tenders: [cash(9_000n)] }),
        'CUSTOMER_ADVANCE_APPLICATION_INVALID',
        409,
      );
      const ok = await sale(second, {
        advances: [adv(advanceId, 1_000n)],
        tenders: [cash(9_500n)],
      });
      expect(ok.advanceApplications).toHaveLength(1);
      expect(await advanceAvailable(c, advanceId)).toBe(0n);
    });

    it('DB pin: an advance can only carry the company accounting currency, so a wrong-currency advance cannot exist', async () => {
      const c = await mkCustomer(aed);
      await expect(
        pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
           VALUES ($1,$2,$3,$4,$5,'OPENING',1000,'KWD',3,'2026-01-05')`,
          [randomUUID(), tenantId, aed.companyId, aed.branchId, c.ccaId],
        ),
      ).rejects.toThrow();
    });

    it('a customer with NO account at this company → CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND (404), refused before numbering', async () => {
      const bare = await mkBareCustomer();
      const o = await mkOrder(aed, bare, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, { tenders: [cash(TOTAL)] }),
        'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND',
        404,
      );
      // a reason from a non-owner does not change that answer either
      await expectRejected(
        o,
        () => sale(o, { intent: 'ON_CREDIT', reason: 'please', ctx: noPermissionCtx() }),
        'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND',
        404,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5. the credit-limit matrix
  // ═════════════════════════════════════════════════════════════════════════════
  describe('credit limit — FULL ON_CREDIT sales (the whole invoice is the exposure); partial coverage is in 5b below', () => {
    const credit = (_c: Cust, intentOver: Partial<SaleParts> = {}) =>
      ({ intent: 'ON_CREDIT', ...intentOver }) as SaleParts;

    it('credit DISABLED → CUSTOMER_CREDIT_DISABLED (422) — and an override can NEVER buy credit the customer was never given', async () => {
      const c = await mkCustomer(aed, { enabled: false });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(o, () => sale(o, credit(c)), 'CUSTOMER_CREDIT_DISABLED', 422);
      await expectRejected(
        o,
        () => sale(o, credit(c, { reason: 'the owner approved it', ctx: ownerCtx() })),
        'CUSTOMER_CREDIT_DISABLED',
        422,
      );
      // …and a NON-owner supplying a reason still gets the real answer (422), never an authorization 403
      await expectRejected(
        o,
        () => sale(o, credit(c, { reason: 'please', ctx: noPermissionCtx() })),
        'CUSTOMER_CREDIT_DISABLED',
        422,
      );
    });

    it('credit ENABLED with NO limit configured (null triplet) = unlimited credit (frozen 3b.6 semantics)', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: null });
      const o = await mkOrder(aed, c.customerId, one(900_000n));
      const res = await sale(o, credit(c));
      expect(res.creditAuthorizationMode).toBe('NORMAL');
      expect(res.outstandingMinor).toBe(945_000n);
    });

    it('within the limit → allowed; EXACTLY at the limit → allowed; ONE minor unit over → CUSTOMER_CREDIT_LIMIT_EXCEEDED (409)', async () => {
      const within = await mkCustomer(aed, { enabled: true, limit: 20_000n });
      expect(
        (await sale(await mkOrder(aed, within.customerId, one(10_000n)), credit(within)))
          .creditAuthorizationMode,
      ).toBe('NORMAL');

      const exact = await mkCustomer(aed, { enabled: true, limit: TOTAL });
      expect(
        (await sale(await mkOrder(aed, exact.customerId, one(10_000n)), credit(exact)))
          .creditAuthorizationMode,
      ).toBe('NORMAL');
      expect((await accountOf(exact.ccaId)).outstanding).toBe(TOTAL);

      const over = await mkCustomer(aed, { enabled: true, limit: TOTAL - 1n });
      const o = await mkOrder(aed, over.customerId, one(10_000n));
      await expectRejected(o, () => sale(o, credit(over)), 'CUSTOMER_CREDIT_LIMIT_EXCEEDED', 409);
    });

    it('existing outstanding + the new sale: under the limit allowed, over the limit refused', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 20_000n });
      await sale(await mkOrder(aed, c.customerId, one(10_000n)), credit(c)); // outstanding 10 500
      const under = await mkOrder(aed, c.customerId, one(9_000n)); // 9 450 → 19 950 ≤ 20 000
      expect((await sale(under, credit(c))).creditAuthorizationMode).toBe('NORMAL');
      expect((await accountOf(c.ccaId)).outstanding).toBe(19_950n);
      const over = await mkOrder(aed, c.customerId, one(100n)); // +105 → 20 055 > 20 000
      await expectRejected(
        over,
        () => sale(over, credit(c)),
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        409,
      );
    });

    it('the exposure counts only what is STILL owed: a settled sale frees headroom again', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 10_500n });
      const first = await mkOrder(aed, c.customerId, one(10_000n));
      await sale(first, credit(c)); // outstanding 10 500 = limit
      const blocked = await mkOrder(aed, c.customerId, one(100n));
      await expectRejected(
        blocked,
        () => sale(blocked, credit(c)),
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        409,
      );
      // the customer pays the first invoice off through the frozen direct-payment primitive
      const inv = (await invoiceOf(first.orderId))!;
      await asTenant((tx) =>
        collection.captureSynchronousTendersInTx(tx, {
          tenantId,
          companyId: aed.companyId,
          branchId: aed.branchId,
          invoiceId: inv.id,
          amountMinor: TOTAL,
          tenders: [{ method: 'CASH' as const, amountMinor: TOTAL }],
          createdByUserId: actor,
          actingUserId: actor,
          idempotencyKey: `pay-${randomUUID()}`,
        }),
      );
      expect((await accountOf(c.ccaId)).outstanding).toBe(0n);
      expect((await sale(blocked, credit(c))).creditAuthorizationMode).toBe('NORMAL');
    });

    it('MANDATORY — two concurrent ON_CREDIT sales, each valid alone, jointly over the limit: exactly one wins and the limit holds', async () => {
      for (let round = 0; round < 3; round += 1) {
        const c = await mkCustomer(aed, { enabled: true, limit: 10_000n });
        const a = await mkOrder(aed, c.customerId, one(6_000n)); // 6 300
        const b = await mkOrder(aed, c.customerId, one(6_000n));
        const settled = await Promise.allSettled([sale(a, credit(c)), sale(b, credit(c))]);
        const ok = settled.filter((s) => s.status === 'fulfilled');
        const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(1);
        expect(bad[0]!.reason).toBeInstanceOf(DomainError);
        expect((bad[0]!.reason as DomainError).code).toBe('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
        expect(String((bad[0]!.reason as Error).message)).not.toMatch(/40P01|deadlock/i);
        // the committed state never exceeds the limit
        expect((await accountOf(c.ccaId)).outstanding).toBe(6_300n);
        expect((await accountOf(c.ccaId)).outstanding <= 10_000n).toBe(true);
        // the loser left nothing behind
        const invoices = await Promise.all([a, b].map((o) => invoiceOf(o.orderId)));
        expect(invoices.filter((i) => i === null)).toHaveLength(1);
      }
    }, 120_000);

    it('MANDATORY — six concurrent ON_CREDIT sales against one limit: exactly floor(limit / sale) win; the limit is never exceeded', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 10_000n });
      const orders = await Promise.all(
        Array.from({ length: 6 }, () => mkOrder(aed, c.customerId, one(3_000n))),
      ); // 3 150 each
      const settled = await Promise.allSettled(orders.map((o) => sale(o, credit(c))));
      const ok = settled.filter((s) => s.status === 'fulfilled');
      const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(ok).toHaveLength(3); // 3 × 3 150 = 9 450 ≤ 10 000 < 4 × 3 150
      expect(bad).toHaveLength(3);
      for (const r of bad) {
        expect((r.reason as DomainError).code).toBe('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
      }
      expect((await accountOf(c.ccaId)).outstanding).toBe(9_450n);
      const sold = (await Promise.all(orders.map((o) => invoiceOf(o.orderId)))).filter(
        (i) => i !== null,
      );
      expect(sold).toHaveLength(3);
      expect(new Set(sold.map((i) => i!.number)).size).toBe(3);
    }, 120_000);

    // ── the override ────────────────────────────────────────────────────────────
    const overLimit = async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 5_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n)); // 10 500 > 5 000
      return { c, o };
    };

    it('a VALID override (Owner permission + step-up + a reason): the sale proceeds, mode OVERRIDE, audited with the bounded reason and the actor', async () => {
      const { c, o } = await overLimit();
      const before = await auditActions();
      const res = await sale(
        o,
        credit(c, { reason: '  VIP customer — approved by the owner  ', ctx: ownerCtx() }),
      );
      expect(res.creditAuthorizationMode).toBe('OVERRIDE');
      expect(res.authorities.creditOverride).toBe(true);
      expect(res.authorities.permissionKeys).toContain('customers:credit:override');
      const audit = await q<{ reason: string | null; actor: string | null }>(
        `SELECT reason, "actorUserId" AS actor FROM audit_log
          WHERE "tenantId" = $1 AND action = 'credit_limit.override_used' AND "resourceId" = $2`,
        [tenantId, c.ccaId],
      );
      expect(audit).toEqual([{ reason: 'VIP customer — approved by the owner', actor }]);
      expect(diff(before, await auditActions())['audit:credit_limit.override_used']).toBe(1);
      expect((await receivablesOf(res.invoiceId))[0]!.creditAuthorized).toBe(true);
      // the override authorised exactly THIS sale and nothing more: it is not persisted
      const next = await mkOrder(aed, c.customerId, one(100n));
      await expectRejected(
        next,
        () => sale(next, credit(c)),
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        409,
      );
    });

    it('a customer sale with an override still books only the frozen 3b.6 journals', async () => {
      const { c, o } = await overLimit();
      const res = await sale(
        o,
        credit(c, { reason: 'approved', ctx: ownerCtx(), tenders: [cash(2_000n)] }),
      );
      expect(await saleJournals(res.invoiceId)).toEqual(
        [
          invoiceArJournal(TOTAL, TAX),
          receipt('ASSET.CASH_ON_HAND', 2_000n),
          allocation(2_000n),
        ].sort(),
      );
    });

    it.each([
      ['no override permission', () => noPermissionCtx(), 'CREDIT_OVERRIDE_DENIED', 403],
      ['no step-up', () => noStepUpCtx(), 'CREDIT_OVERRIDE_DENIED', 403],
    ] as const)(
      'over the limit with a reason but %s → %s (403), nothing written',
      async (_label, mk, code, status) => {
        const { c, o } = await overLimit();
        await expectRejected(
          o,
          () => sale(o, credit(c, { reason: 'please', ctx: mk() })),
          code,
          status,
        );
      },
    );

    it('over the limit with a reason but NO authenticated context at all → CREDIT_OVERRIDE_DENIED (fail closed)', async () => {
      const { c, o } = await overLimit();
      await expectRejected(
        o,
        () => sale(o, credit(c, { reason: 'please', ctx: null })),
        'CREDIT_OVERRIDE_DENIED',
        403,
      );
    });

    it('a BLANK reason → CREDIT_OVERRIDE_REASON_REQUIRED (422); an OVERSIZED reason → CREDIT_OVERRIDE_REASON_TOO_LONG (422)', async () => {
      const { c, o } = await overLimit();
      await expectRejected(
        o,
        () => sale(o, credit(c, { reason: '    ', ctx: ownerCtx() })),
        'CREDIT_OVERRIDE_REASON_REQUIRED',
        422,
      );
      await expectRejected(
        o,
        () => sale(o, credit(c, { reason: 'x'.repeat(256), ctx: ownerCtx() })),
        'CREDIT_OVERRIDE_REASON_TOO_LONG',
        422,
      );
      // exactly at the bound is fine
      expect(
        (await sale(o, credit(c, { reason: 'x'.repeat(255), ctx: ownerCtx() })))
          .creditAuthorizationMode,
      ).toBe('OVERRIDE');
    });

    it('NO reason supplied: the denial stands (409) even for the Owner — a context alone grants nothing', async () => {
      const { c, o } = await overLimit();
      await expectRejected(
        o,
        () => sale(o, credit(c, { ctx: ownerCtx() })),
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        409,
      );
      await expectRejected(
        o,
        () => sale(o, credit(c, { reason: null, ctx: ownerCtx() })),
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        409,
      );
    });

    it('the server decides necessity: a reason on a sale WITHIN the limit is ignored — no authorization consulted, no override audited', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const before = await auditActions();
      // a non-owner context: if authorize() were consulted it would deny
      const res = await sale(o, credit(c, { reason: 'just in case', ctx: noPermissionCtx() }));
      expect(res.creditAuthorizationMode).toBe('NORMAL');
      expect(res.authorities.creditOverride).toBe(false);
      expect(
        diff(before, await auditActions())['audit:credit_limit.override_used'],
      ).toBeUndefined();
    });

    it('a reason on a PAY_NOW sale is ignored too (no gate ran)', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 100n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await sale(o, {
        intent: 'PAY_NOW',
        tenders: [cash(TOTAL)],
        reason: 'ignored',
        ctx: noPermissionCtx(),
      });
      expect(res.creditAuthorizationMode).toBeNull();
    });

    it('FORGED override-like client input is ignored: creditOverride / overrideCreditLimit / force / a boolean grant nothing', async () => {
      const { c, o } = await overLimit();
      const forged = {
        ...saleInput(o, credit(c)),
        creditOverride: { actorUserId: actor, reason: 'forged' },
        overrideCreditLimit: true,
        force: true,
        override: true,
        allowOverLimit: true,
      } as unknown as CompleteCustomerSaleInTxInput;
      const before = await snapshot();
      const err = await asTenant((tx) => svc.completeCustomerSaleInTx(tx, forged)).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
      expect(await snapshot()).toEqual(before);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5b. OWNER RULING — "Credit limit applies to resulting receivable exposure, not gross
  //     invoice total, for atomic customer sales."
  //       existingOutstanding + finalSaleOutstanding <= creditLimit   (unless an authorized override)
  //       finalSaleOutstanding = invoiceTotal − same-sale tenders − same-sale advances
  // ═════════════════════════════════════════════════════════════════════════════
  describe('credit limit — the RESULTING receivable exposure (existing outstanding + the sale’s FINAL outstanding), never the gross invoice total', () => {
    const credit = (p: Partial<SaleParts> = {}): SaleParts => ({ intent: 'ON_CREDIT', ...p });
    const untaxed = (price: bigint): OrderSpec => one(price, null);
    const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, x) => a + x, 0n);

    interface Mix {
      name: string;
      tenders: SaleTenderInput[];
      advances: bigint[];
    }
    const mixes: Mix[] = [
      { name: 'cash 7 000 + credit (exposure 3 500)', tenders: [cash(7_000n)], advances: [] },
      { name: 'advance 4 000 + credit (exposure 6 500)', tenders: [], advances: [4_000n] },
      {
        name: 'cash 3 000 + advance 2 000 + credit (exposure 5 500)',
        tenders: [cash(3_000n)],
        advances: [2_000n],
      },
      {
        name: 'Multi (cash 1 000 + bank 1 500) + advance 2 000 + credit (exposure 6 000)',
        tenders: [cash(1_000n), bank(1_500n)],
        advances: [2_000n],
      },
    ];
    const exposureOf = (m: Mix): bigint =>
      TOTAL - sum(m.tenders.map((t) => t.amountMinor)) - sum(m.advances);

    async function setUp(m: Mix, limit: bigint | null) {
      const c = await mkCustomer(aed, { enabled: true, limit });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const advances: { id: string; amount: bigint }[] = [];
      for (const amount of m.advances) advances.push({ id: await mkAdvance(c, amount), amount });
      return { c, o, advances, accountBefore: await accountOf(c.ccaId) };
    }
    const partsOf = (
      m: Mix,
      advances: { id: string; amount: bigint }[],
      extra: Partial<SaleParts> = {},
    ): SaleParts =>
      credit({
        tenders: m.tenders,
        advances: advances.map((a) => adv(a.id, a.amount)),
        ...extra,
      });
    const cases = mixes.map((m) => [m.name, m] as const);

    it.each(cases)(
      '%s: a limit EXACTLY at the exposure passes with NO override — although the limit is below the gross invoice total',
      async (_n, m) => {
        const exposure = exposureOf(m);
        expect(exposure).toBeLessThan(TOTAL);
        const { c, o, advances, accountBefore } = await setUp(m, exposure);
        const before = await auditActions();
        const res = await sale(o, partsOf(m, advances));
        expect(res.creditAuthorizationMode).toBe('NORMAL');
        expect(res.authorities.creditOverride).toBe(false);
        expect(res.outstandingMinor).toBe(exposure);
        expect(
          diff(before, await auditActions())['audit:credit_limit.override_used'],
        ).toBeUndefined();
        await expectCustomerSale(c, o, res, {
          intent: 'ON_CREDIT',
          tenders: m.tenders,
          advances,
          status: 'PARTIAL',
          accountBefore,
        });
        // the committed exposure is exactly the limit — never above it
        expect((await accountOf(c.ccaId)).outstanding).toBe(exposure);
      },
    );

    it.each(cases)(
      '%s: ONE minor unit over the limit → CUSTOMER_CREDIT_LIMIT_EXCEEDED, reporting the EXPOSURE (not the invoice total); nothing written, nothing numbered',
      async (_n, m) => {
        const exposure = exposureOf(m);
        const { c, o, advances } = await setUp(m, exposure - 1n);
        const err = await expectRejected(
          o,
          () => sale(o, partsOf(m, advances)),
          'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
          409,
        );
        expect(err.message).toContain(`projected exposure ${exposure})`);
        expect(err.message).not.toContain(`projected exposure ${TOTAL})`);
        for (const a of advances) expect(await advanceAvailable(c, a.id)).toBe(a.amount);
      },
    );

    it.each(cases)(
      '%s: one unit over + a VALID override (Owner + step-up + reason) → OVERRIDE; the account carries the EXPOSURE, audited once',
      async (_n, m) => {
        const exposure = exposureOf(m);
        const { c, o, advances, accountBefore } = await setUp(m, exposure - 1n);
        const before = await auditActions();
        const res = await sale(
          o,
          partsOf(m, advances, { reason: 'owner approved the exception', ctx: ownerCtx() }),
        );
        expect(res.creditAuthorizationMode).toBe('OVERRIDE');
        expect(res.authorities.creditOverride).toBe(true);
        expect(diff(before, await auditActions())['audit:credit_limit.override_used']).toBe(1);
        await expectCustomerSale(c, o, res, {
          intent: 'ON_CREDIT',
          tenders: m.tenders,
          advances,
          status: 'PARTIAL',
          accountBefore,
        });
        expect((await accountOf(c.ccaId)).outstanding).toBe(exposure);
      },
    );

    it.each([
      ['no override permission', () => noPermissionCtx(), 'CREDIT_OVERRIDE_DENIED', 403, 'please'],
      ['no step-up', () => noStepUpCtx(), 'CREDIT_OVERRIDE_DENIED', 403, 'please'],
      ['a blank reason', () => ownerCtx(), 'CREDIT_OVERRIDE_REASON_REQUIRED', 422, '   '],
      [
        'an oversized reason',
        () => ownerCtx(),
        'CREDIT_OVERRIDE_REASON_TOO_LONG',
        422,
        'x'.repeat(256),
      ],
      ['NO reason at all', () => ownerCtx(), 'CUSTOMER_CREDIT_LIMIT_EXCEEDED', 409, undefined],
    ] as const)(
      'a partial-tender sale one unit over the limit with %s → %s, nothing written',
      async (_label, mk, code, status, reason) => {
        const m = mixes[0]!;
        const { o, advances } = await setUp(m, exposureOf(m) - 1n);
        await expectRejected(
          o,
          () =>
            sale(
              o,
              partsOf(m, advances, { ...(reason === undefined ? {} : { reason }), ctx: mk() }),
            ),
          code,
          status,
        );
      },
    );

    it('the OVERRIDE path with EXISTING outstanding: the account ends at existing + the sale’s exposure, not at the sale alone', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 12_000n });
      await sale(await mkOrder(aed, c.customerId, one(10_000n)), credit()); // existing 10 500
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      // exposure 10 500 − 2 000 = 8 500 → 10 500 + 8 500 = 19 000 > 12 000: the exception is needed
      const res = await sale(
        o,
        credit({ tenders: [cash(2_000n)], reason: 'owner approved', ctx: ownerCtx() }),
      );
      expect(res.creditAuthorizationMode).toBe('OVERRIDE');
      expect(res.outstandingMinor).toBe(8_500n);
      expect((await accountOf(c.ccaId)).outstanding).toBe(10_500n + 8_500n);
    });

    it('an invoice TOTAL above the headroom whose same-sale payment brings the exposure under the limit needs NO override — a reason (even from a non-owner) is ignored', async () => {
      const m = mixes[0]!; // exposure 3 500, invoice total 10 500
      const { c, o, advances } = await setUp(m, 4_000n); // 3 500 ≤ 4 000 < 10 500
      const before = await auditActions();
      const res = await sale(
        o,
        partsOf(m, advances, { reason: 'just in case', ctx: noPermissionCtx() }),
      );
      expect(res.creditAuthorizationMode).toBe('NORMAL');
      expect(res.authorities.creditOverride).toBe(false);
      expect(
        diff(before, await auditActions())['audit:credit_limit.override_used'],
      ).toBeUndefined();
      expect((await accountOf(c.ccaId)).outstanding).toBe(3_500n);
    });

    it('EXISTING outstanding + the sale’s final outstanding: exactly at the limit passes; one unit over is refused', async () => {
      const mkExisting = async () => {
        const c = await mkCustomer(aed, { enabled: true, limit: 16_000n });
        await sale(await mkOrder(aed, c.customerId, one(10_000n)), credit()); // existing 10 500
        return c;
      };
      const at = await mkExisting();
      const o1 = await mkOrder(aed, at.customerId, one(10_000n));
      // exposure 10 500 − 5 000 = 5 500 → 10 500 + 5 500 = 16 000 = the limit
      expect((await sale(o1, credit({ tenders: [cash(5_000n)] }))).creditAuthorizationMode).toBe(
        'NORMAL',
      );
      expect((await accountOf(at.ccaId)).outstanding).toBe(16_000n);

      const over = await mkExisting();
      const o2 = await mkOrder(aed, over.customerId, one(10_000n));
      const err = await expectRejected(
        o2,
        () => sale(o2, credit({ tenders: [cash(4_999n)] })),
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        409,
      );
      expect(err.message).toContain('projected exposure 16001)');
    });

    it('PAY_NOW consumes NO credit: a customer already AT the limit still completes a PAY_NOW sale and the exposure is unchanged', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: TOTAL });
      await sale(await mkOrder(aed, c.customerId, one(10_000n)), credit()); // exposure = limit
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await sale(o, { tenders: [cash(TOTAL)] });
      expect(res.creditAuthorizationMode).toBeNull();
      expect(res.outstandingMinor).toBe(0n);
      expect((await accountOf(c.ccaId)).outstanding).toBe(TOTAL);
    });

    it('credit DISABLED stays an unconditional block even when a tender covers almost the whole invoice', async () => {
      const c = await mkCustomer(aed, { enabled: false });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejected(
        o,
        () => sale(o, credit({ tenders: [cash(10_000n)], reason: 'owner', ctx: ownerCtx() })),
        'CUSTOMER_CREDIT_DISABLED',
        422,
      );
    });

    // ── concurrency on the exposure basis ───────────────────────────────────────
    describe('concurrency on the exposure basis (real PostgreSQL; the customer account lock is the serialization point)', () => {
      const ROUNDS = 3;
      const noDeadlock = (rejections: PromiseRejectedResult[]): void => {
        for (const r of rejections) {
          expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/40P01|deadlock/i);
          expect(r.reason).toBeInstanceOf(DomainError); // a clean domain error, never a raw 500
        }
      };

      /** two concurrent UNTAXED 800 sales of ONE customer (limit 1 000), each covering `tender` + `advance` */
      async function raceTwo(spec: { tender: bigint; advance: bigint }) {
        const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
        const orders = [
          await mkOrder(aed, c.customerId, untaxed(800n)),
          await mkOrder(aed, c.customerId, untaxed(800n)),
        ];
        const advIds: string[] = [];
        if (spec.advance > 0n) {
          for (let i = 0; i < 2; i += 1) advIds.push(await mkAdvance(c, spec.advance));
        }
        const settled = await Promise.allSettled(
          orders.map((o, i) =>
            sale(
              o,
              credit({
                tenders: spec.tender > 0n ? [cash(spec.tender)] : [],
                advances: spec.advance > 0n ? [adv(advIds[i]!, spec.advance)] : [],
              }),
            ),
          ),
        );
        return { c, orders, advIds, settled };
      }

      const specs = {
        // invoice 800: each sale leaves 500 of credit → 500 + 500 = 1 000 = the limit
        fits: [
          ['tender 300', { tender: 300n, advance: 0n }],
          ['advance 300', { tender: 0n, advance: 300n }],
          ['tender 150 + advance 150', { tender: 150n, advance: 150n }],
        ] as const,
        // invoice 800: each sale leaves 600 → 600 + 600 > 1 000: only one can win
        over: [
          ['tender 200', { tender: 200n, advance: 0n }],
          ['advance 200', { tender: 0n, advance: 200n }],
          ['tender 100 + advance 100', { tender: 100n, advance: 100n }],
        ] as const,
      };

      it.each(specs.fits)(
        'two sales of an untaxed 800 invoice, each with %s (exposure 500 each, 500 + 500 = the 1 000 limit): BOTH succeed, committed exposure 1 000',
        async (_n, spec) => {
          for (let round = 0; round < ROUNDS; round += 1) {
            const { c, settled } = await raceTwo(spec);
            expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
            for (const s of settled) {
              const r = (s as PromiseFulfilledResult<CompleteCustomerSaleResult>).value;
              expect(r.creditAuthorizationMode).toBe('NORMAL');
              expect(r.outstandingMinor).toBe(500n);
            }
            expect((await accountOf(c.ccaId)).outstanding).toBe(1_000n);
            const summary = await asTenant((tx) =>
              read.getSummary(tx, {
                tenantId,
                companyId: aed.companyId,
                branchId: aed.branchId,
                customerId: c.customerId,
              }),
            );
            expect(summary.credit.creditExposureMinor).toBe(1_000n);
            expect(summary.credit.projectionIntegrity).toEqual({
              receivableProjectionMatches: true,
              advanceProjectionMatches: true,
            });
          }
        },
        120_000,
      );

      it.each(specs.over)(
        'two sales of an untaxed 800 invoice, each with %s (exposure 600 each): exactly ONE wins, the loser is a clean 409 with no residue, the committed exposure never exceeds 1 000',
        async (_n, spec) => {
          for (let round = 0; round < ROUNDS; round += 1) {
            const { c, orders, advIds, settled } = await raceTwo(spec);
            const ok = settled.filter((s) => s.status === 'fulfilled');
            const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
            expect(ok).toHaveLength(1);
            expect(bad).toHaveLength(1);
            noDeadlock(bad);
            expect((bad[0]!.reason as DomainError).code).toBe('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
            expect((bad[0]!.reason as DomainError).status).toBe(409);
            expect((await accountOf(c.ccaId)).outstanding).toBe(600n);
            expect((await accountOf(c.ccaId)).outstanding <= 1_000n).toBe(true);
            const invoices = await Promise.all(orders.map((o) => invoiceOf(o.orderId)));
            expect(invoices.filter((i) => i === null)).toHaveLength(1);
            if (spec.advance > 0n) {
              // the loser's advance is untouched, the winner's is spent: nothing leaked
              const left = await Promise.all(advIds.map((id) => advanceAvailable(c, id)));
              expect(left.sort()).toEqual([0n, spec.advance].sort());
            }
          }
        },
        120_000,
      );

      it('six sales whose invoice (10 500) EACH exceeds the 10 000 limit on its own, each paying 7 500 (exposure 3 000): exactly three win; the limit is never exceeded', async () => {
        const c = await mkCustomer(aed, { enabled: true, limit: 10_000n });
        const orders = await Promise.all(
          Array.from({ length: 6 }, () => mkOrder(aed, c.customerId, one(10_000n))),
        );
        const settled = await Promise.allSettled(
          orders.map((o) => sale(o, credit({ tenders: [cash(7_500n)] }))),
        );
        const ok = settled.filter((s) => s.status === 'fulfilled');
        const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        expect(ok).toHaveLength(3); // 3 × 3 000 = 9 000 ≤ 10 000 < 4 × 3 000
        expect(bad).toHaveLength(3);
        noDeadlock(bad);
        for (const r of bad) {
          expect((r.reason as DomainError).code).toBe('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
        }
        expect((await accountOf(c.ccaId)).outstanding).toBe(9_000n);
        const sold = (await Promise.all(orders.map((o) => invoiceOf(o.orderId)))).filter(
          (i) => i !== null,
        );
        expect(new Set(sold.map((i) => i!.number)).size).toBe(3);
      }, 120_000);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5c. the ONE change to the frozen issuance primitive: an optional, trusted finalSaleOutstandingMinor
  // ═════════════════════════════════════════════════════════════════════════════
  describe('InvoiceIssuanceRepository — the optional trusted finalSaleOutstandingMinor (omitted ⇒ the frozen invoice-total basis, unchanged)', () => {
    async function issueDirect(
      o: MadeOrder,
      extra: { finalSaleOutstandingMinor?: bigint } = {},
    ): Promise<{ creditAuthorizationMode: 'NORMAL' | 'OVERRIDE' | null }> {
      const fingerprint = (
        await q<{ f: string }>(
          `SELECT "commercialSnapshotFingerprint" AS f FROM "order" WHERE id = $1`,
          [o.orderId],
        )
      )[0]!.f;
      return asTenant((tx) =>
        finalization.finalizeAndIssueInvoice(tx, {
          tenantId,
          companyId: o.co.companyId,
          branchId: o.branchId,
          orderId: o.orderId,
          expectedVersion: o.version,
          commercialSnapshotFingerprint: fingerprint,
          paymentIntent: 'ON_CREDIT',
          actorUserId: actor,
          ...extra,
        }),
      );
    }

    it('OMITTED: a non-3b.9 caller is gated on the full invoice total exactly as before (one unit under the total → refused, at the total → allowed)', async () => {
      const under = await mkCustomer(aed, { enabled: true, limit: TOTAL - 1n });
      const o = await mkOrder(aed, under.customerId, one(10_000n));
      const err = await expectRejected(
        o,
        () => issueDirect(o),
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        409,
      );
      expect(err.message).toContain(`projected exposure ${TOTAL})`);

      const exact = await mkCustomer(aed, { enabled: true, limit: TOTAL });
      const o2 = await mkOrder(aed, exact.customerId, one(10_000n));
      expect((await issueDirect(o2)).creditAuthorizationMode).toBe('NORMAL');
      expect((await accountOf(exact.ccaId)).outstanding).toBe(TOTAL);
    });

    it('PROVIDED: only the GATE basis changes — the receivable is still booked for the FULL invoice total (the orchestrator then reduces it and verifies the result)', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 3_500n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      expect(
        (await issueDirect(o, { finalSaleOutstandingMinor: 3_500n })).creditAuthorizationMode,
      ).toBe('NORMAL');
      const inv = (await invoiceOf(o.orderId))!;
      expect(inv.total).toBe(TOTAL);
      expect((await accountOf(c.ccaId)).outstanding).toBe(TOTAL);
      expect(await saleJournals(inv.id)).toEqual([invoiceArJournal(TOTAL, TAX)]);
    });

    it.each([
      ['negative', -1n],
      ['above the invoice total', TOTAL + 1n],
      ['not an exact BigInt (a plain number)', 3_500 as unknown as bigint],
    ] as const)(
      'an exposure that is %s → ORDER_CREDIT_EXPOSURE_INVALID (422): nothing written, no number burned',
      async (_label, bad) => {
        const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        await expectRejected(
          o,
          () => issueDirect(o, { finalSaleOutstandingMinor: bad }),
          'ORDER_CREDIT_EXPOSURE_INVALID',
          422,
        );
      },
    );
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 6. atomicity: fault injection at every step, then a clean retry
  // ═════════════════════════════════════════════════════════════════════════════
  describe('credit + advance + payment atomicity (fault injection, real PostgreSQL)', () => {
    class FaultyFinalization extends TaxFinalizationService {
      failAt: 'issue-end' | null = null;
      override async issuePrepared(
        ...args: Parameters<TaxFinalizationService['issuePrepared']>
      ): ReturnType<TaxFinalizationService['issuePrepared']> {
        const r = await super.issuePrepared(...args);
        if (this.failAt === 'issue-end') throw new InjectedFault('after-invoice-and-receivable');
        return r;
      }
    }
    class FaultyCollection extends PaymentCollectionRepository {
      failAfter = false;
      override async captureSynchronousTendersInTx(
        ...args: Parameters<PaymentCollectionRepository['captureSynchronousTendersInTx']>
      ): ReturnType<PaymentCollectionRepository['captureSynchronousTendersInTx']> {
        const r = await super.captureSynchronousTendersInTx(...args);
        if (this.failAfter) throw new InjectedFault('after-payment-allocation');
        return r;
      }
    }
    class FaultyAdvance extends CustomerAdvanceApplicationRepository {
      failAfterCalls = 0;
      private calls = 0;
      reset(): void {
        this.failAfterCalls = 0;
        this.calls = 0;
      }
      override async applyInTx(
        ...args: Parameters<CustomerAdvanceApplicationRepository['applyInTx']>
      ): ReturnType<CustomerAdvanceApplicationRepository['applyInTx']> {
        const r = await super.applyInTx(...args);
        this.calls += 1;
        if (this.failAfterCalls > 0 && this.calls === this.failAfterCalls) {
          throw new InjectedFault(`after-advance-${this.calls}`);
        }
        return r;
      }
    }
    class FaultyInvoiceAr extends CustomerInvoiceArRepository {
      failAfterGate = false;
      override async lockAndAuthorizeCredit(
        ...args: Parameters<CustomerInvoiceArRepository['lockAndAuthorizeCredit']>
      ): ReturnType<CustomerInvoiceArRepository['lockAndAuthorizeCredit']> {
        const r = await super.lockAndAuthorizeCredit(...args);
        if (this.failAfterGate) throw new InjectedFault('after-credit-authorization');
        return r;
      }
    }

    let fin: FaultyFinalization;
    let coll: FaultyCollection;
    let advRepo: FaultyAdvance;
    let ar: FaultyInvoiceAr;
    let faultySvc: AtomicWalkInSaleService;
    beforeAll(() => {
      fin = new FaultyFinalization(issuance);
      coll = new FaultyCollection(
        audit,
        outbox,
        new PaymentCustomerAttributionRepository(),
        effects,
      );
      advRepo = new FaultyAdvance(engine, audit, effects, outbox);
      ar = new FaultyInvoiceAr(engine, audit);
      faultySvc = new AtomicWalkInSaleService(
        db,
        fin,
        coll,
        walkInJournal,
        ar,
        advRepo,
        creditOverride,
      );
    });
    const reset = (): void => {
      fin.failAt = null;
      coll.failAfter = false;
      advRepo.reset();
      ar.failAfterGate = false;
    };

    /** a RICH sale: ON_CREDIT, two tenders, two advances — every step exists */
    async function rich() {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const a1 = await mkAdvance(c, 1_000n);
      const a2 = await mkAdvance(c, 1_500n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const parts: SaleParts = {
        intent: 'ON_CREDIT',
        tenders: [cash(2_000n), card(1_000n)],
        advances: [adv(a1, 1_000n), adv(a2, 1_500n)],
      };
      return { c, o, parts, advances: [a1, a2] };
    }

    async function faultThenRetry(
      go: (ctx: { c: Cust; o: MadeOrder; parts: SaleParts }) => Promise<unknown>,
      expected: RegExp,
    ): Promise<void> {
      const r = await rich();
      const before = await snapshot();
      const accountBefore = await accountOf(r.c.ccaId);
      const nums = await nextNumbers(aed);
      const err = await go(r).then(
        () => {
          throw new Error('the fault was not raised');
        },
        (e: unknown) => e,
      );
      expect(String((err as Error).message), String(err)).toMatch(expected);
      // ZERO surviving effect — order, invoice, receivable, payments, applications, projections, journals, audit, outbox, numbers
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(r.o.orderId)).toBeNull();
      expect(
        (
          await q<{ status: string; version: number; n: string | null }>(
            `SELECT status, version, "orderNumber" AS n FROM "order" WHERE id = $1`,
            [r.o.orderId],
          )
        )[0],
      ).toEqual({ status: 'DRAFT', version: 1, n: null });
      for (const id of r.advances) expect(await advanceAvailable(r.c, id)).toBeGreaterThan(0n);
      // the retry succeeds cleanly with the NEXT gapless numbers
      reset();
      const res = await sale(r.o, r.parts);
      expect(res.invoiceNumber).toBe(nums.invoice);
      expect(res.orderNumber).toBe(nums.order);
      await expectCustomerSale(r.c, r.o, res, {
        intent: 'ON_CREDIT',
        tenders: [cash(2_000n), card(1_000n)],
        advances: [
          { id: r.advances[0]!, amount: 1_000n },
          { id: r.advances[1]!, amount: 1_500n },
        ],
        status: 'PARTIAL',
        accountBefore,
      });
    }

    const fsale = (r: { o: MadeOrder; parts: SaleParts }) => sale(r.o, r.parts, {}, faultySvc);
    const faultOn =
      (hit: (e: TxEvent) => boolean, label: string) => (r: { o: MadeOrder; parts: SaleParts }) =>
        asTenant((tx) =>
          svc.completeCustomerSaleInTx(
            observe(tx, (e) => {
              if (hit(e)) throw new InjectedFault(label);
            }),
            saleInput(r.o, r.parts),
          ),
        );
    const journalOf = (kind: string) => (e: TxEvent) =>
      e.kind === 'sql' && /INSERT INTO "journal_entry"/.test(e.text) && e.values.includes(kind);

    it('A. after invoice + receivable creation', async () => {
      await faultThenRetry((r) => {
        fin.failAt = 'issue-end';
        return fsale(r);
      }, /INJECTED_FAULT:after-invoice-and-receivable/);
    });
    it('B. after the FIRST tender (the second payment attempt faults)', async () => {
      await faultThenRetry((r) => {
        let n = 0;
        return faultOn(
          (e) => e.kind === 'sql' && /INSERT INTO "payment_attempt"/.test(e.text) && ++n === 2,
          'second-tender',
        )(r);
      }, /INJECTED_FAULT:second-tender/);
    });
    it('C. after payment allocation (the whole capture done)', async () => {
      await faultThenRetry((r) => {
        coll.failAfter = true;
        return fsale(r);
      }, /INJECTED_FAULT:after-payment-allocation/);
    });
    it('D. after the FIRST advance application', async () => {
      await faultThenRetry((r) => {
        advRepo.failAfterCalls = 1;
        return fsale(r);
      }, /INJECTED_FAULT:after-advance-1/);
    });
    it('E. after ALL advance applications', async () => {
      await faultThenRetry((r) => {
        advRepo.failAfterCalls = 2;
        return fsale(r);
      }, /INJECTED_FAULT:after-advance-2/);
    });
    it('F. after credit authorization (the pre-flight gate)', async () => {
      await faultThenRetry((r) => {
        ar.failAfterGate = true;
        return fsale(r);
      }, /INJECTED_FAULT:after-credit-authorization/);
    });
    it('G. during the invoice AR journal', async () => {
      await faultThenRetry(
        faultOn(journalOf('invoice_ar'), 'invoice-ar-journal'),
        /INJECTED_FAULT:invoice-ar-journal/,
      );
    });
    it('H1. during a payment (receipt) journal', async () => {
      await faultThenRetry(
        faultOn(journalOf('customer_receipt_payment'), 'receipt-journal'),
        /INJECTED_FAULT:receipt-journal/,
      );
    });
    it('H2. during a payment-allocation journal', async () => {
      await faultThenRetry(
        faultOn(journalOf('payment_allocation'), 'allocation-journal'),
        /INJECTED_FAULT:allocation-journal/,
      );
    });
    it('I. during an advance-application journal', async () => {
      await faultThenRetry(
        faultOn(journalOf('customer_advance_application'), 'advance-journal'),
        /INJECTED_FAULT:advance-journal/,
      );
    });
    it('J. immediately before the OUTER commit (caller failure after the whole sale returned)', async () => {
      await faultThenRetry(
        (r) =>
          asTenant(async (tx) => {
            await svc.completeCustomerSaleInTx(tx, saleInput(r.o, r.parts));
            const receivables = await tx.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM customer_receivable cr
                JOIN invoice i ON i.id = cr."invoiceId" WHERE i."orderId" = ${r.o.orderId}::uuid`;
            expect(receivables[0]!.n).toBe(1); // the receivable exists INSIDE the caller's own transaction
            throw new InjectedFault('before-outer-commit');
          }),
        /INJECTED_FAULT:before-outer-commit/,
      );
    });

    const auditFaults: [string, (e: TxEvent) => boolean][] = [
      ['audit order.confirmed', (e) => act(e) === 'order.confirmed'],
      ['audit invoice.issued', (e) => act(e) === 'invoice.issued'],
      ['audit receivable.created', (e) => act(e) === 'receivable.created'],
      ['audit receivable.advance_applied', (e) => act(e) === 'receivable.advance_applied'],
      ['audit payment.recorded', (e) => act(e) === 'payment.recorded'],
      ['audit accounting.journal_posted', (e) => act(e) === 'accounting.journal_posted'],
      ['outbox payments.payment_recorded', (e) => ob(e) === 'payments.payment_recorded'],
      [
        'outbox receivables.customer_account_changed',
        (e) => ob(e) === 'receivables.customer_account_changed',
      ],
    ];
    const act = (e: TxEvent): string | undefined =>
      e.kind === 'model' && e.name === 'auditLog.create'
        ? (e.args[0] as { data?: { action?: string } } | undefined)?.data?.action
        : undefined;
    const ob = (e: TxEvent): string | undefined =>
      e.kind === 'model' && e.name === 'outbox.create'
        ? (e.args[0] as { data?: { eventType?: string } } | undefined)?.data?.eventType
        : undefined;
    it.each(auditFaults)(
      'a failing %s (written by a reused primitive) rolls the whole sale back',
      async (label, hit) => {
        await faultThenRetry(
          faultOn(hit, label),
          new RegExp(`INJECTED_FAULT:${label.replace(/[.]/g, '\\.')}`),
        );
      },
    );

    it('a failing credit-override audit rolls the OVERRIDE sale back too', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 5_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const parts: SaleParts = { intent: 'ON_CREDIT', reason: 'approved', ctx: ownerCtx() };
      const before = await snapshot();
      await expect(
        asTenant((tx) =>
          svc.completeCustomerSaleInTx(
            observe(tx, (e) => {
              if (act(e) === 'credit_limit.override_used')
                throw new InjectedFault('override-audit');
            }),
            saleInput(o, parts),
          ),
        ),
      ).rejects.toThrow(/INJECTED_FAULT:override-audit/);
      expect(await snapshot()).toEqual(before);
      expect((await sale(o, parts)).creditAuthorizationMode).toBe('OVERRIDE');
    });

    it('the accounting period CLOSED fails at the invoice AR journal — before any payment or advance — and rolls back', async () => {
      const c = await mkCustomer(closed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(closed, c.customerId, one(10_000n));
      const before = await snapshot();
      const err = await sale(o, { intent: 'ON_CREDIT', tenders: [cash(1_000n)] }).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('ACCOUNTING_PERIOD_CLOSED');
      expect(await snapshot()).toEqual(before);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 6b. the orchestrator's own invariants over what its collaborators return
  // ═════════════════════════════════════════════════════════════════════════════
  describe("orchestrator invariants (a frozen collaborator's OUTPUT is doctored; the whole sale must roll back)", () => {
    const svcWith = (over: {
      finalization?: TaxFinalizationService;
      collection?: PaymentCollectionRepository;
      invoiceAr?: CustomerInvoiceArRepository;
    }): AtomicWalkInSaleService =>
      new AtomicWalkInSaleService(
        db,
        over.finalization ?? finalization,
        over.collection ?? collection,
        walkInJournal,
        over.invoiceAr ?? invoiceAr,
        advanceApplication,
        creditOverride,
      );

    async function expectInvariant(
      service: AtomicWalkInSaleService,
      parts: SaleParts,
      exactCode?: string,
    ): Promise<void> {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const before = await snapshot();
      const err = await sale(o, parts, {}, service).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, String(err)).toBeInstanceOf(DomainError);
      expect((err as DomainError).status).toBe(500);
      if (exactCode !== undefined) {
        expect((err as DomainError).code).toBe(exactCode);
      } else {
        expect((err as DomainError).code).toMatch(
          /^SALE_(CUSTOMER|PAYMENT_COVERAGE)_INVARIANT_VIOLATED$/,
        );
      }
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
    }

    type Capture = PaymentCollectionRepository['captureSynchronousTendersInTx'];
    const doctored = (
      tweak: (
        tx: ScopedTx,
        input: Parameters<Capture>[1],
        real: () => ReturnType<Capture>,
      ) => ReturnType<Capture>,
    ): PaymentCollectionRepository => {
      class Doctored extends PaymentCollectionRepository {
        override async captureSynchronousTendersInTx(
          ...args: Parameters<Capture>
        ): ReturnType<Capture> {
          return tweak(args[0], args[1], () => super.captureSynchronousTendersInTx(...args));
        }
      }
      return new Doctored(audit, outbox, new PaymentCustomerAttributionRepository(), effects);
    };
    const setStatus = (tx: ScopedTx, invoiceId: string, status: string) =>
      tx.$executeRaw`UPDATE "invoice" SET "invoicePaymentStatus" = ${status} WHERE "id" = ${invoiceId}::uuid`;

    it('issuance that returns NO receivable for a customer sale → SALE_CUSTOMER_INVARIANT_VIOLATED', async () => {
      class NoReceivable extends TaxFinalizationService {
        override async issuePrepared(
          ...args: Parameters<TaxFinalizationService['issuePrepared']>
        ): ReturnType<TaxFinalizationService['issuePrepared']> {
          const r = await super.issuePrepared(...args);
          return { ...r, customerReceivableId: null };
        }
      }
      await expectInvariant(svcWith({ finalization: new NoReceivable(issuance) }), {
        tenders: [cash(TOTAL)],
      });
    });

    it('a capture that reports something still to collect → SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED (the remaining clause)', async () => {
      const c = doctored(async (_tx, _input, real) => {
        const r = await real();
        return { ...r, remainingAvailableToCollectMinor: r.remainingAvailableToCollectMinor + 1n };
      });
      await expectInvariant(svcWith({ collection: c }), { tenders: [cash(TOTAL)] });
    });

    it('a PAY_NOW sale whose derived status is not PAID / SETTLED → SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED (the PAY_NOW status arm)', async () => {
      const c = doctored(async (tx, _input, real) => {
        const r = await real();
        await setStatus(tx, r.invoiceId, 'PARTIAL');
        return r;
      });
      await expectInvariant(svcWith({ collection: c }), { tenders: [cash(TOTAL)] });
    });

    it('an ON_CREDIT sale whose derived status is not UNPAID / PARTIAL → SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED (the ON_CREDIT status arm)', async () => {
      const c = doctored(async (tx, _input, real) => {
        const r = await real();
        await setStatus(tx, r.invoiceId, 'PAID');
        return r;
      });
      await expectInvariant(svcWith({ collection: c }), {
        intent: 'ON_CREDIT',
        tenders: [cash(2_000n)],
      });
    });

    it('PROJECTION DRIFT: an account projection that does not end at (existing outstanding + the sale’s final outstanding) rolls the whole sale back (SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED)', async () => {
      // the invoice-level balance checks all pass — ONLY the account-level exposure postcondition can see this
      const c = doctored(async (tx, _input, real) => {
        const r = await real();
        await tx.$executeRaw`
          UPDATE "customer_company_account"
             SET "currentOutstandingMinor" = "currentOutstandingMinor" + 1
           WHERE "id" IN (SELECT "customerCompanyAccountId" FROM "customer_receivable"
                           WHERE "invoiceId" = ${r.invoiceId}::uuid)`;
        return r;
      });
      await expectInvariant(
        svcWith({ collection: c }),
        { intent: 'ON_CREDIT', tenders: [cash(2_000n)] },
        'SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED',
      );
    });

    it('STALE existing outstanding: a pre-flight that reports an outstanding different from the locked row is caught by the final exposure postcondition', async () => {
      class StaleAccount extends CustomerInvoiceArRepository {
        override async lockAndAuthorizeCredit(
          ...args: Parameters<CustomerInvoiceArRepository['lockAndAuthorizeCredit']>
        ): ReturnType<CustomerInvoiceArRepository['lockAndAuthorizeCredit']> {
          const r = await super.lockAndAuthorizeCredit(...args);
          return {
            ...r,
            account: {
              ...r.account,
              currentOutstandingMinor: r.account.currentOutstandingMinor + 1n,
            },
          };
        }
      }
      await expectInvariant(
        svcWith({ invoiceAr: new StaleAccount(engine, audit) }),
        { intent: 'ON_CREDIT', tenders: [cash(2_000n)] },
        'SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED',
      );
    });

    it.each([
      [
        'a remainder that does not complete the sale',
        (p: SalePlan) => ({ ...p, outstandingMinor: p.outstandingMinor + 1n }),
      ],
      [
        'a tender total that does not add up',
        (p: SalePlan) => ({ ...p, tenderTotalMinor: p.tenderTotalMinor + 1n }),
      ],
      [
        'an advance total that does not add up',
        (p: SalePlan) => ({ ...p, advanceTotalMinor: p.advanceTotalMinor + 1n }),
      ],
      ['a plan for a different currency', (p: SalePlan) => ({ ...p, currencyCode: 'KWD' })],
      [
        'a plan for a different exponent',
        (p: SalePlan) => ({ ...p, currencyExponent: p.currencyExponent + 1 }),
      ],
      [
        'a plan for a different invoice total',
        (p: SalePlan) => ({ ...p, totalAmountMinor: p.totalAmountMinor + 1n }),
      ],
      [
        'a NEGATIVE remainder that still sums to the total',
        (p: SalePlan) => ({
          ...p,
          // tenders over-cover by one, the remainder is −1: tenders + advances + remainder still = total
          tenderTotalMinor: p.totalAmountMinor + 1n - p.advanceTotalMinor,
          outstandingMinor: -1n,
        }),
      ],
    ] as const)(
      'the exposure is re-proven against the canonical total BEFORE any credit decision: %s → SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED',
      async (_label, doctor) => {
        const service = svcWith({});
        const target = service as unknown as {
          planPayment: (...a: unknown[]) => SalePlan;
        };
        const real = target.planPayment;
        target.planPayment = function (this: unknown, ...a: unknown[]): SalePlan {
          return doctor(real.apply(this, a));
        };
        await expectInvariant(
          service,
          { intent: 'ON_CREDIT', tenders: [cash(2_000n)] },
          'SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED',
        );
      },
    );

    it('a capture that UNDER-allocates yet reports full coverage and a PAID status → SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED (the independent outstanding-balance check)', async () => {
      const c = doctored(async (tx, input, real) => {
        void real;
        const first = input.tenders[0]!;
        const inner = doctored(async (_t, _i, again) => again());
        const r = await inner.captureSynchronousTendersInTx(tx, {
          ...input,
          amountMinor: first.amountMinor,
          tenders: [first],
        });
        await setStatus(tx, r.invoiceId, 'PAID');
        return { ...r, remainingAvailableToCollectMinor: 0n };
      });
      await expectInvariant(svcWith({ collection: c }), { tenders: [cash(5_000n), bank(5_500n)] });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 7. numbering
  // ═════════════════════════════════════════════════════════════════════════════
  describe('numbering', () => {
    it('invalid requests, refused advances / credit and a late rollback burn NO number; the next sales receive the next gapless numbers', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const c = await mkCustomer(co, { enabled: true, limit: 8_000n });
      const start = await nextNumbers(co);
      expect(start).toEqual({ order: 'ORD-000001', invoice: 'INV-000001' });

      const o = await mkOrder(co, c.customerId, one(10_000n));
      await sale(o, { tenders: [cash(1n)] }).catch(() => undefined); // underpayment
      await sale(o, { advances: [adv(randomUUID(), 100n)], tenders: [cash(10_400n)] }).catch(
        () => undefined,
      ); // unknown advance
      await sale(o, { intent: 'ON_CREDIT' }).catch(() => undefined); // credit limit exceeded (10 500 > 8 000)
      await asTenant(async (tx) => {
        await svc.completeCustomerSaleInTx(tx, saleInput(o, { tenders: [cash(TOTAL)] }));
        throw new InjectedFault('late-rollback');
      }).catch(() => undefined);
      expect(await nextNumbers(co)).toEqual(start);

      const r1 = await sale(o, { tenders: [cash(TOTAL)] });
      const second = await mkOrder(co, c.customerId, one(5_000n));
      const r2 = await sale(second, { intent: 'ON_CREDIT' });
      expect([r1.invoiceNumber, r2.invoiceNumber]).toEqual(['INV-000001', 'INV-000002']);
      expect([r1.orderNumber, r2.orderNumber]).toEqual(['ORD-000001', 'ORD-000002']);
    });

    it('concurrent customer sales of ONE company get distinct, contiguous numbers', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const jobs = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const c = await mkCustomer(co, { enabled: true, limit: null });
          return { c, o: await mkOrder(co, c.customerId, one(10_000n)), credit: i % 2 === 0 };
        }),
      );
      const settled = await Promise.allSettled(
        jobs.map((j) =>
          sale(
            j.o,
            j.credit
              ? { intent: 'ON_CREDIT', tenders: [cash(2_000n)] }
              : { tenders: [cash(TOTAL)] },
          ),
        ),
      );
      expect(
        settled
          .filter((s) => s.status === 'rejected')
          .map((s) => String((s as PromiseRejectedResult).reason)),
      ).toEqual([]);
      const numbers = settled.map(
        (s) => (s as PromiseFulfilledResult<CompleteCustomerSaleResult>).value.invoiceNumber,
      );
      expect(new Set(numbers).size).toBe(10);
      expect(numbers.sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `INV-${String(i + 1).padStart(6, '0')}`),
      );
    }, 120_000);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 8. concurrency — advances, duplicate completion, standalone 3b.6 operations
  // ═════════════════════════════════════════════════════════════════════════════
  describe('concurrency (real PostgreSQL)', () => {
    const noDeadlock = (rejections: PromiseRejectedResult[]): void => {
      for (const r of rejections) {
        expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/40P01|deadlock/i);
        expect(r.reason).toBeInstanceOf(DomainError); // a clean domain error, never a raw 500
      }
    };

    it('ADVANCE DOUBLE-SPEND — two sales both want 4 000 of one 5 000 advance: exactly one wins, the loser is a clean 409 with no residue, nothing goes negative', async () => {
      for (let round = 0; round < 3; round += 1) {
        const c = await mkCustomer(aed);
        const advanceId = await mkAdvance(c, 5_000n);
        const a = await mkOrder(aed, c.customerId, one(10_000n));
        const b = await mkOrder(aed, c.customerId, one(10_000n));
        const parts: SaleParts = { tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] };
        const settled = await Promise.allSettled([sale(a, parts), sale(b, parts)]);
        const ok = settled.filter((s) => s.status === 'fulfilled');
        const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(1);
        noDeadlock(bad);
        expect((bad[0]!.reason as DomainError).code).toBe('CUSTOMER_ADVANCE_APPLICATION_INVALID');
        expect((bad[0]!.reason as DomainError).status).toBe(409);
        expect(await advanceAvailable(c, advanceId)).toBe(1_000n);
        expect((await accountOf(c.ccaId)).advance).toBe(1_000n);
        // exactly one of the two orders sold; the loser left NO invoice / payment / application behind
        const invA = await invoiceOf(a.orderId);
        const invB = await invoiceOf(b.orderId);
        expect([invA, invB].filter((i) => i !== null)).toHaveLength(1);
        const loser = invA === null ? a : b;
        expect(
          (
            await q<{ n: number }>(
              `SELECT count(*)::int AS n FROM "order" WHERE id = $1 AND status = 'DRAFT'`,
              [loser.orderId],
            )
          )[0]!.n,
        ).toBe(1);
      }
    }, 120_000);

    it('six sales each spending 1 000 of one 5 000 advance: exactly five win, the available balance ends at 0 (never negative)', async () => {
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, 5_000n);
      const orders = await Promise.all(
        Array.from({ length: 6 }, () => mkOrder(aed, c.customerId, one(10_000n))),
      );
      const settled = await Promise.allSettled(
        orders.map((o) => sale(o, { tenders: [cash(9_500n)], advances: [adv(advanceId, 1_000n)] })),
      );
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(5);
      const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(bad).toHaveLength(1);
      noDeadlock(bad);
      expect(await advanceAvailable(c, advanceId)).toBe(0n);
      expect((await accountOf(c.ccaId)).advance).toBe(0n);
    }, 120_000);

    it('a SALE racing a STANDALONE advance application over the same advance: one wins, no negative balance, no deadlock', async () => {
      for (let round = 0; round < 3; round += 1) {
        const c = await mkCustomer(aed, { enabled: true, limit: null });
        // an existing open receivable (an earlier credit sale) for the standalone application
        const earlier = await sale(await mkOrder(aed, c.customerId, one(10_000n)), {
          intent: 'ON_CREDIT',
        });
        const advanceId = await mkAdvance(c, 5_000n);
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        const settled = await Promise.allSettled([
          sale(o, { tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] }),
          asTenant((tx) =>
            advanceApplication.applyInTx(tx, {
              tenantId,
              companyId: aed.companyId,
              branchId: aed.branchId,
              customerId: c.customerId,
              advanceId,
              customerReceivableId: earlier.customerReceivableId,
              amountMinor: 4_000n,
              actorUserId: actor,
            }),
          ),
        ]);
        expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
        const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        noDeadlock(bad);
        expect(await advanceAvailable(c, advanceId)).toBe(1_000n);
        expect((await accountOf(c.ccaId)).advance).toBe(1_000n);
      }
    }, 120_000);

    it('a SALE racing a STANDALONE direct payment on another invoice of the SAME customer: both complete, no deadlock (account-before-invoice never inverts)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const c = await mkCustomer(aed, { enabled: true, limit: null });
        const earlier = await sale(await mkOrder(aed, c.customerId, one(10_000n)), {
          intent: 'ON_CREDIT',
        });
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        const settled = await Promise.allSettled([
          sale(o, { tenders: [cash(TOTAL)] }),
          asTenant((tx) =>
            collection.captureSynchronousTendersInTx(tx, {
              tenantId,
              companyId: aed.companyId,
              branchId: aed.branchId,
              invoiceId: earlier.invoiceId,
              amountMinor: 4_000n,
              tenders: [{ method: 'CASH' as const, amountMinor: 4_000n }],
              createdByUserId: actor,
              actingUserId: actor,
              idempotencyKey: `pay-${randomUUID()}`,
            }),
          ),
        ]);
        expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
        expect((await accountOf(c.ccaId)).outstanding).toBe(TOTAL - 4_000n);
      }
    }, 120_000);

    const dupCases: [string, (c: Cust) => Promise<SaleParts>][] = [
      ['PAY_NOW', async () => ({ tenders: [cash(TOTAL)] })],
      ['ON_CREDIT', async () => ({ intent: 'ON_CREDIT', tenders: [cash(2_000n)] })],
      [
        'advance-involved',
        async (c) => ({
          tenders: [cash(8_500n)],
          advances: [adv(await mkAdvance(c, 20_000n), 2_000n)],
        }),
      ],
    ];
    it.each(dupCases)(
      'duplicate-complete race (%s): two attempts and eight attempts → exactly one sale, clean 409 losers',
      async (_n, mk) => {
        for (const attempts of [2, 8]) {
          const c = await mkCustomer(aed, { enabled: true, limit: null });
          const o = await mkOrder(aed, c.customerId, one(10_000n));
          const parts = await mk(c);
          const settled = await Promise.allSettled(
            Array.from({ length: attempts }, () => sale(o, parts)),
          );
          const ok = settled.filter((s) => s.status === 'fulfilled');
          const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
          expect(ok).toHaveLength(1);
          expect(bad).toHaveLength(attempts - 1);
          noDeadlock(bad);
          for (const r of bad) {
            expect(['ORDER_INVALID_STATE_TRANSITION', 'ORDER_VERSION_CONFLICT']).toContain(
              (r.reason as DomainError).code,
            );
            expect((r.reason as DomainError).status).toBe(409);
          }
          const inv = (await invoiceOf(o.orderId))!;
          expect(
            (
              await q<{ n: number }>(
                `SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`,
                [o.orderId],
              )
            )[0]!.n,
          ).toBe(1);
          const recs = await receivablesOf(inv.id);
          expect(recs).toHaveLength(1);
          const winner = (ok[0] as PromiseFulfilledResult<CompleteCustomerSaleResult>).value;
          expect(await paymentsOf(inv.id)).toHaveLength(winner.payments.length);
          expect(await applicationsOf(recs[0]!.id)).toHaveLength(winner.advanceApplications.length);
          // one economic journal set
          const journals = await saleJournals(inv.id);
          expect(journals.filter((j) => j.startsWith('invoice_ar|'))).toHaveLength(1);
          expect(journals.filter((j) => j.startsWith('walk_in_sale'))).toHaveLength(0);
          expect(journals).toHaveLength(
            1 + 2 * winner.payments.length + winner.advanceApplications.length,
          );
        }
      },
      240_000,
    );
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 9. the OBSERVED lock order of the composed customer flow
  // ═════════════════════════════════════════════════════════════════════════════
  describe('observed lock order', () => {
    it('ON_CREDIT with an advance and a tender: ORDER → LINES → ACCOUNT → numbering → INVOICE → ADVANCE → payments → GL', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const advanceId = await mkAdvance(c, 2_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeCustomerSaleInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, {
            intent: 'ON_CREDIT',
            tenders: [cash(3_500n)],
            advances: [adv(advanceId, 2_000n)],
          }),
        ),
      );
      expect(lockTrace(events)).toEqual([
        'order:FOR UPDATE', // the orchestrator's gate — the very first lock
        'order:FOR UPDATE', // prepareFinalization (an already-held lock)
        'order_line:FOR UPDATE',
        'account:FOR UPDATE', // the customer pre-flight: credit gate under the account lock
        'order:FOR UPDATE', // issuance re-validation (no-op)
        'order_line:FOR UPDATE',
        'account:FOR UPDATE', // the frozen issuance gate — already held (no-op)
        'orderLine.update',
        'counter:ORDER', // numbering: AFTER the account lock, so a denied sale burns no number
        'counter:INVOICE',
        'order.update',
        'invoice.create',
        'customerReceivable.create',
        'company:FOR SHARE', // the invoice_ar journal
        'accounting_period:FOR SHARE',
        'invoice:FOR UPDATE', // advance application: the coverage anchor (the NEW invoice)…
        'account:FOR UPDATE', // …then the account (no-op)…
        'advance:FOR UPDATE', // …then the advance — the frozen 3b.6 order
        'customerAdvanceApplication.create',
        'company:FOR SHARE', // the advance journal
        'accounting_period:FOR SHARE',
        'order:FOR SHARE', // capture: a no-op downgrade of the order lock
        'invoice:FOR UPDATE', // …then the invoice (no-op) — ORDER before INVOICE
        'INSERT payment_attempt',
        'INSERT payment',
        'INSERT payment_allocation',
        'company:FOR SHARE', // the receipt journal
        'accounting_period:FOR SHARE',
        'account:FOR UPDATE', // the allocation effects (no-op)
        'company:FOR SHARE', // the allocation journal
        'accounting_period:FOR SHARE',
      ]);
    });

    it('two advances are locked in ASCENDING id order (the canonical lock order), whatever order the request names them', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const x = await mkAdvance(c, 2_000n);
      const y = await mkAdvance(c, 2_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const requested = x < y ? [adv(y, 1_000n), adv(x, 1_000n)] : [adv(x, 1_000n), adv(y, 1_000n)]; // descending
      const events: TxEvent[] = [];
      const res = await asTenant((tx) =>
        svc.completeCustomerSaleInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, { intent: 'ON_CREDIT', advances: requested }),
        ),
      );
      const ascending = [x, y].sort();
      expect(res.advanceApplications.map((a) => a.advanceId)).toEqual(ascending);
      const advanceLockIds = events
        .filter(
          (e): e is Extract<TxEvent, { kind: 'sql' }> =>
            e.kind === 'sql' && /FROM "customer_advance" .*FOR UPDATE/.test(e.text),
        )
        .map((e) => e.values[0]);
      expect(advanceLockIds).toEqual(ascending);
    });

    it('a customer PAY_NOW (tender only) holds the account before any number and never runs the walk-in journal path', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeCustomerSaleInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, { tenders: [cash(TOTAL)] }),
        ),
      );
      const trace = lockTrace(events);
      expect(trace.indexOf('account:FOR UPDATE')).toBeLessThan(trace.indexOf('counter:ORDER'));
      expect(trace.indexOf('invoice:FOR UPDATE')).toBeGreaterThan(trace.indexOf('invoice.create'));
      expect(trace.filter((t) => t === 'advance:FOR UPDATE')).toEqual([]);
      expect(trace.filter((t) => t.startsWith('OTHER:') || t.startsWith('TX-CONTROL'))).toEqual([]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 10. isolation (non-disclosing, zero mutation) — explicit predicates, not just RLS
  // ═════════════════════════════════════════════════════════════════════════════
  describe('tenant / company / branch / customer isolation', () => {
    const attempt = async (
      o: MadeOrder,
      over: Partial<CompleteCustomerSaleInTxInput>,
      scopeTenant: string = tenantId,
    ) => {
      const before = await snapshot();
      const events: TxEvent[] = [];
      const err = await runScoped(prisma, { tenantId: scopeTenant }, (tx) =>
        svc.completeCustomerSaleInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, { tenders: [cash(TOTAL)] }, over),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(lockTrace(events)).toEqual(['order:FOR UPDATE']); // the gate itself matches nothing
      expect((err as DomainError).code).toBe('ORDER_NOT_FOUND');
      expect((err as DomainError).status).toBe(404);
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
    };

    it("another tenant's session (RLS) cannot sell this customer order", async () => {
      const c = await mkCustomer(aed);
      await attempt(
        await mkOrder(aed, c.customerId, one(10_000n)),
        { tenantId: otherTenantId },
        otherTenantId,
      );
    });
    it("a foreign tenantId claimed inside this tenant's scope matches nothing", async () => {
      const c = await mkCustomer(aed);
      await attempt(await mkOrder(aed, c.customerId, one(10_000n)), { tenantId: otherTenantId });
    });
    it('another company of the SAME tenant matches nothing', async () => {
      const c = await mkCustomer(aed);
      await attempt(await mkOrder(aed, c.customerId, one(10_000n)), { companyId: aed2.companyId });
    });
    it('a sibling branch of the same company matches nothing (branch is the isolation boundary)', async () => {
      const c = await mkCustomer(aed);
      await attempt(await mkOrder(aed, c.customerId, one(10_000n)), {
        branchId: aed.siblingBranchId,
      });
    });
    it('an unknown order id matches nothing', async () => {
      const c = await mkCustomer(aed);
      await attempt(await mkOrder(aed, c.customerId, one(10_000n)), { orderId: randomUUID() });
    });
    it('the conventional entry point filters by the guarded branchId explicitly (a sibling branchId matches nothing)', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const before = await snapshot();
      const ctx = new RequestContext({
        requestId: randomUUID(),
        tenantId,
        userId: actor,
        branchScope: 'ALL',
      });
      const err = await runWithContext(ctx, () =>
        svc.completeCustomerSaleForBranchScoped({
          companyId: aed.companyId,
          branchId: aed.siblingBranchId,
          orderId: o.orderId,
          expectedVersion: 1,
          paymentIntent: 'PAY_NOW',
          tenders: [cash(TOTAL)],
          advances: [],
          operationKey: 'op',
        }),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('ORDER_NOT_FOUND');
      expect(await snapshot()).toEqual(before);
    });

    it('the conventional entry point takes tenant + actor from the context, opens ONE transaction, and authorizes an override from the context', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 5_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const ctx = new RequestContext({
        requestId: randomUUID(),
        tenantId,
        userId: actor,
        accountType: 'USER',
        mfaLevel: 'STEP_UP',
        effectivePermissions: ['customers:credit:override'],
        entitlements: ['customers'],
      });
      const spy = vi.spyOn(prisma, '$transaction');
      let transactions: number;
      let res: CompleteCustomerSaleResult;
      try {
        res = await runWithContext(ctx, () =>
          svc.completeCustomerSaleForBranchScoped({
            companyId: aed.companyId,
            branchId: aed.branchId,
            orderId: o.orderId,
            expectedVersion: 1,
            paymentIntent: 'ON_CREDIT',
            tenders: [cash(1_000n)],
            advances: [],
            creditLimitExceptionReason: 'owner approved',
            operationKey: `op-${randomUUID()}`,
          }),
        );
      } finally {
        transactions = spy.mock.calls.length;
        spy.mockRestore();
      }
      expect(transactions).toBe(1);
      expect(res.creditAuthorizationMode).toBe('OVERRIDE');
      const pays = await paymentsOf(res.invoiceId);
      expect(
        (
          await q<{ by: string | null }>(
            `SELECT "createdByUserId" AS by FROM payment WHERE id = $1`,
            [pays[0]!.paymentId],
          )
        )[0]!.by,
      ).toBe(actor);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 11. compatibility with the FROZEN Task 3b.8 cancellation model
  // ═════════════════════════════════════════════════════════════════════════════
  describe('sales produced by 3b.9 are valid inputs to the frozen 3b.8 cancellation (no new behaviour added)', () => {
    const cancel = async (o: MadeOrder, expectedVersion = 2) => {
      const ctx = new RequestContext({ requestId: randomUUID(), tenantId, userId: actor });
      return runWithContext(ctx, () =>
        orderRepo.cancelForBranchScoped({
          companyId: o.co.companyId,
          branchId: o.branchId,
          orderId: o.orderId,
          expectedVersion,
          reason: 'customer cancelled',
        }),
      ).then(
        (order) => ({ ok: true as const, order }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    };

    async function expectCancelled(
      c: Cust,
      o: MadeOrder,
      res: CompleteCustomerSaleResult,
    ): Promise<void> {
      const out = await cancel(o);
      expect(out.ok, out.ok ? '' : String((out as { error: unknown }).error)).toBe(true);
      expect(
        (await q<{ status: string }>(`SELECT status FROM "order" WHERE id = $1`, [o.orderId]))[0]!
          .status,
      ).toBe('CANCELLED');
      expect(
        (
          await q<{ n: number }>(
            `SELECT count(*)::int AS n FROM credit_note WHERE "invoiceId" = $1`,
            [res.invoiceId],
          )
        )[0]!.n,
      ).toBe(1);
      // the AR the sale created is fully reversed or converted — and the projections still agree with the books
      const summary = await asTenant((tx) =>
        read.getSummary(tx, {
          tenantId,
          companyId: o.co.companyId,
          branchId: o.branchId,
          customerId: c.customerId,
        }),
      );
      expect(summary.credit.projectionIntegrity).toEqual({
        receivableProjectionMatches: true,
        advanceProjectionMatches: true,
      });
      expect(summary.branchFinancials.receivableOutstandingMinor).toBe(0n);
    }

    it('an unpaid full-credit ON_CREDIT sale (UNPAID) is cancellable', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await sale(o, { intent: 'ON_CREDIT' });
      expect(res.invoicePaymentStatus).toBe('UNPAID');
      await expectCancelled(c, o, res);
    });

    it('a locally PAID manual-card sale (PAID, not settlement-final) is cancellable', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await sale(o, { tenders: [card(TOTAL)] });
      expect(res.invoicePaymentStatus).toBe('PAID');
      await expectCancelled(c, o, res);
    });

    it('a cash + credit combination (PARTIAL) is cancellable', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await sale(o, { intent: 'ON_CREDIT', tenders: [cash(4_000n)] });
      expect(res.invoicePaymentStatus).toBe('PARTIAL');
      await expectCancelled(c, o, res);
    });

    it('an advance + credit combination (PARTIAL) is cancellable', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const advanceId = await mkAdvance(c, 3_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await sale(o, { intent: 'ON_CREDIT', advances: [adv(advanceId, 3_000n)] });
      expect(res.invoicePaymentStatus).toBe('PARTIAL');
      await expectCancelled(c, o, res);
    });

    it('a tender + advance + credit combination (PARTIAL) is cancellable', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const advanceId = await mkAdvance(c, 2_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await sale(o, {
        intent: 'ON_CREDIT',
        tenders: [card(2_500n)],
        advances: [adv(advanceId, 2_000n)],
      });
      await expectCancelled(c, o, res);
    });

    it('a locally paid CASH / BANK sale (SETTLED) is refused by the frozen settlement-finality rule — the same state a standalone cash payment already produces', async () => {
      for (const tender of [cash(TOTAL), bank(TOTAL)]) {
        const c = await mkCustomer(aed);
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        const res = await sale(o, { tenders: [tender] });
        expect(res.invoicePaymentStatus).toBe('SETTLED');
        const out = await cancel(o);
        expect(out.ok).toBe(false);
        const error = (out as { error: DomainError }).error;
        expect(error.code).toBe('INVOICE_CANCELLATION_NOT_SUPPORTED');
        expect(error.status).toBe(409);
        // the sale is intact
        expect(
          (await q<{ status: string }>(`SELECT status FROM "order" WHERE id = $1`, [o.orderId]))[0]!
            .status,
        ).toBe('CONFIRMED');
      }
    });
  });
});
