import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test of the internal atomic-sale orchestrator and the
// frozen primitives it composes — not production module code.
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
import { computeCanonicalTotals } from '../orders/canonical-totals.js';
import {
  computeCommercialSnapshotFingerprintV2,
  type CommercialSnapshotLine,
} from '../orders/commercial-snapshot.js';
import { InvoiceIssuanceRepository } from '../orders/invoice-issuance.repository.js';
import { OrderRepository } from '../orders/order.repository.js';
import { TaxFinalizationService } from '../orders/tax-finalization.service.js';
import { PaymentCollectionRepository } from '../payments/payment-collection.repository.js';
import { CreditOverrideAuthorizationService } from '../receivables/credit-override-authorization.service.js';
import { CustomerAdvanceApplicationRepository } from '../receivables/customer-advance-application.repository.js';
import { CustomerInvoiceArRepository } from '../receivables/customer-invoice-ar.repository.js';
import { CustomerReceiptEffectsRepository } from '../receivables/customer-receipt-effects.repository.js';
import { PaymentCustomerAttributionRepository } from '../receivables/payment-customer-attribution.repository.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  AtomicWalkInSaleService,
  type AnonymousSaleTenderInput,
  type CompleteAnonymousPayNowInTxInput,
} from './atomic-walk-in-sale.service.js';
import { WalkInSaleJournalRepository } from './walk-in-sale-journal.repository.js';

