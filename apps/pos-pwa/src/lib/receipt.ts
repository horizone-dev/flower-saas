import type { PosOrderLineRow } from '@flower/api-client';
import { formatMinor } from './money-display';

/**
 * THE RECEIPT MODEL. Everything on a receipt is a figure the SERVER produced (invoice header, per-line unit price, per-line VAT snapshot,
 * totals, payments); this module only ARRANGES and FORMATS them. It computes no price, no tax and no total. The one derived figure is a line's
 * extended amount (unit price × quantity − line discount), shown only when the quantity is a whole number (exact integer arithmetic) and the
 * price/tax mode is known — otherwise it is omitted rather than guessed. The invoice total, VAT total and tender amounts are never recomputed.
 */

export interface ReceiptSeller {
  name: string | null;
  /** tax registration number — a VAT invoice needs it; null means the till does NOT have it */
  trn: string | null;
  address: string | null;
}

export interface ReceiptInput {
  seller: ReceiptSeller;
  branchName: string | null;
  orderNumber: string;
  invoice: {
    invoiceNumber: string;
    /** civil date YYYY-MM-DD */
    invoiceDate: string;
    currencyCode: string;
    currencyExponent: number;
    subtotalAmountMinor: string;
    documentDiscountAmountMinor: string;
    taxTotalAmountMinor: string;
    totalAmountMinor: string;
    paymentStatus: string;
  };
  lines: readonly PosOrderLineRow[];
  /** `TAX_EXCLUSIVE` | `TAX_INCLUSIVE` as reported by the totals preview; null when unknown (a reprint from history) */
  priceTaxMode: string | null;
  customerName: string | null;
  /** the tenders of THIS sale (null on a reprint: the API has no payments read yet) */
  payments: readonly { method: string; amountMinor: string }[] | null;
  copy: 'ORIGINAL' | 'REPRINT';
  /** the customer advances the server applied to THIS sale (null / absent on a reprint: not read back) */
  advances?: readonly { amountMinor: string }[] | null;
  /** what the server left OUTSTANDING on this invoice (the customer's receivable); null / absent when unknown (a reprint) */
  outstandingMinor?: string | null;
}

export interface ReceiptLine {
  description: string;
  quantity: string;
  uom: string;
  unitPrice: string;
  /** unit × quantity − line discount, exact, or null when it cannot be shown exactly */
  amount: string | null;
  discount: string | null;
  vatRatePercent: string | null;
  vat: string | null;
}

export interface ReceiptModel {
  title: 'TAX INVOICE' | 'INVOICE';
  /** true when the seller's TRN is missing: the receipt must not be presented as a complete VAT invoice */
  headerIncomplete: boolean;
  copy: 'ORIGINAL' | 'REPRINT';
  seller: ReceiptSeller;
  branchName: string | null;
  invoiceNumber: string;
  orderNumber: string;
  invoiceDate: string;
  customerName: string | null;
  currency: string;
  exponent: number;
  lines: ReceiptLine[];
  amountColumnMeaning: 'EXCLUDING_VAT' | 'INCLUDING_VAT' | null;
  subtotal: string;
  discount: string | null;
  vatTotal: string;
  total: string;
  vatSummary: { ratePercent: string; vat: string }[];
  payments: { method: string; amount: string }[] | null;
  /** advances applied to this sale, exactly as the server recorded them; null when not known */
  advances: { amount: string }[] | null;
  /** the amount left on the customer's account for THIS invoice (shown only when greater than zero); null when none or unknown */
  balanceDue: string | null;
  paymentStatus: string;
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD_TERMINAL: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  OTHER_MANUAL: 'Other',
};

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method;
}

/** basis points → "5" / "5.5" (no trailing zeros) */
export function percentFromBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

function wholeQuantity(q: string): bigint | null {
  return /^\d+(\.0+)?$/.test(q) ? BigInt(q.split('.')[0]!) : null;
}

function describe(l: PosOrderLineRow): string {
  const v = l.variantNameEnSnapshot.trim();
  const p = l.productNameEnSnapshot.trim();
  return v && v !== p ? `${p} — ${v}` : p;
}

