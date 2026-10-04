import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toOrderInvoiceSummary, type IssuedInvoiceSummarySource } from './order-invoice-summary.js';

/**
 * Task 3b.9 Checkpoint A (A5) — the recovery-read design pin (OD-13).
 * Proves the contract Checkpoint E will wire into the Order GET, without
 * expanding any existing order read behaviour.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');

const issued: IssuedInvoiceSummarySource = {
  id: '10000000-0000-7000-8000-000000000001',
  invoiceNumber: 'INV-000042',
  invoiceDate: new Date('2026-10-03T00:00:00.000Z'),
  totalAmountMinor: 10_500n,
  invoicePaymentStatus: 'SETTLED',
};

describe('toOrderInvoiceSummary — what a client recovers from a lost response', () => {
  it('projects exactly the five recoverable fields from the ISSUED invoice', () => {
    expect(toOrderInvoiceSummary(issued)).toEqual({
      invoiceId: issued.id,
      invoiceNumber: 'INV-000042',
      invoiceDate: '2026-10-03',
      totalAmountMinor: '10500',
      invoicePaymentStatus: 'SETTLED',
    });
  });

  it('is null while the order has no invoice (draft / held / cancelled before invoicing)', () => {
    expect(toOrderInvoiceSummary(null)).toBeNull();
    expect(toOrderInvoiceSummary(undefined)).toBeNull();
  });

  it('exposes nothing beyond the five fields — no subtotal, tax, discount, currency, customer, scope id or number counter', () => {
    const keys = Object.keys(toOrderInvoiceSummary(issued)!).sort();
    expect(keys).toEqual([
      'invoiceDate',
      'invoiceId',
      'invoiceNumber',
      'invoicePaymentStatus',
      'totalAmountMinor',
    ]);
  });

  it('the total is an exact decimal-digit string, JSON-safe, with no precision loss on large amounts', () => {
    const big = toOrderInvoiceSummary({ ...issued, totalAmountMinor: 900_719_925_474_099_321n })!;
    expect(big.totalAmountMinor).toBe('900719925474099321');
    expect(() => JSON.stringify(big)).not.toThrow();
  });

  it('the payment status is read as stored — it is derived elsewhere and never rewritten here', () => {
    for (const status of ['UNPAID', 'PARTIAL', 'PAID', 'SETTLED']) {
      expect(
        toOrderInvoiceSummary({ ...issued, invoicePaymentStatus: status })!.invoicePaymentStatus,
      ).toBe(status);
    }
  });

  it('the civil date is the stored DATE exactly — never shifted by a timezone', () => {
    expect(
      toOrderInvoiceSummary({ ...issued, invoiceDate: new Date('2026-01-01T00:00:00.000Z') })!
        .invoiceDate,
    ).toBe('2026-01-01');
    expect(toOrderInvoiceSummary({ ...issued, invoiceDate: '2026-12-31' })!.invoiceDate).toBe(
      '2026-12-31',
    );
  });

  it('refuses an instant that is not a DATE value rather than silently picking a UTC day', () => {
    expect(() =>
      toOrderInvoiceSummary({ ...issued, invoiceDate: new Date('2026-10-03T23:30:00.000Z') }),
    ).toThrow(/DATE value/);
    expect(() => toOrderInvoiceSummary({ ...issued, invoiceDate: new Date('invalid') })).toThrow(
      /invalid Date/,
    );
    expect(() => toOrderInvoiceSummary({ ...issued, invoiceDate: '03/10/2026' })).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('refuses a non-BigInt total — no JS number ever stands in for money', () => {
    expect(() =>
      toOrderInvoiceSummary({ ...issued, totalAmountMinor: 10_500 as unknown as bigint }),
    ).toThrow(/BigInt/);
  });

  it('is deterministic and does not mutate its source', () => {
    const copy = structuredClone(issued);
    const first = toOrderInvoiceSummary(issued);
    expect(toOrderInvoiceSummary(issued)).toEqual(first);
    expect(issued).toEqual(copy);
  });
});

describe('the contract is satisfiable from the schema — the ISSUED invoice is the only source', () => {
  const schema = readFileSync(
    join(HERE, '../../../../../packages/db/prisma/schema.prisma'),
    'utf8',
  );
  const invoiceModel = schema.slice(
    schema.indexOf('model Invoice {'),
    schema.indexOf('@@map("invoice")'),
  );

  it('the invoice row carries every field of the summary', () => {
    for (const column of [
      'id ',
      'invoiceNumber ',
      'invoiceDate ',
      'totalAmountMinor ',
      'invoicePaymentStatus ',
    ]) {
      expect(invoiceModel, column).toContain(`\n  ${column}`);
    }
  });

  it('an order has at most ONE invoice (invoice.orderId is UNIQUE), so the lookup by orderId is unambiguous', () => {
    expect(invoiceModel).toMatch(/orderId\s+String\s+@unique\s+@db\.Uuid/);
  });

  it('every one of those fields is immutable-or-derived on the invoice, so the summary needs no second source of truth', () => {
    // invoicePaymentStatus is the one mutable column; it is DERIVED by the receivables projection
    expect(invoiceModel).toMatch(/invoicePaymentStatus\s+String\s+@default\("UNPAID"\)/);
  });

  it('the summary file reads only invoice columns: no order, tax, discount, customer, journal or payment source', () => {
    const src = read('order-invoice-summary.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      /subtotal/i,
      /taxTotal/i,
      /documentDiscount/i,
      /customerId/i,
      /journal/i,
      /payment_?allocation/i,
      /@flower\/db/,
      /prisma/i,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});

describe('Checkpoint E wires the summary into the Order read — and ONLY there (advanced from the Checkpoint-A scope pin)', () => {
  it('the OrderRepository references the mapper only inside its marker-delimited recovery-read block, and the OrderController never imports it (it only renders `issuedInvoice`)', () => {
    const repo = read('order.repository.ts');
    const outsideTheMarkedBlocks = repo.replace(
      /\/\/ 3b\.9-order-invoice:begin[\s\S]*?\/\/ 3b\.9-order-invoice:end/g,
      '',
    );
    expect(outsideTheMarkedBlocks).not.toMatch(/order-invoice-summary|toOrderInvoiceSummary/);
    expect(repo).toMatch(/toOrderInvoiceSummary\(/);
    const controller = read('order.controller.ts');
    expect(controller).not.toMatch(/order-invoice-summary|toOrderInvoiceSummary/);
    expect(controller).toMatch(/issuedInvoice/);
  });
});