/**
 * Task 3b.9 Checkpoint C — the ANONYMOUS PAY_NOW atomic sale, against real
 * PostgreSQL. DRAFT anonymous order → canonical totals → exact plan validation →
 * issued invoice → synchronous local tenders → Payment + PaymentAllocation →
 * derived payment status → the `walk_in_sale` journal, all on ONE transaction.
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
      if (/^(order\.update|invoice\.create|orderLine\.update)$/.test(e.name)) out.push(e.name);
    } else {
      const t = e.text;
      if (/FROM "order" .*FOR UPDATE/.test(t)) out.push('order:FOR UPDATE');
      else if (/FROM "order" .*FOR SHARE/.test(t)) out.push('order:FOR SHARE');
      else if (/FROM "order_line" .*FOR UPDATE/.test(t)) out.push('order_line:FOR UPDATE');
      else if (/INSERT INTO "document_number_counter"/.test(t)) {
        out.push(`counter:${String(e.values.find((v) => v === 'ORDER' || v === 'INVOICE'))}`);
      } else if (/FROM "invoice" .*FOR UPDATE/.test(t)) out.push('invoice:FOR UPDATE');
      else if (/INSERT INTO "payment_attempt"/.test(t)) out.push('INSERT payment_attempt');
      else if (/INSERT INTO "payment" /.test(t)) out.push('INSERT payment');
      else if (/INSERT INTO "payment_allocation"/.test(t)) out.push('INSERT payment_allocation');
      else if (/FROM "company" .*FOR SHARE/.test(t)) out.push('company:FOR SHARE');
      else if (/FROM "accounting_period" .*FOR SHARE/.test(t))
        out.push('accounting_period:FOR SHARE');
      else if (/FOR UPDATE/.test(t)) out.push(`OTHER:FOR UPDATE:${t.slice(0, 60)}`);
    }
  }
  return out;
}

// Checkpoint D added the three frozen 3b.6 collaborators to the service constructor; the anonymous
// path never touches them, so every test below keeps building the service the same way.
let customerSaleDeps: readonly [
  CustomerInvoiceArRepository,
  CustomerAdvanceApplicationRepository,
  CreditOverrideAuthorizationService,
];
const newSvc = (
  db: DbService,
  f: TaxFinalizationService,
  c: PaymentCollectionRepository,
  j: WalkInSaleJournalRepository,
): AtomicWalkInSaleService => new AtomicWalkInSaleService(db, f, c, j, ...customerSaleDeps);

class InjectedFault extends Error {
  constructor(label: string) {
    super(`INJECTED_FAULT:${label}`);
  }
}

describe('AtomicWalkInSaleService (task 3b.9 Checkpoint C, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let observer: pg.Pool;
  let db: DbService;
  let prisma: PrismaClient;
  let svc: AtomicWalkInSaleService;
  let finalization: TaxFinalizationService;
  let orderRepo: OrderRepository;

  // collaborators (kept so faulty variants can be built from the same parts)
  let audit: AuditWriter;
  let outbox: OutboxWriter;
  let engine: PostingEngineService;
  let companyConfig: CompanyFinancialConfigRepository;
  let issuance: InvoiceIssuanceRepository;
  let collection: PaymentCollectionRepository;
  let walkInJournal: WalkInSaleJournalRepository;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actor = randomUUID();

  let categoryId = '';
  let productId = '';
  let variantId = '';

  interface Co {
    companyId: string;
    branchId: string;
    siblingBranchId: string;
    terminalId: string;
    siblingTerminalId: string;
    currency: 'AED' | 'KWD';
    exponent: number;
  }
  let aed: Co;
  let aed2: Co; // a second AED company (same tenant)
  let kwd: Co;
  let closed: Co; // OPEN→CLOSED period (journal posting must fail)
  let noPeriod: Co; // accounts but no accounting period at all

  const fakeClock = { now: () => new Date('2026-06-15T10:00:00Z') } as unknown as SystemClock;
  const asTenant = <T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> =>
    runScoped(prisma, { tenantId }, fn);

  // ── fixtures ────────────────────────────────────────────────────────────────
  async function makeCompany(
    tid: string,
    o: { currency: 'AED' | 'KWD'; period: 'open' | 'closed' | 'none'; tz?: string },
  ): Promise<Co> {
    const co: Co = {
      companyId: randomUUID(),
      branchId: randomUUID(),
      siblingBranchId: randomUUID(),
      terminalId: randomUUID(),
      siblingTerminalId: randomUUID(),
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
    for (const [id, branch] of [
      [co.terminalId, co.branchId],
      [co.siblingTerminalId, co.siblingBranchId],
    ] as const) {
      await pool.query(
        `INSERT INTO pos_terminal (id,"tenantId","companyId","branchId",code,name,"updatedAt")
         VALUES ($1,$2,$3,$4,$5,'POS',now())`,
        [id, tid, co.companyId, branch, `POS-${id.slice(0, 8)}`],
      );
    }
    if (tid === tenantId) {
      await asTenant((tx) =>
        accounts.ensureDefaultAccounts(tx, { tenantId: tid, companyId: co.companyId }),
      );
      if (o.period !== 'none') {
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
    }
    return co;
  }

  async function makeCustomer(companyId: string): Promise<string> {
    const customerId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Linked',now())`,
      [customerId, tenantId],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [randomUUID(), tenantId, companyId, customerId],
    );
    return customerId;
  }

  interface LineSpec {
    quantity: string;
    unitPriceAmountMinor: bigint;
    discountAmountMinor?: bigint;
    discountBps?: number;
    /** null = no rate (`resolutionSource='NONE'`) */
    rateBps: number | null;
  }
  interface OrderSpec {
    lines: LineSpec[];
    taxPriceMode?: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
    taxRoundingScope?: 'LINE' | 'DOCUMENT';
    documentDiscountAmountMinor?: bigint;
    documentDiscountBps?: number;
    kind?: string;
    customerId?: string | null;
    posTerminalId?: string | null;
    status?: 'DRAFT' | 'HELD' | 'CANCELLED';
  }
  interface MadeOrder {
    orderId: string;
    co: Co;
    branchId: string;
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
      discountMode:
        spec.discountBps !== undefined ? 'PERCENT_BPS' : amount > 0n ? 'AMOUNT' : 'NONE',
      discountBps: spec.discountBps ?? null,
      discountAmountMinor: amount.toString(),
      taxCategoryKey: spec.rateBps === null ? null : 'STANDARD',
      rateBps: spec.rateBps,
      effectiveFrom: spec.rateBps === null ? null : '2020-01-01',
      resolutionSource: spec.rateBps === null ? 'NONE' : 'VARIANT',
    };
  }

  /** one DRAFT (or HELD / CANCELLED) order + its lines, with a REAL frozen fingerprint */
  async function mkOrder(
    co: Co,
    spec: OrderSpec,
    branchId: string = co.branchId,
  ): Promise<MadeOrder> {
    const taxPriceMode = spec.taxPriceMode ?? 'TAX_EXCLUSIVE';
    const taxRoundingScope = spec.taxRoundingScope ?? 'LINE';
    const docAmount = spec.documentDiscountAmountMinor ?? 0n;
    const docMode =
      spec.documentDiscountBps !== undefined ? 'PERCENT_BPS' : docAmount > 0n ? 'AMOUNT' : 'NONE';
    const customerId = spec.customerId ?? null;
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
        documentDiscountMode: docMode,
        documentDiscountBps: spec.documentDiscountBps ?? null,
        documentDiscountAmountMinor: docAmount.toString(),
        documentDiscountReason: null,
      },
      { taxPriceMode, taxRoundingScope, taxRoundingMode: 'HALF_UP' },
    );
    const orderId = randomUUID();
    await pool.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId","posTerminalId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor",
          "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'DRAFT',$8,$9,$10,$11,$12,$13,2,$14,$15,'HALF_UP',now())`,
      [
        orderId,
        tenantId,
        co.companyId,
        branchId,
        customerId,
        spec.posTerminalId ?? null,
        kind,
        co.currency,
        co.exponent,
        docMode,
        spec.documentDiscountBps ?? null,
        docAmount.toString(),
        fingerprint,
        taxPriceMode,
        taxRoundingScope,
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
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 CASE WHEN $16::int IS NULL THEN NULL ELSE '2020-01-01'::date END,$17,
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
          l.discountBps !== undefined ? 'PERCENT_BPS' : amount > 0n ? 'AMOUNT' : 'NONE',
          l.discountBps ?? null,
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
    return { orderId, co, branchId, version };
  }

  const cash = (amountMinor: bigint): AnonymousSaleTenderInput => ({ method: 'CASH', amountMinor });
  const bank = (amountMinor: bigint): AnonymousSaleTenderInput => ({
    method: 'BANK_TRANSFER',
    amountMinor,
  });
  const card = (amountMinor: bigint): AnonymousSaleTenderInput => ({
    method: 'CARD_TERMINAL',
    amountMinor,
  });
  const other = (amountMinor: bigint): AnonymousSaleTenderInput => ({
    method: 'OTHER_MANUAL',
    amountMinor,
  });

  function saleInput(
    o: MadeOrder,
    tenders: readonly AnonymousSaleTenderInput[],
    over: Partial<CompleteAnonymousPayNowInTxInput> = {},
  ): CompleteAnonymousPayNowInTxInput {
    return {
      tenantId,
      companyId: o.co.companyId,
      branchId: o.branchId,
      orderId: o.orderId,
      expectedVersion: o.version,
      paymentIntent: 'PAY_NOW',
      tenders,
      operationKey: `op-${randomUUID()}`,
      actorUserId: actor,
      ...over,
    };
  }

  const complete = (
    o: MadeOrder,
    tenders: readonly AnonymousSaleTenderInput[],
    over: Partial<CompleteAnonymousPayNowInTxInput> = {},
    service: AtomicWalkInSaleService = svc,
  ) => asTenant((tx) => service.completeAnonymousPayNowInTx(tx, saleInput(o, tenders, over)));

  // ── readers (all BIGINT columns ::text-cast and BigInt-converted) ─────────────
  const q = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    p: pg.Pool = pool,
  ): Promise<T[]> => (await p.query(sql, params)).rows as T[];

  async function invoiceOf(orderId: string) {
    const r = (
      await q<{
        id: string;
        invoiceNumber: string;
        status: string;
        sub: string;
        disc: string;
        tax: string;
        total: string;
        cur: string;
        exp: number;
        date: string;
        branchId: string;
      }>(
        `SELECT id, "invoiceNumber", "invoicePaymentStatus" AS status,
                "subtotalAmountMinor"::text AS sub, "documentDiscountAmountMinor"::text AS disc,
                "taxTotalAmountMinor"::text AS tax, "totalAmountMinor"::text AS total,
                "currencyCode" AS cur, "currencyExponent" AS exp, "invoiceDate"::text AS date,
                "branchId"
           FROM invoice WHERE "orderId" = $1`,
        [orderId],
      )
    )[0];
    if (!r) return null;
    return {
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      status: r.status,
      subtotal: BigInt(r.sub),
      discount: BigInt(r.disc),
      tax: BigInt(r.tax),
      total: BigInt(r.total),
      currency: r.cur,
      exponent: r.exp,
      date: r.date,
      branchId: r.branchId,
    };
  }

  async function paymentsOf(invoiceId: string) {
    const rows = await q<{
      paymentId: string;
      method: string;
      amount: string;
      cur: string;
      exp: number;
      groupId: string | null;
      allocAmount: string;
      allocCur: string;
      allocExp: number;
      attemptState: string;
      branchId: string;
      createdBy: string | null;
    }>(
      `SELECT p.id AS "paymentId", p.method, p."amountMinor"::text AS amount,
              p."currencyCode" AS cur, p."currencyExponent" AS exp, p."paymentGroupId" AS "groupId",
              pa."amountMinor"::text AS "allocAmount", pa."currencyCode" AS "allocCur",
              pa."currencyExponent" AS "allocExp", att.state AS "attemptState",
              p."branchId", p."createdByUserId" AS "createdBy"
         FROM payment_allocation pa
         JOIN payment p ON p.id = pa."paymentId"
         JOIN payment_attempt att ON att.id = p."sourceAttemptId"
        WHERE pa."invoiceId" = $1
        ORDER BY p."createdAt", p.id`,
      [invoiceId],
    );
    return rows.map((r) => ({
      paymentId: r.paymentId,
      method: r.method,
      amount: BigInt(r.amount),
      currency: r.cur,
      exponent: r.exp,
      groupId: r.groupId,
      allocAmount: BigInt(r.allocAmount),
      allocCurrency: r.allocCur,
      allocExponent: r.allocExp,
      attemptState: r.attemptState,
      branchId: r.branchId,
      createdBy: r.createdBy,
    }));
  }

  async function journalsOf(invoiceId: string) {
    return q<{ id: string; sourceKind: string; postingDate: string; currencyCode: string }>(
      `SELECT id, "sourceKind", "postingDate"::text AS "postingDate", "currencyCode"
         FROM journal_entry WHERE "tenantId" = $1 AND "sourceId" = $2`,
      [tenantId, invoiceId],
    );
  }

  async function linesOf(journalEntryId: string): Promise<string[]> {
    const rows = await q<{
      key: string;
      debit: string;
      credit: string;
      branchId: string | null;
      posTerminalId: string | null;
    }>(
      `SELECT a."key" AS key, jl."debitMinor"::text AS debit, jl."creditMinor"::text AS credit,
              jl."branchId", jl."posTerminalId"
         FROM journal_line jl JOIN account a ON a.id = jl."accountId"
        WHERE jl."journalEntryId" = $1`,
      [journalEntryId],
    );
    return rows
      .map((r) => ({ ...r, d: BigInt(r.debit), c: BigInt(r.credit) }))
      .sort((a, b) =>
        a.d > 0n !== b.d > 0n ? (a.d > 0n ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      )
      .map((r) => (r.d > 0n ? `Dr ${r.key} ${r.d}` : `Cr ${r.key} ${r.c}`));
  }

  async function lineDimensions(journalEntryId: string) {
    return q<{ branchId: string | null; posTerminalId: string | null }>(
      `SELECT DISTINCT "branchId", "posTerminalId" FROM journal_line WHERE "journalEntryId" = $1`,
      [journalEntryId],
    );
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
    'credit_note',
    'refund',
  ] as const;

  /** every table a sale touches + order state + the company counters, for THIS tenant */
  async function snapshot(p: pg.Pool = pool): Promise<Record<string, number | string>> {
    const out: Record<string, number | string> = {};
    for (const t of EFFECT_TABLES) {
      out[t] = (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" = $1`,
          [tenantId],
          p,
        )
      )[0]!.n;
    }
    out['orders'] = String(
      (
        await q<{ s: string | null }>(
          `SELECT string_agg(id::text || ':' || status || ':' || version::text || ':' || coalesce("orderNumber", ''), ',' ORDER BY id) AS s
             FROM "order" WHERE "tenantId" = $1`,
          [tenantId],
          p,
        )
      )[0]!.s,
    );
    out['counters'] = String(
      (
        await q<{ s: string | null }>(
          `SELECT string_agg("companyId"::text || ':' || "documentType" || ':' || "nextNumber"::text, ',' ORDER BY "companyId", "documentType") AS s
             FROM document_number_counter WHERE "tenantId" = $1`,
          [tenantId],
          p,
        )
      )[0]!.s,
    );
    return out;
  }

  /** the next number the company counter will hand out, as the formatted document number */
  async function nextNumbers(co: Co): Promise<{ order: string; invoice: string }> {
    const rows = await q<{ documentType: string; nextNumber: string }>(
      `SELECT "documentType", "nextNumber"::text AS "nextNumber" FROM document_number_counter
        WHERE "tenantId" = $1 AND "companyId" = $2`,
      [tenantId, co.companyId],
    );
    const n = (type: string, prefix: string): string =>
      `${prefix}-${String(rows.find((r) => r.documentType === type)?.nextNumber ?? '1').padStart(6, '0')}`;
    return { order: n('ORDER', 'ORD'), invoice: n('INVOICE', 'INV') };
  }

  async function auditDelta(before: Map<string, number>): Promise<Record<string, number>> {
    const now = new Map<string, number>();
    for (const r of await q<{ k: string; n: number }>(
      `SELECT 'audit:' || action AS k, count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 GROUP BY action
       UNION ALL
       SELECT 'outbox:' || "eventType", count(*)::int FROM outbox WHERE "tenantId" = $1 GROUP BY "eventType"`,
      [tenantId],
    )) {
      now.set(r.k, r.n);
    }
    const out: Record<string, number> = {};
    for (const [k, n] of now) {
      const d = n - (before.get(k) ?? 0);
      if (d !== 0) out[k] = d;
    }
    return out;
  }
  async function auditBaseline(): Promise<Map<string, number>> {
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

  // ── setup ───────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    observer = new pg.Pool({ connectionString: stack.postgres.url, max: 2 });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();

    audit = new AuditWriter(db);
    outbox = new OutboxWriter(db);
    accounts = new AccountRepository(db, audit);
    periods = new AccountingPeriodRepository(db, audit);
    companyConfig = new CompanyFinancialConfigRepository(db, audit, accounts);
    engine = new PostingEngineService(companyConfig, periods, audit, fakeClock);
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
      new CustomerReceiptEffectsRepository(engine, audit),
    );
    walkInJournal = new WalkInSaleJournalRepository(engine, companyConfig);
    customerSaleDeps = [
      new CustomerInvoiceArRepository(engine, audit),
      new CustomerAdvanceApplicationRepository(
        engine,
        audit,
        new CustomerReceiptEffectsRepository(engine, audit),
        outbox,
      ),
      new CreditOverrideAuthorizationService(new PolicyEngine()),
    ];
    svc = newSvc(db, finalization, collection, walkInJournal);
    // the REAL frozen cancellation path; only collaborators it never reaches for a
    // walk-in DRAFT / walk-in invoiced order are stubbed, and the permission gate
    // (not under test) is allowed so the frozen 3b.8 anonymous restriction is what answers.
    const policyAllowed = { can: () => ({ allowed: true }) } as unknown as PolicyEngine;
    orderRepo = new OrderRepository(
      db,
      audit,
      fakeClock,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      policyAllowed,
      {} as never,
      {} as never,
    );

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `sale-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt")
         VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [id, `sale-${id.slice(0, 8)}`, planVersionId],
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
    categoryId = randomUUID();
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
    noPeriod = await makeCompany(tenantId, { currency: 'AED', period: 'none' });
    await makeCompany(otherTenantId, { currency: 'AED', period: 'none' });
  }, 240_000);

  afterAll(async () => {
    await observer?.end();
    await pool?.end();
    await db?.onModuleDestroy();
    await stack?.stop();
  });

  /** all tests that expect a REJECTION assert zero economic effect + nothing burned */
  async function expectRejectedWithNoEffect(
    o: MadeOrder,
    run: () => Promise<unknown>,
    code: string,
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
    expect(await snapshot()).toEqual(before);
    expect(await invoiceOf(o.orderId)).toBeNull();
    return err as DomainError;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // 1. the complete atomic sale — money / tax / tender matrix
  // ═════════════════════════════════════════════════════════════════════════════
  describe('complete sale matrix (canonical totals, exact journal, derived statuses)', () => {
    interface Scenario {
      name: string;
      co: () => Co;
      spec: OrderSpec;
      tenders: AnonymousSaleTenderInput[];
      subtotal?: bigint;
      discount?: bigint;
      tax?: bigint;
      total?: bigint;
      journal?: string[];
      status: string;
      grouped?: boolean;
    }
    const scenarios: Scenario[] = [
      {
        name: 'CASH, tax-exclusive 5% (105.00)',
        co: () => aed,
        spec: one(10_000n),
        tenders: [cash(10_500n)],
        subtotal: 10_000n,
        discount: 0n,
        tax: 500n,
        total: 10_500n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 10500',
          'Cr LIABILITY.TAX_PAYABLE 500',
          'Cr REVENUE.SALES 10000',
        ],
        status: 'SETTLED',
      },
      {
        name: 'BANK_TRANSFER, tax-exclusive 5% (26.25)',
        co: () => aed,
        spec: one(2_500n),
        tenders: [bank(2_625n)],
        subtotal: 2_500n,
        tax: 125n,
        total: 2_625n,
        journal: ['Dr ASSET.BANK 2625', 'Cr LIABILITY.TAX_PAYABLE 125', 'Cr REVENUE.SALES 2500'],
        status: 'SETTLED',
      },
      {
        name: 'manual CARD_TERMINAL',
        co: () => aed,
        spec: one(10_000n),
        tenders: [card(10_500n)],
        total: 10_500n,
        journal: [
          'Dr ASSET.PAYMENT_CLEARING 10500',
          'Cr LIABILITY.TAX_PAYABLE 500',
          'Cr REVENUE.SALES 10000',
        ],
        status: 'PAID',
      },
      {
        name: 'OTHER_MANUAL',
        co: () => aed,
        spec: one(10_000n),
        tenders: [other(10_500n)],
        total: 10_500n,
        journal: [
          'Dr ASSET.PAYMENT_CLEARING 10500',
          'Cr LIABILITY.TAX_PAYABLE 500',
          'Cr REVENUE.SALES 10000',
        ],
        status: 'PAID',
      },
      {
        name: 'Multi Payment CASH + BANK + manual CARD (different accounts)',
        co: () => aed,
        spec: one(10_000n),
        tenders: [cash(5_000n), bank(3_000n), card(2_500n)],
        total: 10_500n,
        journal: [
          'Dr ASSET.BANK 3000',
          'Dr ASSET.CASH_ON_HAND 5000',
          'Dr ASSET.PAYMENT_CLEARING 2500',
          'Cr LIABILITY.TAX_PAYABLE 500',
          'Cr REVENUE.SALES 10000',
        ],
        status: 'PAID',
        grouped: true,
      },
      {
        name: 'Multi Payment CASH + CASH (same account aggregates)',
        co: () => aed,
        spec: one(10_000n),
        tenders: [cash(6_000n), cash(4_500n)],
        total: 10_500n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 10500',
          'Cr LIABILITY.TAX_PAYABLE 500',
          'Cr REVENUE.SALES 10000',
        ],
        status: 'SETTLED',
        grouped: true,
      },
      {
        name: 'tax-inclusive 5% (105.00 gross)',
        co: () => aed,
        spec: { ...one(10_500n), taxPriceMode: 'TAX_INCLUSIVE' },
        tenders: [cash(10_500n)],
        total: 10_500n,
        tax: 500n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 10500',
          'Cr LIABILITY.TAX_PAYABLE 500',
          'Cr REVENUE.SALES 10000',
        ],
        status: 'SETTLED',
      },
      {
        name: 'zero tax (no rate resolved)',
        co: () => aed,
        spec: one(10_000n, null),
        tenders: [cash(10_000n)],
        subtotal: 10_000n,
        tax: 0n,
        total: 10_000n,
        journal: ['Dr ASSET.CASH_ON_HAND 10000', 'Cr REVENUE.SALES 10000'],
        status: 'SETTLED',
      },
      {
        name: 'zero-RATE (configured 0%) behaves as zero tax',
        co: () => aed,
        spec: one(10_000n, 0),
        tenders: [bank(10_000n)],
        tax: 0n,
        total: 10_000n,
        journal: ['Dr ASSET.BANK 10000', 'Cr REVENUE.SALES 10000'],
        status: 'SETTLED',
      },
      {
        name: 'line discount (2 × 100.00 − 20.00)',
        co: () => aed,
        spec: {
          lines: [
            {
              quantity: '2.0000',
              unitPriceAmountMinor: 10_000n,
              discountAmountMinor: 2_000n,
              rateBps: 500,
            },
          ],
        },
        tenders: [cash(18_900n)],
        subtotal: 18_000n,
        tax: 900n,
        total: 18_900n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 18900',
          'Cr LIABILITY.TAX_PAYABLE 900',
          'Cr REVENUE.SALES 18000',
        ],
        status: 'SETTLED',
      },
      {
        name: 'line percent discount (10%)',
        co: () => aed,
        spec: {
          lines: [
            {
              quantity: '1.0000',
              unitPriceAmountMinor: 10_000n,
              discountBps: 1_000,
              discountAmountMinor: 1_000n,
              rateBps: 500,
            },
          ],
        },
        tenders: [cash(9_450n)],
        subtotal: 9_000n,
        tax: 450n,
        total: 9_450n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 9450',
          'Cr LIABILITY.TAX_PAYABLE 450',
          'Cr REVENUE.SALES 9000',
        ],
        status: 'SETTLED',
      },
      {
        name: 'document fixed discount (10.00)',
        co: () => aed,
        spec: { ...one(10_000n), documentDiscountAmountMinor: 1_000n },
        tenders: [cash(9_450n)],
        subtotal: 10_000n,
        discount: 1_000n,
        tax: 450n,
        total: 9_450n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 9450',
          'Cr LIABILITY.TAX_PAYABLE 450',
          'Cr REVENUE.SALES 9000',
        ],
        status: 'SETTLED',
      },
      {
        name: 'document percent discount (10%)',
        co: () => aed,
        spec: { ...one(10_000n), documentDiscountBps: 1_000, documentDiscountAmountMinor: 1_000n },
        tenders: [cash(9_450n)],
        subtotal: 10_000n,
        discount: 1_000n,
        tax: 450n,
        total: 9_450n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 9450',
          'Cr LIABILITY.TAX_PAYABLE 450',
          'Cr REVENUE.SALES 9000',
        ],
        status: 'SETTLED',
      },
      {
        name: 'multi-line order with a document discount (canonical equality only)',
        co: () => aed,
        spec: {
          lines: [
            { quantity: '1.0000', unitPriceAmountMinor: 5_000n, rateBps: 500 },
            { quantity: '3.0000', unitPriceAmountMinor: 2_333n, rateBps: 500 },
          ],
          documentDiscountAmountMinor: 600n,
        },
        tenders: [], // filled from the canonical total below
        status: 'SETTLED',
      },
      {
        name: 'KWD 3-decimal, tax-exclusive 5% (12.345 + 0.617)',
        co: () => kwd,
        spec: one(12_345n),
        tenders: [cash(12_962n)],
        subtotal: 12_345n,
        tax: 617n,
        total: 12_962n,
        journal: [
          'Dr ASSET.CASH_ON_HAND 12962',
          'Cr LIABILITY.TAX_PAYABLE 617',
          'Cr REVENUE.SALES 12345',
        ],
        status: 'SETTLED',
      },
      {
        name: 'KWD 3-decimal, tax-inclusive, Multi Payment',
        co: () => kwd,
        spec: { ...one(12_962n), taxPriceMode: 'TAX_INCLUSIVE' },
        tenders: [cash(10_000n), bank(2_962n)],
        total: 12_962n,
        tax: 617n,
        journal: [
          'Dr ASSET.BANK 2962',
          'Dr ASSET.CASH_ON_HAND 10000',
          'Cr LIABILITY.TAX_PAYABLE 617',
          'Cr REVENUE.SALES 12345',
        ],
        status: 'SETTLED',
        grouped: true,
      },
    ];

    it.each(scenarios.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
      const co = s.co();
      const o = await mkOrder(co, s.spec);
      // the oracle: the pure canonical computation over the PERSISTED rows (an independent call)
      const orderRow = (
        await q<{
          taxPriceMode: string;
          taxRoundingScope: string;
          taxRoundingMode: string;
          doc: string;
        }>(
          `SELECT "taxPriceMode","taxRoundingScope","taxRoundingMode","documentDiscountAmountMinor"::text AS doc FROM "order" WHERE id = $1`,
          [o.orderId],
        )
      )[0]!;
      const lineRows = await q<{
        id: string;
        pos: number;
        qty: string;
        price: string;
        disc: string;
        rate: number | null;
      }>(
        `SELECT id, "linePosition" AS pos, quantity::text AS qty, "unitPriceAmountMinor"::text AS price,
                "discountAmountMinor"::text AS disc, "rateBps" AS rate
           FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"`,
        [o.orderId],
      );
      const canonical = computeCanonicalTotals(
        {
          currencyCode: co.currency,
          currencyExponent: co.exponent,
          documentDiscountAmountMinor: BigInt(orderRow.doc),
          taxPriceMode: orderRow.taxPriceMode,
          taxRoundingScope: orderRow.taxRoundingScope,
          taxRoundingMode: orderRow.taxRoundingMode,
        },
        lineRows.map((l) => ({
          id: l.id,
          linePosition: l.pos,
          quantity: l.qty,
          unitPriceAmountMinor: BigInt(l.price),
          unitPriceCurrencyCode: co.currency,
          discountAmountMinor: BigInt(l.disc),
          rateBps: l.rate,
        })),
      );
      const tenders = s.tenders.length > 0 ? s.tenders : [cash(canonical.totals.totalAmountMinor)];

      const operationKey = `op-matrix-${randomUUID()}`;
      const res = await complete(o, tenders, { operationKey });

      // — the opaque operation key + acting user reach EVERY PaymentAttempt, unchanged
      const attempts = await q<{ key: string; acting: string | null; created: string | null }>(
        `SELECT "idempotencyKey" AS key, "actingUserId" AS acting, "createdByUserId" AS created
           FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [res.invoiceId],
      );
      expect(attempts).toHaveLength(tenders.length);
      for (const a of attempts)
        expect(a).toEqual({ key: operationKey, acting: actor, created: actor });

      // — invoice: stored values == the canonical computation (and == the hand oracle where given)
      const inv = (await invoiceOf(o.orderId))!;
      expect(inv.subtotal).toBe(canonical.totals.subtotalAmountMinor);
      expect(inv.discount).toBe(canonical.totals.documentDiscountAmountMinor);
      expect(inv.tax).toBe(canonical.totals.taxTotalAmountMinor);
      expect(inv.total).toBe(canonical.totals.totalAmountMinor);
      if (s.subtotal !== undefined) expect(inv.subtotal).toBe(s.subtotal);
      if (s.discount !== undefined) expect(inv.discount).toBe(s.discount);
      if (s.tax !== undefined) expect(inv.tax).toBe(s.tax);
      if (s.total !== undefined) expect(inv.total).toBe(s.total);
      expect(inv.currency).toBe(co.currency);
      expect(inv.exponent).toBe(co.exponent);
      expect(res).toMatchObject({
        invoiceId: inv.id,
        totalAmountMinor: inv.total,
        taxTotalAmountMinor: inv.tax,
        outstandingMinor: 0n,
        invoicePaymentStatus: s.status,
      });
      expect(inv.status).toBe(s.status);
      // finalized line tax on every order line == the canonical per-line tax
      const lineTax = await q<{ id: string; tax: string }>(
        `SELECT id, "lineTaxAmountMinor"::text AS tax FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"`,
        [o.orderId],
      );
      expect(lineTax.map((l) => [l.id, BigInt(l.tax)])).toEqual(
        canonical.lines.map((l) => [l.orderLineId, l.lineTaxAmountMinor]),
      );
      expect(
        await q<{ status: string; version: number }>(
          `SELECT status, version FROM "order" WHERE id = $1`,
          [o.orderId],
        ),
      ).toEqual([{ status: 'CONFIRMED', version: 2 }]);

      // — Payment / PaymentAllocation semantics
      const pays = await paymentsOf(inv.id);
      expect(pays.map((p) => [p.method, p.amount])).toEqual(
        tenders.map((t) => [t.method, t.amountMinor]),
      );
      expect(res.payments.map((p) => [p.method, p.amountMinor])).toEqual(
        tenders.map((t) => [t.method, t.amountMinor]),
      );
      for (const p of pays) {
        expect(p.allocAmount).toBe(p.amount);
        expect(p.currency).toBe(co.currency);
        expect(p.exponent).toBe(co.exponent);
        expect(p.allocCurrency).toBe(co.currency);
        expect(p.allocExponent).toBe(co.exponent);
        expect(p.attemptState).toBe('CAPTURED');
        expect(p.branchId).toBe(o.branchId);
        expect(p.createdBy).toBe(actor);
      }
      expect(pays.reduce((a, p) => a + p.allocAmount, 0n)).toBe(inv.total);
      if (tenders.length === 1) {
        expect(pays[0]!.groupId).toBeNull();
        expect(res.paymentGroupId).toBeNull();
      } else {
        const groups = new Set(pays.map((p) => p.groupId));
        expect(groups.size).toBe(1);
        expect([...groups][0]).not.toBeNull();
        expect([...groups][0]).toBe(res.paymentGroupId);
      }

      // — anonymous accounting: ONE walk_in_sale journal, exact lines, no customer-side effect
      const journals = await journalsOf(inv.id);
      expect(journals.map((j) => j.sourceKind)).toEqual(['walk_in_sale']);
      expect(journals[0]!.id).toBe(res.journalEntryId);
      expect(journals[0]!.postingDate).toBe('2026-06-15');
      expect(journals[0]!.currencyCode).toBe(co.currency);
      const lines = await linesOf(journals[0]!.id);
      if (s.journal) expect(lines).toEqual(s.journal);
      const sum = (side: 'Dr' | 'Cr') =>
        lines.filter((l) => l.startsWith(side)).reduce((a, l) => a + BigInt(l.split(' ')[2]!), 0n);
      expect(sum('Dr')).toBe(inv.total);
      expect(sum('Cr')).toBe(inv.total);
      expect(lines.find((l) => l.startsWith('Cr REVENUE.SALES'))).toBe(
        `Cr REVENUE.SALES ${inv.total - inv.tax}`,
      );
      for (const l of lines) {
        expect(l).not.toMatch(
          /RECEIVABLE|CUSTOMER_ADVANCES|UNAPPLIED_RECEIPTS|CONTRA_REVENUE|SALES_DISCOUNT/,
        );
      }
      expect(
        await q(
          `SELECT 1 FROM customer_receivable WHERE "invoiceId" = $1
           UNION ALL SELECT 1 FROM customer_account_entry WHERE "tenantId" = $2 AND "customerCompanyAccountId" IN
             (SELECT id FROM customer_company_account WHERE "tenantId" = $2 AND "companyId" = $3)`,
          [inv.id, tenantId, co.companyId],
        ),
      ).toEqual([]);
      // every journal about this invoice OR one of its payments is that single journal
      expect(
        (
          await q<{ n: number }>(
            `SELECT count(*)::int AS n FROM journal_entry
              WHERE "tenantId" = $1 AND ("sourceId" = $2 OR "sourceId" IN (SELECT id::text FROM payment WHERE id IN (SELECT "paymentId" FROM payment_allocation WHERE "invoiceId" = $3)))`,
            [tenantId, inv.id, inv.id],
          )
        )[0]!.n,
      ).toBe(1);

      // — equivalence with the one-shot finalization of an identical twin order
      const twin = await mkOrder(co, s.spec);
      const twinFingerprint = (
        await q<{ f: string }>(
          `SELECT "commercialSnapshotFingerprint" AS f FROM "order" WHERE id = $1`,
          [twin.orderId],
        )
      )[0]!.f;
      await asTenant((tx) =>
        finalization.finalizeAndIssueInvoice(tx, {
          tenantId,
          companyId: co.companyId,
          branchId: twin.branchId,
          orderId: twin.orderId,
          expectedVersion: 1,
          commercialSnapshotFingerprint: twinFingerprint,
          paymentIntent: 'PAY_NOW',
          actorUserId: actor,
        }),
      );
      const twinInv = (await invoiceOf(twin.orderId))!;
      expect([twinInv.subtotal, twinInv.discount, twinInv.tax, twinInv.total]).toEqual([
        inv.subtotal,
        inv.discount,
        inv.tax,
        inv.total,
      ]);
    });

    it('a POS terminal is attribution only: it appears as a journal-line dimension next to the branch', async () => {
      const o = await mkOrder(aed, { ...one(10_000n), posTerminalId: aed.terminalId });
      const res = await complete(o, [cash(10_500n)]);
      expect(await lineDimensions(res.journalEntryId)).toEqual([
        { branchId: aed.branchId, posTerminalId: aed.terminalId },
      ]);
    });

    it('an order without a POS terminal posts with no terminal dimension', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const res = await complete(o, [cash(10_500n)]);
      expect(await lineDimensions(res.journalEntryId)).toEqual([
        { branchId: aed.branchId, posTerminalId: null },
      ]);
    });

    it('the conventional entry point takes tenant + actor from the RequestContext and opens exactly ONE transaction', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const spy = vi.spyOn(prisma, '$transaction');
      const ctx = new RequestContext({ requestId: randomUUID(), tenantId, userId: actor });

      const res = await runWithContext(ctx, () =>
        svc.completeAnonymousPayNowForBranchScoped({
          companyId: aed.companyId,
          branchId: aed.branchId,
          orderId: o.orderId,
          expectedVersion: o.version,
          paymentIntent: 'PAY_NOW',
          tenders: [cash(5_000n), bank(5_500n)],
          operationKey: `op-${randomUUID()}`,
        }),
      );
      const calls = spy.mock.calls.length;
      spy.mockRestore();

      expect(calls).toBe(1);
      const pays = await paymentsOf(res.invoiceId);
      expect(pays.map((p) => p.createdBy)).toEqual([actor, actor]);
      expect(
        (
          await q<{ by: string | null }>(
            `SELECT "createdByUserId" AS by FROM journal_entry WHERE id = $1`,
            [res.journalEntryId],
          )
        )[0]!.by,
      ).toBe(actor);
    });

    it('the conventional entry point refuses to run outside a tenant request (no context → no effect)', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const before = await snapshot();
      await expect(
        svc.completeAnonymousPayNowForBranchScoped({
          companyId: aed.companyId,
          branchId: aed.branchId,
          orderId: o.orderId,
          expectedVersion: o.version,
          paymentIntent: 'PAY_NOW',
          tenders: [cash(10_500n)],
          operationKey: 'op',
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await snapshot()).toEqual(before);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. state / version / customer gates and pre-issuance validation
  // ═════════════════════════════════════════════════════════════════════════════
  describe('order state gate and pre-issuance validation (nothing is numbered, nothing is written)', () => {
    it('HELD order → ORDER_INVALID_STATE_TRANSITION', async () => {
      const o = await mkOrder(aed, { ...one(10_000n), status: 'HELD' });
      await expectRejectedWithNoEffect(
        o,
        () => complete(o, [cash(10_500n)]),
        'ORDER_INVALID_STATE_TRANSITION',
      );
    });

    it('CANCELLED order → ORDER_INVALID_STATE_TRANSITION', async () => {
      const o = await mkOrder(aed, { ...one(10_000n), status: 'CANCELLED' });
      await expectRejectedWithNoEffect(
        o,
        () => complete(o, [cash(10_500n)]),
        'ORDER_INVALID_STATE_TRANSITION',
      );
    });

    it('an already-sold (CONFIRMED) order → ORDER_INVALID_STATE_TRANSITION, and the first sale is untouched', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await complete(o, [cash(10_500n)]);
      const before = await snapshot();
      const err = await complete(o, [cash(10_500n)]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('ORDER_INVALID_STATE_TRANSITION');
      expect((err as DomainError).status).toBe(409);
      expect(await snapshot()).toEqual(before);
    });

    it('the version gate precedes plan validation and every later step: a stale version AND a bad payment still answer ORDER_VERSION_CONFLICT, after ONE lock', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const events: TxEvent[] = [];
      const err = await asTenant((tx) =>
        svc.completeAnonymousPayNowInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, [cash(1n)], { expectedVersion: 7 }), // underpaid AND stale
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('ORDER_VERSION_CONFLICT');
      expect(lockTrace(events)).toEqual(['order:FOR UPDATE']);
    });

    it('a stale version → ORDER_VERSION_CONFLICT (checked before any financial write)', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await expectRejectedWithNoEffect(
        o,
        () => complete(o, [cash(10_500n)], { expectedVersion: 7 }),
        'ORDER_VERSION_CONFLICT',
      );
    });

    it('a customer-linked order → SALE_ORDER_CUSTOMER_LINKED (no fake customer, no anonymous credit)', async () => {
      const customerId = await makeCustomer(aed.companyId);
      const o = await mkOrder(aed, { ...one(10_000n), customerId });
      await expectRejectedWithNoEffect(
        o,
        () => complete(o, [cash(10_500n)]),
        'SALE_ORDER_CUSTOMER_LINKED',
      );
    });

    it('a non-WALK_IN order kind → SALE_ORDER_KIND_UNSUPPORTED', async () => {
      const o = await mkOrder(aed, { ...one(10_000n), kind: 'PICKUP' });
      await expectRejectedWithNoEffect(
        o,
        () => complete(o, [cash(10_500n)]),
        'SALE_ORDER_KIND_UNSUPPORTED',
      );
    });

    it('a missing expected version → ORDER_VERSION_REQUIRED (the optimistic version is mandatory)', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await expectRejectedWithNoEffect(
        o,
        () =>
          complete(o, [cash(10_500n)], {
            expectedVersion: undefined as unknown as number,
          }),
        'ORDER_VERSION_REQUIRED',
      );
    });

    it('a missing operation key → SALE_OPERATION_KEY_REQUIRED', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await expectRejectedWithNoEffect(
        o,
        () => complete(o, [cash(10_500n)], { operationKey: '  ' }),
        'SALE_OPERATION_KEY_REQUIRED',
      );
    });

    const cases: [
      string,
      () => Promise<OrderSpec>,
      AnonymousSaleTenderInput[],
      string,
      Partial<CompleteAnonymousPayNowInTxInput>?,
    ][] = [
      [
        'ON_CREDIT (anonymous credit)',
        async () => one(10_000n),
        [cash(5_000n)],
        'SALE_CREDIT_REQUIRES_CUSTOMER',
        { paymentIntent: 'ON_CREDIT' },
      ],
      [
        'an unknown intent',
        async () => one(10_000n),
        [cash(10_500n)],
        'SALE_INTENT_INVALID',
        { paymentIntent: 'BNPL' },
      ],
      [
        'ONLINE_GATEWAY (provider-backed)',
        async () => one(10_000n),
        [{ method: 'ONLINE_GATEWAY', amountMinor: 10_500n }],
        'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
      ],
      [
        'a provider-backed CARD_TERMINAL',
        async () => one(10_000n),
        [{ method: 'CARD_TERMINAL', amountMinor: 10_500n, providerCredentialId: randomUUID() }],
        'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
      ],
      [
        'CREDIT as a tender',
        async () => one(10_000n),
        [{ method: 'CREDIT', amountMinor: 10_500n }],
        'SALE_TENDER_METHOD_UNSUPPORTED',
      ],
      [
        'ADVANCE as a tender',
        async () => one(10_000n),
        [{ method: 'ADVANCE', amountMinor: 10_500n }],
        'SALE_TENDER_METHOD_UNSUPPORTED',
      ],
      ['underpayment', async () => one(10_000n), [cash(10_499n)], 'SALE_NOT_FULLY_RESOLVED'],
      ['no tender at all', async () => one(10_000n), [], 'SALE_NOT_FULLY_RESOLVED'],
      ['overpayment', async () => one(10_000n), [cash(10_501n)], 'SALE_OVERPAYMENT_NOT_ALLOWED'],
      [
        'a Multi Payment that overpays by one tender',
        async () => one(10_000n),
        [cash(10_500n), bank(1n)],
        'SALE_OVERPAYMENT_NOT_ALLOWED',
      ],
      [
        'a zero tender',
        async () => one(10_000n),
        [cash(10_500n), bank(0n)],
        'PAYMENT_INVALID_AMOUNT',
      ],
      [
        'a negative tender',
        async () => one(10_000n),
        [cash(10_500n), bank(-5n)],
        'PAYMENT_INVALID_AMOUNT',
      ],
      [
        'a tender in another currency',
        async () => one(10_000n),
        [{ method: 'CASH', amountMinor: 10_500n, currencyCode: 'KWD', currencyExponent: 3 }],
        'PAYMENT_CURRENCY_MISMATCH',
      ],
      [
        'a tender in another currency with the SAME exponent',
        async () => one(10_000n),
        [{ method: 'CASH', amountMinor: 10_500n, currencyCode: 'USD', currencyExponent: 2 }],
        'PAYMENT_CURRENCY_MISMATCH',
      ],
      [
        'a tender with the right currency but the wrong exponent',
        async () => one(10_000n),
        [{ method: 'CASH', amountMinor: 10_500n, currencyCode: 'AED', currencyExponent: 3 }],
        'PAYMENT_CURRENCY_MISMATCH',
      ],
      [
        'a ZERO-TOTAL sale (100% line discount)',
        async () => ({
          lines: [
            {
              quantity: '1.0000',
              unitPriceAmountMinor: 10_000n,
              discountAmountMinor: 10_000n,
              rateBps: 500,
            },
          ],
        }),
        [cash(1n)],
        'SALE_ZERO_TOTAL_NOT_SUPPORTED',
      ],
    ];
    it.each(cases)(
      '%s → %s, before any number is allocated',
      async (_label, mkSpec, tenders, code, over) => {
        const o = await mkOrder(aed, await mkSpec());
        await expectRejectedWithNoEffect(o, () => complete(o, tenders, over ?? {}), code);
      },
    );

    it('a client-supplied total is never trusted: the server total governs', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const forged = {
        ...saleInput(o, [cash(1n)]),
        totalAmountMinor: 1n,
      } as CompleteAnonymousPayNowInTxInput;
      await expectRejectedWithNoEffect(
        o,
        () => asTenant((tx) => svc.completeAnonymousPayNowInTx(tx, forged)),
        'SALE_NOT_FULLY_RESOLVED',
      );
    });

    it('a rejected request is rejected BEFORE any numbering or write: the trace holds only the order / line locks', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeAnonymousPayNowInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, [cash(100n)]),
        ),
      ).catch(() => undefined);
      expect(lockTrace(events)).toEqual([
        'order:FOR UPDATE',
        'order:FOR UPDATE',
        'order_line:FOR UPDATE',
      ]);
    });

    it('DB pin: a POS terminal is attribution bound to its OWN branch - an order can never reference another branch terminal (so the sale needs no check of its own)', async () => {
      await expect(
        mkOrder(aed, { ...one(10_000n), posTerminalId: aed.siblingTerminalId }),
      ).rejects.toThrow(/order_pos_tenant_company_branch_fkey/);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3. tenant / company / branch / POS isolation
  // ═════════════════════════════════════════════════════════════════════════════
  describe('tenant / company / branch isolation (non-disclosing, zero mutation)', () => {
    const attempt = async (
      o: MadeOrder,
      over: Partial<CompleteAnonymousPayNowInTxInput>,
      scopeTenant: string = tenantId,
    ) => {
      const before = await snapshot();
      const events: TxEvent[] = [];
      const err = await runScoped(prisma, { tenantId: scopeTenant }, (tx) =>
        svc.completeAnonymousPayNowInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, [cash(10_500n)], over),
        ),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      // the GATE itself matches nothing in a foreign scope: one lock attempt, then stop —
      // never relying on a later step's own predicate to refuse it
      expect(lockTrace(events)).toEqual(['order:FOR UPDATE']);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('ORDER_NOT_FOUND');
      expect((err as DomainError).status).toBe(404);
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
    };

    it("another tenant's session (RLS) cannot sell this order", async () => {
      const o = await mkOrder(aed, one(10_000n));
      await attempt(o, { tenantId: otherTenantId }, otherTenantId);
    });
    it("a foreign tenantId claimed inside this tenant's scope matches nothing", async () => {
      const o = await mkOrder(aed, one(10_000n));
      await attempt(o, { tenantId: otherTenantId });
    });
    it('another company of the SAME tenant matches nothing', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await attempt(o, { companyId: aed2.companyId });
    });
    it('a sibling branch of the same company matches nothing (branch is the isolation boundary)', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await attempt(o, { branchId: aed.siblingBranchId });
    });
    it('an unknown order id matches nothing', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await attempt(o, { orderId: randomUUID() });
    });
    it('the conventional entry point filters by the guarded branchId explicitly: a sibling branchId matches nothing', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const before = await snapshot();
      const ctx = new RequestContext({
        requestId: randomUUID(),
        tenantId,
        userId: actor,
        branchScope: 'ALL',
      });
      const err = await runWithContext(ctx, () =>
        svc.completeAnonymousPayNowForBranchScoped({
          companyId: aed.companyId,
          branchId: aed.siblingBranchId,
          orderId: o.orderId,
          expectedVersion: o.version,
          paymentIntent: 'PAY_NOW',
          tenders: [cash(10_500n)],
          operationKey: 'op',
        }),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('ORDER_NOT_FOUND');
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
    });
    it("the unrelated tenant's company is untouched by a successful sale elsewhere", async () => {
      const before = (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM document_number_counter WHERE "tenantId" = $1`,
          [otherTenantId],
        )
      )[0]!.n;
      const o = await mkOrder(aed, one(10_000n));
      await complete(o, [cash(10_500n)]);
      expect(
        (
          await q<{ n: number }>(
            `SELECT count(*)::int AS n FROM document_number_counter WHERE "tenantId" = $1`,
            [otherTenantId],
          )
        )[0]!.n,
      ).toBe(before);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 4. rollback / fault injection — zero surviving effect, then a clean retry
  // ═════════════════════════════════════════════════════════════════════════════
  describe('rollback + fault injection (real PostgreSQL)', () => {
    class FaultyFinalization extends TaxFinalizationService {
      failAt: 'prepare-start' | 'issue-start' | 'issue-end' | null = null;
      override async prepareFinalization(
        ...args: Parameters<TaxFinalizationService['prepareFinalization']>
      ): ReturnType<TaxFinalizationService['prepareFinalization']> {
        if (this.failAt === 'prepare-start') throw new InjectedFault('before-canonical-validation');
        return super.prepareFinalization(...args);
      }
      override async issuePrepared(
        ...args: Parameters<TaxFinalizationService['issuePrepared']>
      ): ReturnType<TaxFinalizationService['issuePrepared']> {
        if (this.failAt === 'issue-start') throw new InjectedFault('before-issuance');
        const r = await super.issuePrepared(...args);
        if (this.failAt === 'issue-end') throw new InjectedFault('after-issuance');
        return r;
      }
    }
    class FaultyCollection extends PaymentCollectionRepository {
      failAfter = false;
      override async captureSynchronousTendersInTx(
        ...args: Parameters<PaymentCollectionRepository['captureSynchronousTendersInTx']>
      ): ReturnType<PaymentCollectionRepository['captureSynchronousTendersInTx']> {
        const r = await super.captureSynchronousTendersInTx(...args);
        if (this.failAfter) throw new InjectedFault('after-all-payments');
        return r;
      }
    }
    class FaultyJournal extends WalkInSaleJournalRepository {
      failAfter = false;
      override async postWalkInSaleJournalInTx(
        ...args: Parameters<WalkInSaleJournalRepository['postWalkInSaleJournalInTx']>
      ): ReturnType<WalkInSaleJournalRepository['postWalkInSaleJournalInTx']> {
        const r = await super.postWalkInSaleJournalInTx(...args);
        if (this.failAfter) throw new InjectedFault('after-journal');
        return r;
      }
    }

    let faultyFinalization: FaultyFinalization;
    let faultyCollection: FaultyCollection;
    let faultyJournal: FaultyJournal;
    let faultySvc: AtomicWalkInSaleService;
    beforeAll(() => {
      faultyFinalization = new FaultyFinalization(issuance);
      faultyCollection = new FaultyCollection(
        audit,
        outbox,
        new PaymentCustomerAttributionRepository(),
        new CustomerReceiptEffectsRepository(engine, audit),
      );
      faultyJournal = new FaultyJournal(engine, companyConfig);
      faultySvc = newSvc(db, faultyFinalization, faultyCollection, faultyJournal);
    });
    const reset = (): void => {
      faultyFinalization.failAt = null;
      faultyCollection.failAfter = false;
      faultyJournal.failAfter = false;
    };

    /** run `go`, require the injected fault, prove NOTHING survived and the retry is clean + gapless */
    async function faultThenRetry(
      co: Co,
      spec: OrderSpec,
      tenders: AnonymousSaleTenderInput[],
      go: (o: MadeOrder) => Promise<unknown>,
      expectCode: string | RegExp,
    ): Promise<void> {
      const o = await mkOrder(co, spec);
      const before = await snapshot();
      const expected = await nextNumbers(co);
      const err = await go(o).then(
        () => {
          throw new Error('the fault was not raised');
        },
        (e: unknown) => e,
      );
      if (typeof expectCode === 'string') {
        expect((err as { code?: string }).code, String(err)).toBe(expectCode);
      } else {
        expect(String((err as Error).message), String(err)).toMatch(expectCode);
      }
      // ZERO surviving economic effect
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
      expect(
        (
          await q<{ status: string; version: number; n: string | null }>(
            `SELECT status, version, "orderNumber" AS n FROM "order" WHERE id = $1`,
            [o.orderId],
          )
        )[0],
      ).toEqual({ status: 'DRAFT', version: 1, n: null });
      // the retry succeeds cleanly and receives the NEXT gapless numbers
      reset();
      const res = await complete(o, tenders);
      expect(res.invoiceNumber).toBe(expected.invoice);
      expect(res.orderNumber).toBe(expected.order);
      expect((await journalsOf(res.invoiceId)).map((j) => j.sourceKind)).toEqual(['walk_in_sale']);
    }

    const sale = (o: MadeOrder, tenders: AnonymousSaleTenderInput[]) =>
      complete(o, tenders, {}, faultySvc);

    it('A. before canonical validation (after the order lock)', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(10_500n)],
        (o) => {
          faultyFinalization.failAt = 'prepare-start';
          return sale(o, [cash(10_500n)]);
        },
        /INJECTED_FAULT:before-canonical-validation/,
      );
    });
    it('B. after a valid plan but before invoice issuance', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(10_500n)],
        (o) => {
          faultyFinalization.failAt = 'issue-start';
          return sale(o, [cash(10_500n)]);
        },
        /INJECTED_FAULT:before-issuance/,
      );
    });
    it('C. immediately after invoice issuance', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(10_500n)],
        (o) => {
          faultyFinalization.failAt = 'issue-end';
          return sale(o, [cash(10_500n)]);
        },
        /INJECTED_FAULT:after-issuance/,
      );
    });
    it('D. after the FIRST tender of a Multi Payment (second PaymentAttempt insert faults)', async () => {
      const tenders = [cash(4_000n), bank(3_000n), card(3_500n)];
      await faultThenRetry(
        aed,
        one(10_000n),
        tenders,
        (o) => {
          let attempts = 0;
          return asTenant((tx) =>
            svc.completeAnonymousPayNowInTx(
              observe(tx, (e) => {
                if (e.kind === 'sql' && /INSERT INTO "payment_attempt"/.test(e.text)) {
                  attempts += 1;
                  if (attempts === 2) throw new InjectedFault('second-tender');
                }
              }),
              saleInput(o, tenders),
            ),
          );
        },
        /INJECTED_FAULT:second-tender/,
      );
    });
    it('E. after ALL payments / allocations', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(5_000n), bank(5_500n)],
        (o) => {
          faultyCollection.failAfter = true;
          return sale(o, [cash(5_000n), bank(5_500n)]);
        },
        /INJECTED_FAULT:after-all-payments/,
      );
    });
    it('F1. during walk-in journal posting — before the lines are written', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(10_500n)],
        (o) =>
          asTenant((tx) =>
            svc.completeAnonymousPayNowInTx(
              observe(tx, (e) => {
                if (e.kind === 'model' && e.name === 'journalLine.createMany')
                  throw new InjectedFault('journal-lines');
              }),
              saleInput(o, [cash(10_500n)]),
            ),
          ),
        /INJECTED_FAULT:journal-lines/,
      );
    });
    it('F2. during walk-in journal posting — at sealing', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(10_500n)],
        (o) =>
          asTenant((tx) =>
            svc.completeAnonymousPayNowInTx(
              observe(tx, (e) => {
                if (e.kind === 'sql' && /UPDATE "journal_entry" SET "sealedAt"/.test(e.text))
                  throw new InjectedFault('journal-seal');
              }),
              saleInput(o, [cash(10_500n)]),
            ),
          ),
        /INJECTED_FAULT:journal-seal/,
      );
    });
    it('G1. immediately after journal posting, inside the orchestrator', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(10_500n)],
        (o) => {
          faultyJournal.failAfter = true;
          return sale(o, [cash(10_500n)]);
        },
        /INJECTED_FAULT:after-journal/,
      );
    });
    it('G2. after the whole sale returned, before the OUTER commit (caller failure)', async () => {
      await faultThenRetry(
        aed,
        one(10_000n),
        [cash(10_500n)],
        (o) =>
          asTenant(async (tx) => {
            await svc.completeAnonymousPayNowInTx(tx, saleInput(o, [cash(10_500n)]));
            // every effect is visible INSIDE this transaction…
            expect(await tx.invoice.count({ where: { orderId: o.orderId } })).toBe(1);
            throw new InjectedFault('before-outer-commit');
          }),
        /INJECTED_FAULT:before-outer-commit/,
      );
    });
    it('H1. accounting period CLOSED → ACCOUNTING_PERIOD_CLOSED after issuance + capture; everything rolls back', async () => {
      const o = await mkOrder(closed, one(10_000n));
      const before = await snapshot();
      const err = await complete(o, [cash(10_500n)]).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('ACCOUNTING_PERIOD_CLOSED');
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
      // the retry fails identically — and still burns nothing
      const err2 = await complete(o, [cash(10_500n)]).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err2 as DomainError).code).toBe('ACCOUNTING_PERIOD_CLOSED');
      expect(await snapshot()).toEqual(before);
    });
    it('H2. NO accounting period → NO_OPEN_ACCOUNTING_PERIOD; once a period exists the SAME order sells with the first gapless numbers', async () => {
      const o = await mkOrder(noPeriod, one(10_000n));
      const before = await snapshot();
      const err = await complete(o, [cash(10_500n)]).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as DomainError).code).toBe('NO_OPEN_ACCOUNTING_PERIOD');
      expect(await snapshot()).toEqual(before);
      await asTenant((tx) =>
        periods.create(tx, {
          tenantId,
          companyId: noPeriod.companyId,
          startDate: new Date('2026-06-01T00:00:00Z'),
          endDate: new Date('2026-06-30T00:00:00Z'),
        }),
      );
      const res = await complete(o, [cash(10_500n)]);
      expect(res.invoiceNumber).toBe('INV-000001');
      expect(res.orderNumber).toBe('ORD-000001');
    });

    const auditFaults: [string, (e: TxEvent) => boolean][] = [
      ['audit order.confirmed', (e) => auditAction(e) === 'order.confirmed'],
      ['audit invoice.issued', (e) => auditAction(e) === 'invoice.issued'],
      [
        'audit payment_attempt.state_changed',
        (e) => auditAction(e) === 'payment_attempt.state_changed',
      ],
      ['audit payment.recorded', (e) => auditAction(e) === 'payment.recorded'],
      ['audit accounting.journal_posted', (e) => auditAction(e) === 'accounting.journal_posted'],
      [
        'outbox payments.attempt_state_changed',
        (e) => outboxType(e) === 'payments.attempt_state_changed',
      ],
      ['outbox payments.payment_recorded', (e) => outboxType(e) === 'payments.payment_recorded'],
    ];
    const auditAction = (e: TxEvent): string | undefined =>
      e.kind === 'model' && e.name === 'auditLog.create'
        ? (e.args[0] as { data?: { action?: string } } | undefined)?.data?.action
        : undefined;
    const outboxType = (e: TxEvent): string | undefined =>
      e.kind === 'model' && e.name === 'outbox.create'
        ? (e.args[0] as { data?: { eventType?: string } } | undefined)?.data?.eventType
        : undefined;

    it.each(auditFaults)(
      'I. a failing %s (written by a reused primitive) rolls the whole sale back',
      async (label, hit) => {
        await faultThenRetry(
          aed,
          one(10_000n),
          [cash(10_500n)],
          (o) =>
            asTenant((tx) =>
              svc.completeAnonymousPayNowInTx(
                observe(tx, (e) => {
                  if (hit(e)) throw new InjectedFault(label);
                }),
                saleInput(o, [cash(10_500n)]),
              ),
            ),
          new RegExp(`INJECTED_FAULT:${label.replace(/[.]/g, '\\.')}`),
        );
      },
    );
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 4b. the orchestrator's own invariants over what its collaborators return
  // ═════════════════════════════════════════════════════════════════════════════
  describe("orchestrator invariants (a frozen collaborator's OUTPUT is doctored; the whole sale must roll back)", () => {
    async function expectInvariantRollback(
      service: AtomicWalkInSaleService,
      code: string,
      tenders: AnonymousSaleTenderInput[] = [cash(10_500n)],
    ): Promise<void> {
      const o = await mkOrder(aed, one(10_000n));
      const before = await snapshot();
      const err = await complete(o, tenders, {}, service).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, String(err)).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(code);
      expect((err as DomainError).status).toBe(500);
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
    }

    it('issuance that returns a customer receivable for an anonymous order → SALE_ANONYMOUS_INVARIANT_VIOLATED', async () => {
      class ReceivableFinalization extends TaxFinalizationService {
        override async issuePrepared(
          ...args: Parameters<TaxFinalizationService['issuePrepared']>
        ): ReturnType<TaxFinalizationService['issuePrepared']> {
          const r = await super.issuePrepared(...args);
          return { ...r, customerReceivableId: randomUUID() };
        }
      }
      await expectInvariantRollback(
        newSvc(db, new ReceivableFinalization(issuance), collection, walkInJournal),
        'SALE_ANONYMOUS_INVARIANT_VIOLATED',
      );
    });

    it('a capture that leaves something to collect → SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED', async () => {
      class ShortCollection extends PaymentCollectionRepository {
        override async captureSynchronousTendersInTx(
          ...args: Parameters<PaymentCollectionRepository['captureSynchronousTendersInTx']>
        ): ReturnType<PaymentCollectionRepository['captureSynchronousTendersInTx']> {
          const r = await super.captureSynchronousTendersInTx(...args);
          return { ...r, remainingAvailableToCollectMinor: 1n };
        }
      }
      await expectInvariantRollback(
        newSvc(
          db,
          finalization,
          new ShortCollection(
            audit,
            outbox,
            new PaymentCustomerAttributionRepository(),
            new CustomerReceiptEffectsRepository(engine, audit),
          ),
          walkInJournal,
        ),
        'SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED',
      );
    });

    it('a capture that UNDER-allocates yet reports full coverage and a PAID status → SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED (the independent outstanding-balance check)', async () => {
      class UnderAllocatingCollection extends PaymentCollectionRepository {
        override async captureSynchronousTendersInTx(
          ...args: Parameters<PaymentCollectionRepository['captureSynchronousTendersInTx']>
        ): ReturnType<PaymentCollectionRepository['captureSynchronousTendersInTx']> {
          const [tx, input] = args;
          const first = input.tenders[0]!;
          const r = await super.captureSynchronousTendersInTx(tx, {
            ...input,
            amountMinor: first.amountMinor,
            tenders: [first],
          });
          await tx.$executeRaw`UPDATE "invoice" SET "invoicePaymentStatus" = 'PAID' WHERE "id" = ${r.invoiceId}::uuid`;
          return { ...r, remainingAvailableToCollectMinor: 0n };
        }
      }
      await expectInvariantRollback(
        newSvc(
          db,
          finalization,
          new UnderAllocatingCollection(
            audit,
            outbox,
            new PaymentCustomerAttributionRepository(),
            new CustomerReceiptEffectsRepository(engine, audit),
          ),
          walkInJournal,
        ),
        'SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED',
        [cash(5_000n), bank(5_500n)],
      );
    });

    it('an invoice whose derived payment status is not PAID / SETTLED → SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED', async () => {
      class UnpaidCollection extends PaymentCollectionRepository {
        override async captureSynchronousTendersInTx(
          ...args: Parameters<PaymentCollectionRepository['captureSynchronousTendersInTx']>
        ): ReturnType<PaymentCollectionRepository['captureSynchronousTendersInTx']> {
          const r = await super.captureSynchronousTendersInTx(...args);
          await args[0]
            .$executeRaw`UPDATE "invoice" SET "invoicePaymentStatus" = 'PARTIAL' WHERE "id" = ${r.invoiceId}::uuid`;
          return r;
        }
      }
      await expectInvariantRollback(
        newSvc(
          db,
          finalization,
          new UnpaidCollection(
            audit,
            outbox,
            new PaymentCustomerAttributionRepository(),
            new CustomerReceiptEffectsRepository(engine, audit),
          ),
          walkInJournal,
        ),
        'SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED',
      );
    });

    it('a walk-in journal that reports a replay for a brand-new invoice → SALE_ANONYMOUS_INVARIANT_VIOLATED', async () => {
      class ReplayJournal extends WalkInSaleJournalRepository {
        override async postWalkInSaleJournalInTx(
          ...args: Parameters<WalkInSaleJournalRepository['postWalkInSaleJournalInTx']>
        ): ReturnType<WalkInSaleJournalRepository['postWalkInSaleJournalInTx']> {
          const r = await super.postWalkInSaleJournalInTx(...args);
          return { ...r, created: false };
        }
      }
      await expectInvariantRollback(
        newSvc(db, finalization, collection, new ReplayJournal(engine, companyConfig)),
        'SALE_ANONYMOUS_INVARIANT_VIOLATED',
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5. numbering — gapless, never burned, no MAX()+1
  // ═════════════════════════════════════════════════════════════════════════════
  describe('numbering', () => {
    it('an invalid plan, a late rollback and several faults burn NO number; the next sales receive the next gapless numbers', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const start = await nextNumbers(co);
      expect(start).toEqual({ order: 'ORD-000001', invoice: 'INV-000001' });

      const bad = await mkOrder(co, one(10_000n));
      await complete(bad, [cash(1n)]).catch(() => undefined); // underpayment: invalid plan
      await asTenant(async (tx) => {
        await svc.completeAnonymousPayNowInTx(tx, saleInput(bad, [cash(10_500n)]));
        throw new InjectedFault('late-rollback');
      }).catch(() => undefined);
      expect(await nextNumbers(co)).toEqual(start);
      expect(
        (
          await q<{ n: number }>(
            `SELECT count(*)::int AS n FROM document_number_counter WHERE "companyId" = $1`,
            [co.companyId],
          )
        )[0]!.n,
      ).toBe(0);

      const r1 = await complete(bad, [cash(10_500n)]);
      const second = await mkOrder(co, one(10_000n));
      const r2 = await complete(second, [bank(10_500n)]);
      expect([r1.invoiceNumber, r2.invoiceNumber]).toEqual(['INV-000001', 'INV-000002']);
      expect([r1.orderNumber, r2.orderNumber]).toEqual(['ORD-000001', 'ORD-000002']);
    });

    it('numbers are per company: a second company starts at 1 and is unaffected', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const o = await mkOrder(co, one(10_000n));
      const res = await complete(o, [cash(10_500n)]);
      expect(res.invoiceNumber).toBe('INV-000001');
    });

    it('no MAX()+1 and no SEQUENCE exists in the composed flow (the counter upsert is the only allocator)', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const o = await mkOrder(co, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeAnonymousPayNowInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, [cash(10_500n)]),
        ),
      );
      const sqls = events
        .filter((e): e is Extract<TxEvent, { kind: 'sql' }> => e.kind === 'sql')
        .map((e) => e.text);
      expect(sqls.filter((t) => /nextval\s*\(|\bMAX\s*\(/i.test(t) && /number/i.test(t))).toEqual(
        [],
      );
      expect(sqls.filter((t) => /INSERT INTO "document_number_counter"/.test(t))).toHaveLength(2);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 6. concurrency — duplicate finalize, cancel-vs-complete, different orders
  // ═════════════════════════════════════════════════════════════════════════════
  describe('concurrency (real PostgreSQL)', () => {
    const settle = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);
    const noDeadlock = (rejections: PromiseRejectedResult[]): void => {
      for (const r of rejections) {
        const msg = String((r.reason as Error)?.message ?? r.reason);
        expect(msg).not.toMatch(/40P01|deadlock/i);
        // a clean DOMAIN conflict, never a raw driver / 500
        expect(r.reason).toBeInstanceOf(DomainError);
      }
    };

    it('two concurrent completions of the SAME DRAFT order: exactly one sale; the loser is a clean domain conflict', async () => {
      for (let round = 0; round < 4; round += 1) {
        const o = await mkOrder(aed, one(10_000n));
        const settled = await settle([complete(o, [cash(10_500n)]), complete(o, [bank(10_500n)])]);
        const ok = settled.filter(
          (s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof complete>>> =>
            s.status === 'fulfilled',
        );
        const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(1);
        noDeadlock(bad);
        const err = bad[0]!.reason as DomainError;
        expect(['ORDER_INVALID_STATE_TRANSITION', 'ORDER_VERSION_CONFLICT']).toContain(err.code);
        expect(err.status).toBe(409);
        // exactly ONE economic sale
        const inv = (await invoiceOf(o.orderId))!;
        expect(inv).not.toBeNull();
        expect(
          (
            await q<{ n: number }>(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
              o.orderId,
            ])
          )[0]!.n,
        ).toBe(1);
        const pays = await paymentsOf(inv.id);
        expect(pays).toHaveLength(1);
        expect(pays[0]!.method).toBe(ok[0]!.value.payments[0]!.method);
        const journals = await journalsOf(inv.id);
        expect(journals).toHaveLength(1);
        expect((await linesOf(journals[0]!.id))[0]).toBe(
          pays[0]!.method === 'CASH' ? 'Dr ASSET.CASH_ON_HAND 10500' : 'Dr ASSET.BANK 10500',
        );
      }
    }, 120_000);

    it('eight concurrent completions of the SAME order: one sale, seven clean conflicts, no 40P01', async () => {
      for (let round = 0; round < 2; round += 1) {
        const o = await mkOrder(aed, one(10_000n));
        const settled = await settle(
          Array.from({ length: 8 }, (_, i) =>
            complete(o, i % 2 === 0 ? [cash(10_500n)] : [cash(5_000n), bank(5_500n)]),
          ),
        );
        const ok = settled.filter((s) => s.status === 'fulfilled');
        const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(7);
        noDeadlock(bad);
        const inv = (await invoiceOf(o.orderId))!;
        const pays = await paymentsOf(inv.id);
        expect(pays.reduce((a, p) => a + p.amount, 0n)).toBe(inv.total);
        expect(await journalsOf(inv.id)).toHaveLength(1);
        // the orchestrator's own number allocation produced exactly one invoice number
        expect(
          (
            await q<{ n: number }>(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
              o.orderId,
            ])
          )[0]!.n,
        ).toBe(1);
      }
    }, 180_000);

    it('CANCEL vs COMPLETE — cancel first: the order is cancelled and the completion fails with no invoice / payment / journal', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const ctx = new RequestContext({ requestId: randomUUID(), tenantId, userId: actor });
      const cancelled = await runWithContext(ctx, () =>
        orderRepo.cancelForBranchScoped({
          companyId: aed.companyId,
          branchId: aed.branchId,
          orderId: o.orderId,
          expectedVersion: 1,
          reason: 'changed my mind',
        }),
      );
      expect(cancelled.status).toBe('CANCELLED');
      await expectRejectedWithNoEffect(
        o,
        () => complete(o, [cash(10_500n)]),
        'ORDER_INVALID_STATE_TRANSITION',
      );
    });

    it('CANCEL vs COMPLETE — completion holds the order lock: the cancel WAITS, then fails; the paid anonymous sale remains intact (RB-1 still open)', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const ctx = new RequestContext({ requestId: randomUUID(), tenantId, userId: actor });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let sold!: () => void;
      const soldSignal = new Promise<void>((r) => {
        sold = r;
      });
      const completing = asTenant(async (tx) => {
        await svc.completeAnonymousPayNowInTx(tx, saleInput(o, [cash(10_500n)]));
        sold();
        await gate; // hold every lock (order / invoice / counters / GL) until released
      });
      await soldSignal;
      let cancelSettled = false;
      const cancelling = runWithContext(ctx, () =>
        orderRepo.cancelForBranchScoped({
          companyId: aed.companyId,
          branchId: aed.branchId,
          orderId: o.orderId,
          expectedVersion: 1,
          reason: 'racing',
        }),
      ).finally(() => {
        cancelSettled = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(cancelSettled).toBe(false); // really blocked on the order lock
      release();
      await completing;
      const err = await cancelling.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DomainError);
      expect([
        'ORDER_VERSION_CONFLICT',
        'ORDER_INVALID_STATE_TRANSITION',
        'WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE',
      ]).toContain((err as DomainError).code);
      const inv = (await invoiceOf(o.orderId))!;
      expect(inv).not.toBeNull();
      expect(
        (await q<{ status: string }>(`SELECT status FROM "order" WHERE id = $1`, [o.orderId]))[0]!
          .status,
      ).toBe('CONFIRMED');
      expect(await paymentsOf(inv.id)).toHaveLength(1);
      expect((await journalsOf(inv.id)).map((j) => j.sourceKind)).toEqual(['walk_in_sale']);
      expect(await q(`SELECT 1 FROM credit_note WHERE "invoiceId" = $1`, [inv.id])).toEqual([]);
    }, 60_000);

    it('after the sale, cancelling with the CORRECT version is refused by the frozen 3b.8 anonymous-issued restriction', async () => {
      const o = await mkOrder(aed, one(10_000n));
      await complete(o, [cash(10_500n)]);
      const ctx = new RequestContext({ requestId: randomUUID(), tenantId, userId: actor });
      const err = await runWithContext(ctx, () =>
        orderRepo.cancelForBranchScoped({
          companyId: aed.companyId,
          branchId: aed.branchId,
          orderId: o.orderId,
          expectedVersion: 2,
          reason: 'too late',
        }),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE');
      expect((err as DomainError).status).toBe(422);
    });

    it('CANCEL vs COMPLETE — free race, many rounds: only the two allowed outcomes ever occur', async () => {
      const ctx = new RequestContext({ requestId: randomUUID(), tenantId, userId: actor });
      const outcomes = { cancelWon: 0, completeWon: 0 };
      for (let round = 0; round < 12; round += 1) {
        const o = await mkOrder(aed, one(10_000n));
        const cancel = () =>
          runWithContext(ctx, () =>
            orderRepo.cancelForBranchScoped({
              companyId: aed.companyId,
              branchId: aed.branchId,
              orderId: o.orderId,
              expectedVersion: 1,
              reason: 'race',
            }),
          );
        const pair: Promise<unknown>[] =
          round % 2 === 0
            ? [cancel(), complete(o, [cash(10_500n)])]
            : [complete(o, [cash(10_500n)]), cancel()];
        const settled = await settle(pair);
        for (const s of settled) {
          if (s.status === 'rejected') {
            expect(s.reason).toBeInstanceOf(DomainError);
            expect(String((s.reason as Error).message)).not.toMatch(/40P01|deadlock/i);
          }
        }
        const order = (
          await q<{ status: string }>(`SELECT status FROM "order" WHERE id = $1`, [o.orderId])
        )[0]!.status;
        const inv = await invoiceOf(o.orderId);
        const pays = inv ? await paymentsOf(inv.id) : [];
        const journals = inv ? await journalsOf(inv.id) : [];
        if (order === 'CANCELLED') {
          // A — cancel won: nothing financial may exist
          expect(inv).toBeNull();
          expect(pays).toEqual([]);
          expect(journals).toEqual([]);
          outcomes.cancelWon += 1;
        } else {
          // B — completion won: a whole, paid anonymous sale
          expect(order).toBe('CONFIRMED');
          expect(inv).not.toBeNull();
          expect(pays).toHaveLength(1);
          expect(journals.map((j) => j.sourceKind)).toEqual(['walk_in_sale']);
          expect(await q(`SELECT 1 FROM credit_note WHERE "invoiceId" = $1`, [inv!.id])).toEqual(
            [],
          );
          outcomes.completeWon += 1;
        }
        // exactly one side won
        expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      }
      expect(outcomes.cancelWon + outcomes.completeWon).toBe(12);
    }, 180_000);

    // ── different-order concurrency ─────────────────────────────────────────────
    async function runBatch(
      jobs: { co: Co; branchId: string; tenders: AnonymousSaleTenderInput[] }[],
    ): Promise<{
      results: Awaited<ReturnType<typeof complete>>[];
      wallMs: number;
      holdMs: number[];
    }> {
      const orders: MadeOrder[] = [];
      for (const j of jobs) orders.push(await mkOrder(j.co, one(10_000n), j.branchId));
      const holdMs: number[] = [];
      const t0 = performance.now();
      const settled = await Promise.allSettled(
        jobs.map(async (j, i) => {
          let tCounter = 0;
          const out = await runScoped(prisma, { tenantId }, async (tx) => {
            const r = await svc.completeAnonymousPayNowInTx(
              observe(tx, (e) => {
                if (
                  tCounter === 0 &&
                  e.kind === 'sql' &&
                  /INSERT INTO "document_number_counter"/.test(e.text)
                ) {
                  tCounter = performance.now();
                }
              }),
              saleInput(orders[i]!, j.tenders),
            );
            return r;
          });
          holdMs.push(performance.now() - tCounter);
          return out;
        }),
      );
      const wallMs = performance.now() - t0;
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(rejected.map((r) => String(r.reason))).toEqual([]);
      return {
        results: settled.map(
          (s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof complete>>>).value,
        ),
        wallMs,
        holdMs,
      };
    }

    const contiguous = (numbers: string[]): boolean => {
      const ns = numbers.map((n) => Number(n.split('-')[1])).sort((a, b) => a - b);
      return ns.every((n, i) => i === 0 || n === ns[i - 1]! + 1);
    };

    async function expectOwnState(
      results: Awaited<ReturnType<typeof complete>>[],
      expectedBranch: (i: number) => { companyId: string; branchId: string },
    ): Promise<void> {
      for (const [i, r] of results.entries()) {
        const want = expectedBranch(i);
        const inv = (
          await q<{ branchId: string; companyId: string; orderId: string }>(
            `SELECT "branchId","companyId","orderId" FROM invoice WHERE id = $1`,
            [r.invoiceId],
          )
        )[0]!;
        expect([inv.companyId, inv.branchId]).toEqual([want.companyId, want.branchId]);
        const pays = await paymentsOf(r.invoiceId);
        expect(pays.map((p) => p.branchId)).toEqual(pays.map(() => want.branchId));
        expect(pays.reduce((a, p) => a + p.amount, 0n)).toBe(r.totalAmountMinor);
        const journals = await journalsOf(r.invoiceId);
        expect(journals).toHaveLength(1);
        expect(journals[0]!.id).toBe(r.journalEntryId);
        const dims = await lineDimensions(r.journalEntryId);
        expect(dims.map((d) => d.branchId)).toEqual([want.branchId]);
      }
    }

    it('different orders, SAME company + SAME branch (12 at once): distinct gapless numbers, no 40P01, each journal/payment on its own invoice', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const jobs = Array.from({ length: 12 }, (_, i) => ({
        co,
        branchId: co.branchId,
        tenders: i % 3 === 0 ? [cash(5_000n), bank(5_500n)] : [cash(10_500n)],
      }));
      const { results } = await runBatch(jobs);
      expect(new Set(results.map((r) => r.invoiceNumber)).size).toBe(12);
      expect(new Set(results.map((r) => r.orderNumber)).size).toBe(12);
      expect(contiguous(results.map((r) => r.invoiceNumber))).toBe(true);
      expect(contiguous(results.map((r) => r.orderNumber))).toBe(true);
      expect(results.map((r) => r.invoiceNumber).sort()[0]).toBe('INV-000001');
      await expectOwnState(results, () => ({ companyId: co.companyId, branchId: co.branchId }));
    }, 180_000);

    it('different orders, SAME company, DIFFERENT branches (2 × 5): no cross-branch state', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const jobs = Array.from({ length: 10 }, (_, i) => ({
        co,
        branchId: i % 2 === 0 ? co.branchId : co.siblingBranchId,
        tenders: [cash(10_500n)],
      }));
      const { results } = await runBatch(jobs);
      expect(contiguous(results.map((r) => r.invoiceNumber))).toBe(true);
      await expectOwnState(results, (i) => ({
        companyId: co.companyId,
        branchId: i % 2 === 0 ? co.branchId : co.siblingBranchId,
      }));
    }, 180_000);

    it('different orders in DIFFERENT companies (3 × 4): per-company numbering, no cross-company state', async () => {
      const cos = [
        await makeCompany(tenantId, { currency: 'AED', period: 'open' }),
        await makeCompany(tenantId, { currency: 'AED', period: 'open' }),
        await makeCompany(tenantId, { currency: 'KWD', period: 'open', tz: 'Asia/Kuwait' }),
      ];
      const jobs = Array.from({ length: 12 }, (_, i) => {
        const co = cos[i % 3]!;
        return {
          co,
          branchId: co.branchId,
          tenders: [co.currency === 'KWD' ? cash(10_500n) : bank(10_500n)],
        };
      });
      const { results } = await runBatch(jobs);
      for (const co of cos) {
        const mine = results.filter((_, i) => jobs[i]!.co === co);
        expect(mine).toHaveLength(4);
        expect(mine.map((r) => r.invoiceNumber).sort()).toEqual([
          'INV-000001',
          'INV-000002',
          'INV-000003',
          'INV-000004',
        ]);
        expect(mine.map((r) => r.orderNumber).sort()).toEqual([
          'ORD-000001',
          'ORD-000002',
          'ORD-000003',
          'ORD-000004',
        ]);
      }
      await expectOwnState(results, (i) => ({
        companyId: jobs[i]!.co.companyId,
        branchId: jobs[i]!.co.branchId,
      }));
    }, 180_000);

    it('MEASURE the company document-counter lock: one company serialises, many companies do not (correctness-only serialisation)', async () => {
      const sequentialCo = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const N = 16;
      // sequential baseline (one sale at a time)
      const seqMs: number[] = [];
      const seqHoldMs: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const o = await mkOrder(sequentialCo, one(10_000n));
        const t0 = performance.now();
        let tCounter = 0;
        await runScoped(prisma, { tenantId }, (tx) =>
          svc.completeAnonymousPayNowInTx(
            observe(tx, (e) => {
              if (
                tCounter === 0 &&
                e.kind === 'sql' &&
                /INSERT INTO "document_number_counter"/.test(e.text)
              ) {
                tCounter = performance.now();
              }
            }),
            saleInput(o, [cash(10_500n)]),
          ),
        );
        const t1 = performance.now();
        seqMs.push(t1 - t0);
        seqHoldMs.push(t1 - tCounter); // counter allocation -> commit, UNCONTENDED
      }
      // N concurrent sales of ONE company
      const sameCo = await makeCompany(tenantId, { currency: 'AED', period: 'open' });
      const same = await runBatch(
        Array.from({ length: N }, () => ({
          co: sameCo,
          branchId: sameCo.branchId,
          tenders: [cash(10_500n)],
        })),
      );
      // N concurrent sales spread over 4 companies
      const four = await Promise.all(
        Array.from({ length: 4 }, () => makeCompany(tenantId, { currency: 'AED', period: 'open' })),
      );
      const spread = await runBatch(
        Array.from({ length: N }, (_, i) => ({
          co: four[i % 4]!,
          branchId: four[i % 4]!.branchId,
          tenders: [cash(10_500n)],
        })),
      );
      const pct = (xs: number[], p: number): number => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
      };
      const med = (xs: number[]): number => pct(xs, 50);
      const metrics = {
        sequentialPerSaleMedianMs: Math.round(med(seqMs)),
        sequentialCounterHoldMedianMs: Math.round(med(seqHoldMs)),
        concurrentSameCompany: {
          n: N,
          wallMs: Math.round(same.wallMs),
          holdMedianMs: Math.round(med(same.holdMs)),
          holdP95Ms: Math.round(pct(same.holdMs, 95)),
        },
        concurrentFourCompanies: {
          n: N,
          wallMs: Math.round(spread.wallMs),
          holdMedianMs: Math.round(med(spread.holdMs)),
          holdP95Ms: Math.round(pct(spread.holdMs, 95)),
        },
        impliedMaxSalesPerSecondPerCompany: Math.round(1000 / Math.max(1, med(seqHoldMs))),
      };
      const out = process.env['SALE_METRICS_FILE'];
      if (out) writeFileSync(out, JSON.stringify(metrics, null, 2));
      // correctness is the assertion; performance is MEASURED, not gated
      expect(contiguous(same.results.map((r) => r.invoiceNumber))).toBe(true);
      expect(new Set(same.results.map((r) => r.invoiceNumber)).size).toBe(N);
      expect(
        contiguous(spread.results.filter((_, i) => i % 4 === 0).map((r) => r.invoiceNumber)),
      ).toBe(true);
    }, 240_000);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 7. audit / outbox boundary
  // ═════════════════════════════════════════════════════════════════════════════
  describe('audit / outbox boundary', () => {
    it("a single-tender sale keeps exactly the frozen primitives' audit + payments.* outbox rows, in the same transaction — and NO orders.sale_completed", async () => {
      const o = await mkOrder(aed, one(10_000n));
      const base = await auditBaseline();
      await complete(o, [cash(10_500n)]);
      expect(await auditDelta(base)).toEqual({
        'audit:order.confirmed': 1,
        'audit:invoice.issued': 1,
        'audit:payment_attempt.state_changed': 1,
        'audit:payment.recorded': 1,
        'audit:accounting.journal_posted': 1,
        'outbox:payments.attempt_state_changed': 1,
        'outbox:payments.payment_recorded': 1,
      });
    });

    it('a Multi Payment keeps one pair per tender and still exactly one journal / order / invoice audit', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const base = await auditBaseline();
      await complete(o, [cash(4_000n), bank(3_000n), card(3_500n)]);
      expect(await auditDelta(base)).toEqual({
        'audit:order.confirmed': 1,
        'audit:invoice.issued': 1,
        'audit:payment_attempt.state_changed': 3,
        'audit:payment.recorded': 3,
        'audit:accounting.journal_posted': 1,
        'outbox:payments.attempt_state_changed': 3,
        'outbox:payments.payment_recorded': 3,
      });
    });

    it('a rolled-back sale leaves NO audit or outbox residue', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const base = await auditBaseline();
      await asTenant(async (tx) => {
        await svc.completeAnonymousPayNowInTx(tx, saleInput(o, [cash(5_000n), bank(5_500n)]));
        throw new InjectedFault('after-everything');
      }).catch(() => undefined);
      expect(await auditDelta(base)).toEqual({});
    });

    it('no event of any other kind is written: the outbox holds only payments.* events for sales', async () => {
      const kinds = await q<{ eventType: string }>(
        `SELECT DISTINCT "eventType" FROM outbox WHERE "tenantId" = $1`,
        [tenantId],
      );
      expect(kinds.map((k) => k.eventType).sort()).toEqual([
        'payments.attempt_state_changed',
        'payments.payment_recorded',
      ]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 8. the OBSERVED lock order of the composed flow
  // ═════════════════════════════════════════════════════════════════════════════
  describe('observed lock order', () => {
    it('a single-tender sale takes locks in exactly the frozen hierarchy ORDER → LINES → numbering → INVOICE → payments → GL', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeAnonymousPayNowInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, [cash(10_500n)]),
        ),
      );
      expect(lockTrace(events)).toEqual([
        'order:FOR UPDATE', // the orchestrator's gate — the very first lock
        'order:FOR UPDATE', // prepareFinalization (an already-held lock: no-op)
        'order_line:FOR UPDATE',
        'order:FOR UPDATE', // issuance re-validation (no-op)
        'order_line:FOR UPDATE',
        'orderLine.update',
        'counter:ORDER',
        'counter:INVOICE',
        'order.update',
        'invoice.create',
        'order:FOR SHARE', // capture: a no-op downgrade of the order lock…
        'invoice:FOR UPDATE', // …then the invoice — ORDER before INVOICE, the frozen F4 order
        'INSERT payment_attempt',
        'INSERT payment',
        'INSERT payment_allocation',
        'company:FOR SHARE', // the walk-in adapter's currency check
        'company:FOR SHARE', // the posting engine
        'accounting_period:FOR SHARE',
      ]);
    });

    it('a Multi Payment repeats only the per-tender inserts — the hierarchy never changes', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeAnonymousPayNowInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, [cash(5_000n), bank(5_500n)]),
        ),
      );
      const trace = lockTrace(events);
      expect(trace.indexOf('invoice:FOR UPDATE')).toBeGreaterThan(trace.indexOf('order:FOR SHARE'));
      expect(trace.filter((t) => t === 'invoice:FOR UPDATE')).toHaveLength(1);
      expect(trace.filter((t) => t === 'INSERT payment')).toHaveLength(2);
      expect(trace.filter((t) => t.startsWith('OTHER:') || t.startsWith('TX-CONTROL'))).toEqual([]);
    });

    it('no primitive opens a transaction of its own anywhere in the composition', async () => {
      const o = await mkOrder(aed, one(10_000n));
      const events: TxEvent[] = [];
      await asTenant((tx) =>
        svc.completeAnonymousPayNowInTx(
          observe(tx, (e) => events.push(e)),
          saleInput(o, [cash(10_500n)]),
        ),
      );
      expect(events.filter((e) => e.kind === 'tx-control')).toEqual([]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 9. TaxFinalizationService prepare / issuePrepared — the narrow refactor
  // ═════════════════════════════════════════════════════════════════════════════
  describe('TaxFinalizationService.prepareFinalization / issuePrepared (behaviour-preserving split)', () => {
    it('prepareFinalization writes NOTHING and allocates NO number; issuePrepared then issues exactly what was prepared', async () => {
      const o = await mkOrder(aed, { ...one(10_000n), documentDiscountAmountMinor: 1_000n });
      const fp = (
        await q<{ f: string }>(
          `SELECT "commercialSnapshotFingerprint" AS f FROM "order" WHERE id = $1`,
          [o.orderId],
        )
      )[0]!.f;
      const before = await snapshot();
      const prepared = await asTenant((tx) =>
        finalization.prepareFinalization(tx, {
          tenantId,
          companyId: aed.companyId,
          branchId: aed.branchId,
          orderId: o.orderId,
        }),
      );
      expect(await snapshot()).toEqual(before);
      expect(prepared.totals.totalAmountMinor).toBe(9_450n);

      await asTenant((tx) =>
        finalization.issuePrepared(tx, prepared, {
          tenantId,
          companyId: aed.companyId,
          branchId: aed.branchId,
          orderId: o.orderId,
          expectedVersion: 1,
          commercialSnapshotFingerprint: fp,
          paymentIntent: 'PAY_NOW',
          actorUserId: actor,
        }),
      );
      const inv = (await invoiceOf(o.orderId))!;
      expect([inv.subtotal, inv.discount, inv.tax, inv.total]).toEqual([
        prepared.totals.subtotalAmountMinor,
        prepared.totals.documentDiscountAmountMinor,
        prepared.totals.taxTotalAmountMinor,
        prepared.totals.totalAmountMinor,
      ]);
    });

    it('issuePrepared refuses a preparation made for ANOTHER order', async () => {
      const a = await mkOrder(aed, one(10_000n));
      const b = await mkOrder(aed, one(20_000n));
      const fp = (
        await q<{ f: string }>(
          `SELECT "commercialSnapshotFingerprint" AS f FROM "order" WHERE id = $1`,
          [b.orderId],
        )
      )[0]!.f;
      await expect(
        asTenant(async (tx) => {
          const prepared = await finalization.prepareFinalization(tx, {
            tenantId,
            companyId: aed.companyId,
            branchId: aed.branchId,
            orderId: a.orderId,
          });
          return finalization.issuePrepared(tx, prepared, {
            tenantId,
            companyId: aed.companyId,
            branchId: aed.branchId,
            orderId: b.orderId,
            expectedVersion: 1,
            commercialSnapshotFingerprint: fp,
            paymentIntent: 'PAY_NOW',
          });
        }),
      ).rejects.toThrow(RangeError);
      expect(await invoiceOf(b.orderId)).toBeNull();
    });
  });
});