export function buildReceipt(i: ReceiptInput): ReceiptModel {
  const exp = i.invoice.currencyExponent;
  const fmt = (m: string | bigint): string => formatMinor(m, exp);
  const exclusive = i.priceTaxMode === 'TAX_EXCLUSIVE';
  const inclusive = i.priceTaxMode === 'TAX_INCLUSIVE';

  const vatByRate = new Map<number, bigint>();
  const lines: ReceiptLine[] = [...i.lines]
    .sort((a, b) => a.linePosition - b.linePosition)
    .map((l) => {
      const q = wholeQuantity(l.quantity);
      const discount = BigInt(l.discountAmountMinor);
      const amount =
        q !== null && (exclusive || inclusive)
          ? fmt(BigInt(l.unitPriceAmountMinor) * q - discount)
          : null;
      if (l.lineTaxAmountMinor !== null && l.rateBps !== null) {
        vatByRate.set(l.rateBps, (vatByRate.get(l.rateBps) ?? 0n) + BigInt(l.lineTaxAmountMinor));
      }
      return {
        description: describe(l),
        quantity: l.quantity,
        uom: l.uomDisplayLabelSnapshot || l.selectedUomCode,
        unitPrice: fmt(l.unitPriceAmountMinor),
        amount,
        discount: discount > 0n ? fmt(discount) : null,
        vatRatePercent: l.rateBps === null ? null : percentFromBps(l.rateBps),
        vat: l.lineTaxAmountMinor === null ? null : fmt(l.lineTaxAmountMinor),
      };
    });

  const docDiscount = BigInt(i.invoice.documentDiscountAmountMinor);
  const hasTrn = !!i.seller.trn;
  return {
    title: hasTrn ? 'TAX INVOICE' : 'INVOICE',
    headerIncomplete: !hasTrn || !i.seller.name,
    copy: i.copy,
    seller: i.seller,
    branchName: i.branchName,
    invoiceNumber: i.invoice.invoiceNumber,
    orderNumber: i.orderNumber,
    invoiceDate: i.invoice.invoiceDate,
    customerName: i.customerName,
    currency: i.invoice.currencyCode,
    exponent: exp,
    lines,
    amountColumnMeaning: exclusive ? 'EXCLUDING_VAT' : inclusive ? 'INCLUDING_VAT' : null,
    subtotal: fmt(i.invoice.subtotalAmountMinor),
    discount: docDiscount > 0n ? fmt(docDiscount) : null,
    vatTotal: fmt(i.invoice.taxTotalAmountMinor),
    total: fmt(i.invoice.totalAmountMinor),
    vatSummary: [...vatByRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bps, vat]) => ({ ratePercent: percentFromBps(bps), vat: fmt(vat) })),
    payments:
      i.payments === null
        ? null
        : i.payments.map((p) => ({ method: methodLabel(p.method), amount: fmt(p.amountMinor) })),
    advances: i.advances == null ? null : i.advances.map((a) => ({ amount: fmt(a.amountMinor) })),
    // the balance is the SERVER's outstanding figure, never derived here; zero / unknown shows nothing
    balanceDue:
      i.outstandingMinor == null || BigInt(i.outstandingMinor) <= 0n
        ? null
        : fmt(i.outstandingMinor),
    paymentStatus: paymentStatusLabel(i.invoice.paymentStatus),
  };
}

/** a fixed-width plain-text rendering (thermal printers, e-mail, tests); `width` in characters */
export function receiptText(m: ReceiptModel, width = 42): string[] {
  const out: string[] = [];
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s;
  const pair = (l: string, r: string) => {
    const gap = Math.max(1, width - l.length - r.length);
    return l + ' '.repeat(gap) + r;
  };
  const rule = '-'.repeat(width);
  if (m.seller.name) out.push(center(m.seller.name));
  if (m.branchName) out.push(center(m.branchName));
  if (m.seller.address) out.push(center(m.seller.address));
  if (m.seller.trn) out.push(center(`TRN ${m.seller.trn}`));
  out.push(center(m.title + (m.copy === 'REPRINT' ? ' (COPY)' : '')));
  if (m.headerIncomplete) out.push(center('* seller VAT details not available *'));
  out.push(rule);
  out.push(pair('Invoice', m.invoiceNumber));
  out.push(pair('Order', m.orderNumber));
  out.push(pair('Date', m.invoiceDate));
  if (m.customerName) out.push(pair('Customer', m.customerName));
  out.push(rule);
  for (const l of m.lines) {
    out.push(l.description);
    out.push(pair(`  ${l.quantity} ${l.uom} x ${l.unitPrice}`, l.amount ?? ''));
    if (l.discount) out.push(pair('  discount', `-${l.discount}`));
    if (l.vat !== null && l.vatRatePercent !== null)
      out.push(pair(`  VAT ${l.vatRatePercent}%`, l.vat));
  }
  out.push(rule);
  out.push(
    pair(`Subtotal${m.amountColumnMeaning === 'INCLUDING_VAT' ? ' (incl. VAT)' : ''}`, m.subtotal),
  );
  if (m.discount) out.push(pair('Discount', `-${m.discount}`));
  out.push(pair('VAT', m.vatTotal));
  out.push(pair(`TOTAL ${m.currency}`, m.total));
  out.push(rule);
  if (m.payments) for (const p of m.payments) out.push(pair(p.method, p.amount));
  if (m.advances) for (const a of m.advances) out.push(pair('Advance applied', a.amount));
  if (m.balanceDue) out.push(pair('Balance due (on account)', m.balanceDue));
  out.push(pair('Payment status', m.paymentStatus));
  return out;
}

const STATUS_LABEL: Record<string, string> = {
  PAID: 'PAID',
  SETTLED: 'PAID', // fully paid AND settled under the settlement authority — to the customer it is simply paid
  PARTIAL: 'PART PAID',
  UNPAID: 'UNPAID',
};

/** the customer-facing words for an invoice's payment status (any other server state is shown (underscores as spaces), never hidden) */
export function paymentStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

/** the receipt's seller block from the server's identity read (a blank value is "not configured", never invented) */
export function sellerFromIdentity(
  i: { legalNameEn: string; trn: string | null; registeredAddress: string | null } | null,
): ReceiptSeller {
  const clean = (v: string | null | undefined): string | null =>
    v && v.trim() !== '' ? v.trim() : null;
  return {
    name: clean(i?.legalNameEn),
    trn: clean(i?.trn),
    address: clean(i?.registeredAddress),
  };
}
