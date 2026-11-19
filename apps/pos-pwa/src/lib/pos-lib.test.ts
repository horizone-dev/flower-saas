import { describe, expect, it } from 'vitest';
import type {
  BranchEffectiveCatalogEntry,
  MeAccess,
  OrgBranchRow,
  OrgCompanyRow,
  PosOrderLineRow,
  ProductRow,
} from '@flower/api-client';
import { formatMinor, formatMoney, isValidQuantity, parseAmountInput } from './money-display';
import {
  EMPTY_CART,
  cartFingerprint,
  cartReducer,
  estimateSubtotalMinor,
  toOrderLines,
  unitCount,
  type Cart,
} from './cart';
import { changeAid, planTenders, quickCashAmounts, tendersFingerprint } from './tender';
import {
  checkoutErrorMessage,
  completeKeyFor,
  newAttempt,
  orderStep,
  withOrder,
  withSale,
} from './checkout';
import { buildTiles, filterTiles } from './catalog';
import { resolveContext } from './context';
import {
  buildReceipt,
  paymentStatusLabel,
  percentFromBps,
  receiptText,
  sellerFromIdentity,
} from './receipt';

describe('money display — exact, no floating point', () => {
  it('formats minor units with grouping and the currency exponent', () => {
    expect(formatMinor('123450', 2)).toBe('1,234.50');
    expect(formatMinor('5', 2)).toBe('0.05');
    expect(formatMinor('0', 2)).toBe('0.00');
    expect(formatMinor(1234567n, 3)).toBe('1,234.567'); // 3-decimal currencies (KWD / BHD / OMR)
    expect(formatMinor('1500', 0)).toBe('1,500');
    expect(formatMinor('-250', 2)).toBe('-2.50');
    expect(formatMoney('1000', 2, 'AED')).toBe('AED 10.00');
    // beyond Number.MAX_SAFE_INTEGER stays exact
    expect(formatMinor('9007199254740993', 2)).toBe('90,071,992,547,409.93');
  });
  it('refuses a malformed amount instead of showing a guess', () => {
    for (const bad of ['', '1.5', 'abc', '1e3', ' 12', '--1'])
      expect(() => formatMinor(bad, 2)).toThrow(RangeError);
    expect(() => formatMinor('1', 9)).toThrow(RangeError);
  });
  it('parses what a cashier types into integer minor units and never rounds', () => {
    expect(parseAmountInput('12', 2)).toBe(1200n);
    expect(parseAmountInput('12.5', 2)).toBe(1250n);
    expect(parseAmountInput('12.50', 2)).toBe(1250n);
    expect(parseAmountInput('1,000.05', 2)).toBe(100005n);
    expect(parseAmountInput('0.005', 3)).toBe(5n);
    expect(parseAmountInput('12.505', 2)).toBeNull();
    expect(parseAmountInput('-5', 2)).toBeNull();
    expect(parseAmountInput('abc', 2)).toBeNull();
    expect(parseAmountInput('', 2)).toBeNull();
    expect(parseAmountInput('5.', 2)).toBe(500n);
  });
  it('validates quantities like the API (positive decimal, ≤ 4 dp)', () => {
    for (const ok of ['1', '2', '0.5', '1.2345', '10']) expect(isValidQuantity(ok)).toBe(true);
    for (const bad of ['0', '0.0', '-1', '1.23456', 'x', '', '1.', '.5'])
      expect(isValidQuantity(bad)).toBe(false);
  });
});

const ROSE = {
  productId: 'p1',
  variantId: 'v1',
  uomCode: 'piece',
  name: 'Rose',
  variantName: null,
  unitPriceMinor: '1000',
};
const TULIP = {
  productId: 'p2',
  variantId: 'v2',
  uomCode: 'piece',
  name: 'Tulip',
  variantName: null,
  unitPriceMinor: '750',
};

describe('cart — client state only, never prices', () => {
  it('adding the same item increments one line; different items are separate lines', () => {
    let c: Cart = EMPTY_CART;
    c = cartReducer(c, { type: 'add', line: ROSE });
    c = cartReducer(c, { type: 'add', line: ROSE });
    c = cartReducer(c, { type: 'add', line: TULIP, quantity: '3' });
    expect(c.lines.map((l) => [l.key, l.quantity])).toEqual([
      ['v1:piece', '2'],
      ['v2:piece', '3'],
    ]);
    expect(unitCount(c)).toBe('5');
  });
  it('increment / decrement / set / remove / clear; decrementing the last unit removes the line', () => {
    let c = cartReducer(EMPTY_CART, { type: 'add', line: ROSE, quantity: '2' });
    c = cartReducer(c, { type: 'increment', key: 'v1:piece' });
    expect(c.lines[0]!.quantity).toBe('3');
    c = cartReducer(c, { type: 'decrement', key: 'v1:piece' });
    c = cartReducer(c, { type: 'decrement', key: 'v1:piece' });
    expect(c.lines[0]!.quantity).toBe('1');
    c = cartReducer(c, { type: 'decrement', key: 'v1:piece' });
    expect(c.lines).toEqual([]);
    c = cartReducer(c, { type: 'add', line: ROSE });
    c = cartReducer(c, { type: 'setQuantity', key: 'v1:piece', quantity: '2.5' });
    expect(c.lines[0]!.quantity).toBe('2.5');
    expect(cartReducer(c, { type: 'setQuantity', key: 'v1:piece', quantity: '0' })).toBe(c); // invalid → unchanged
    expect(cartReducer(c, { type: 'setQuantity', key: 'v1:piece', quantity: '1.23456' })).toBe(c);
    expect(cartReducer(c, { type: 'remove', key: 'v1:piece' }).lines).toEqual([]);
    expect(cartReducer(c, { type: 'clear' })).toBe(EMPTY_CART);
  });
  it('decimal quantities stay exact (2.5 + 1 = 3.5; 0.0001 steps)', () => {
    let c = cartReducer(EMPTY_CART, { type: 'add', line: ROSE, quantity: '2.5' });
    c = cartReducer(c, { type: 'increment', key: 'v1:piece' });
    expect(c.lines[0]!.quantity).toBe('3.5');
    c = cartReducer(c, { type: 'add', line: ROSE, quantity: '0.0001' });
    expect(c.lines[0]!.quantity).toBe('3.5001');
  });
  it('the order the API receives carries ids, unit and quantity ONLY — no price, no tax, no total', () => {
    const c = cartReducer(cartReducer(EMPTY_CART, { type: 'add', line: ROSE, quantity: '2' }), {
      type: 'add',
      line: TULIP,
    });
    const lines = toOrderLines(c);
    expect(lines).toEqual([
      { productId: 'p1', variantId: 'v1', selectedUomCode: 'piece', quantity: '2' },
      { productId: 'p2', variantId: 'v2', selectedUomCode: 'piece', quantity: '1' },
    ]);
    for (const l of lines)
      expect(Object.keys(l).sort()).toEqual([
        'productId',
        'quantity',
        'selectedUomCode',
        'variantId',
      ]);
  });
  it('the estimate is exact for whole quantities and withheld (null) for fractional ones', () => {
    const whole = cartReducer(cartReducer(EMPTY_CART, { type: 'add', line: ROSE, quantity: '2' }), {
      type: 'add',
      line: TULIP,
    });
    expect(estimateSubtotalMinor(whole)).toBe(2750n);
    expect(
      estimateSubtotalMinor(
        cartReducer(whole, { type: 'setQuantity', key: 'v1:piece', quantity: '1.5' }),
      ),
    ).toBeNull();
    expect(estimateSubtotalMinor(EMPTY_CART)).toBe(0n);
  });
  it('the fingerprint ignores line order and changes with quantity, customer or content', () => {
    const a = cartReducer(cartReducer(EMPTY_CART, { type: 'add', line: ROSE }), {
      type: 'add',
      line: TULIP,
    });
    const b = cartReducer(cartReducer(EMPTY_CART, { type: 'add', line: TULIP }), {
      type: 'add',
      line: ROSE,
    });
    expect(cartFingerprint(a, null)).toBe(cartFingerprint(b, null));
    expect(cartFingerprint(a, 'c1')).not.toBe(cartFingerprint(a, null));
    expect(cartFingerprint(cartReducer(a, { type: 'increment', key: 'v1:piece' }), null)).not.toBe(
      cartFingerprint(a, null),
    );
  });
  it('the cart is bounded like the API (200 lines)', () => {
    let c: Cart = EMPTY_CART;
    for (let i = 0; i < 210; i++)
      c = cartReducer(c, { type: 'add', line: { ...ROSE, variantId: `v${i}` } });
    expect(c.lines).toHaveLength(200);
  });
});

describe('tender planning — the tenders always add up to the server total', () => {
  const total = 10_500n; // 105.00
  it('CASH: one tender for the full total; the overpayment is change, never a payment amount', () => {
    const p = planTenders({
      totalMinor: total,
      mode: 'CASH',
      cashTenderedMinor: 20_000n,
      cardMinor: null,
    });
    expect(p).toMatchObject({
      ok: true,
      cashDueMinor: total,
      cardMinor: 0n,
      changeDueMinor: 9_500n,
    });
    if (p.ok) expect(p.tenders).toEqual([{ method: 'CASH', amountMinor: '10500' }]);
  });
  it('CASH: short or missing tender is refused', () => {
    expect(
      planTenders({ totalMinor: total, mode: 'CASH', cashTenderedMinor: 10_499n, cardMinor: null }),
    ).toEqual({ ok: false, reason: 'CASH_TENDER_SHORT' });
    expect(
      planTenders({ totalMinor: total, mode: 'CASH', cashTenderedMinor: null, cardMinor: null }),
    ).toEqual({ ok: false, reason: 'CASH_TENDER_REQUIRED' });
    expect(
      planTenders({ totalMinor: total, mode: 'CASH', cashTenderedMinor: total, cardMinor: null }),
    ).toMatchObject({ ok: true, changeDueMinor: 0n });
  });
  it('CARD: one card tender for the full total, no change', () => {
    const p = planTenders({
      totalMinor: total,
      mode: 'CARD',
      cashTenderedMinor: null,
      cardMinor: null,
    });
    expect(p).toMatchObject({ ok: true, changeDueMinor: 0n });
    if (p.ok) expect(p.tenders).toEqual([{ method: 'CARD_TERMINAL', amountMinor: '10500' }]);
  });
  it('SPLIT: the card part is partial; cash covers the rest; the tenders sum to the total', () => {
    const p = planTenders({
      totalMinor: total,
      mode: 'SPLIT',
      cashTenderedMinor: 5_000n,
      cardMinor: 6_000n,
    });
    expect(p).toMatchObject({
      ok: true,
      cashDueMinor: 4_500n,
      cardMinor: 6_000n,
      changeDueMinor: 500n,
    });
    if (p.ok) {
      expect(p.tenders).toEqual([
        { method: 'CASH', amountMinor: '4500' },
        { method: 'CARD_TERMINAL', amountMinor: '6000' },
      ]);
      expect(p.tenders.reduce((s, t) => s + BigInt(t.amountMinor), 0n)).toBe(total);
    }
    for (const card of [0n, total, total + 1n, null]) {
      expect(
        planTenders({
          totalMinor: total,
          mode: 'SPLIT',
          cashTenderedMinor: total,
          cardMinor: card,
        }),
      ).toEqual({ ok: false, reason: 'SPLIT_CARD_INVALID' });
    }
    expect(
      planTenders({
        totalMinor: total,
        mode: 'SPLIT',
        cashTenderedMinor: 4_000n,
        cardMinor: 6_000n,
      }),
    ).toEqual({ ok: false, reason: 'CASH_TENDER_SHORT' });
  });
  it('a zero or negative total can never be paid', () => {
    for (const t of [0n, -1n])
      expect(
        planTenders({ totalMinor: t, mode: 'CARD', cashTenderedMinor: null, cardMinor: null }),
      ).toEqual({ ok: false, reason: 'TOTAL_NOT_POSITIVE' });
  });
  it('quick-cash buttons: exact amount first, then the next round notes (exponent aware)', () => {
    expect(quickCashAmounts(10_500n, 2)).toEqual([10_500n, 11_000n, 12_000n, 15_000n, 20_000n]);
    expect(quickCashAmounts(0n, 2)).toEqual([]);
    expect(quickCashAmounts(1_500n, 3)[0]).toBe(1_500n); // 3-decimal currency
  });
});

describe('checkout attempt — retries can never sell twice', () => {
  let n = 0;
  const uuid = () => `key-${++n}`;
  const SALE = { order: { id: 'o1', orderNumber: 'ORD-1' } } as never;
  it('the order is created once per cart; a changed cart UPDATES the same draft; a finished sale is final', () => {
    let a = newAttempt(uuid);
    expect(orderStep(a, 'fp1')).toBe('CREATE');
    a = withOrder(a, { id: 'o1', version: 1 }, 'fp1');
    expect(orderStep(a, 'fp1')).toBe('REUSE');
    expect(orderStep(a, 'fp2')).toBe('UPDATE');
    a = withOrder(a, { id: 'o1', version: 2 }, 'fp2');
    expect(a.orderId).toBe('o1');
    expect(orderStep(withSale(a, SALE), 'fp2')).toBe('FINISHED');
  });
  it('the SAME payment always gets the SAME idempotency key (a retry replays); a different payment gets a new key', () => {
    n = 0;
    let a = newAttempt(uuid);
    const cash = [{ method: 'CASH' as const, amountMinor: '10500' }];
    const split = [
      { method: 'CASH' as const, amountMinor: '4500' },
      { method: 'CARD_TERMINAL' as const, amountMinor: '6000' },
    ];
    const r1 = completeKeyFor(a, cash, uuid);
    a = r1.attempt;
    const r2 = completeKeyFor(a, cash, uuid);
    expect(r2.key).toBe(r1.key); // retry after a timeout
    const r3 = completeKeyFor(r2.attempt, split, uuid);
    expect(r3.key).not.toBe(r1.key); // a different payment
    expect(completeKeyFor(r3.attempt, cash, uuid).key).toBe(r1.key); // switching back reuses the first
    expect(tendersFingerprint(cash)).not.toBe(tendersFingerprint(split));
  });
  it('error messages: known codes are explained; a server failure tells the cashier NOT to hand over the goods', () => {
    expect(checkoutErrorMessage('NO_OPEN_ACCOUNTING_PERIOD', 422)).toMatch(/accounting period/i);
    // F-6 server refusal (once the server amendment is applied): same instruction as the till's own guard
    expect(checkoutErrorMessage('ORDER_LINE_TAX_NOT_CONFIGURED', 422)).toMatch(/VAT category/i);
    expect(checkoutErrorMessage('ORDER_VERSION_CONFLICT', 409)).toMatch(
      /changed or already completed/i,
    );
    expect(checkoutErrorMessage('SALE_OVERPAYMENT_NOT_ALLOWED', 422)).toMatch(/does not match/i);
    expect(checkoutErrorMessage('X', 401)).toMatch(/sign in/i);
    expect(checkoutErrorMessage('X', 403)).toMatch(/not allowed/i);
    expect(checkoutErrorMessage('X', 500)).toMatch(/do not hand over/i);
    expect(checkoutErrorMessage('X', 0)).toMatch(/do not hand over/i);
  });
});

const PRODUCTS: ProductRow[] = [
  {
    id: 'p1',
    categoryId: 'c',
    productTypeId: null,
    slug: 'rose',
    nameEn: 'Rose',
    nameAr: 'وردة',
    description: null,
    fulfilmentStrategy: 'STOCKED',
    hidePrice: false,
    status: 'ACTIVE',
    version: 1,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'p2',
    categoryId: 'c',
    productTypeId: null,
    slug: 'tulip',
    nameEn: 'Tulip',
    nameAr: null,
    description: null,
    fulfilmentStrategy: 'STOCKED',
    hidePrice: false,
    status: 'ACTIVE',
    version: 1,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'p3',
    categoryId: 'c',
    productTypeId: null,
    slug: 'draft',
    nameEn: 'Draft',
    nameAr: null,
    description: null,
    fulfilmentStrategy: 'STOCKED',
    hidePrice: false,
    status: 'DRAFT',
    version: 1,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'p4',
    categoryId: 'c',
    productTypeId: null,
    slug: 'unpriced',
    nameEn: 'Unpriced',
    nameAr: null,
    description: null,
    fulfilmentStrategy: 'STOCKED',
    hidePrice: false,
    status: 'ACTIVE',
    version: 1,
    createdAt: '',
    updatedAt: '',
  },
];
const money = (a: string) => ({ amountMinor: a, currency: 'AED', exponent: 2 });
const EFFECTIVE: BranchEffectiveCatalogEntry[] = [
  {
    variantId: 'v1',
    productId: 'p1',
    available: true,
    prices: [{ uomCode: 'piece', sell: money('1000'), source: 'COMPANY', resolvable: true }],
  },
  {
    variantId: 'v1b',
    productId: 'p1',
    available: true,
    prices: [{ uomCode: 'piece', sell: money('800'), source: 'BRANCH', resolvable: true }],
  },
  {
    variantId: 'v2',
    productId: 'p2',
    available: false,
    prices: [{ uomCode: 'piece', sell: money('750'), source: 'COMPANY', resolvable: true }],
  },
  {
    variantId: 'v4',
    productId: 'p4',
    available: true,
    prices: [{ uomCode: 'piece', sell: money('500'), source: 'COMPANY', resolvable: false }],
  },
];

describe('catalog tiles — names + the branch’s effective catalog', () => {
  const tiles = buildTiles(PRODUCTS, EFFECTIVE);
  it('only ACTIVE, priced products offered in the branch appear; sorted by name', () => {
    expect(tiles.map((t) => t.name)).toEqual(['Rose', 'Tulip']);
  });
  it('the lowest resolvable price of the available variants is the "from" price; an unavailable product is not sellable', () => {
    const rose = tiles.find((t) => t.productId === 'p1')!;
    expect(rose).toMatchObject({
      sellable: true,
      fromPriceMinor: '800',
      multiVariant: true,
      currency: 'AED',
      exponent: 2,
    });
    const tulip = tiles.find((t) => t.productId === 'p2')!;
    expect(tulip).toMatchObject({ sellable: false, fromPriceMinor: null, multiVariant: false });
  });
  it('search matches English and Arabic names case-insensitively, and known variant names', () => {
    expect(filterTiles(tiles, 'ROS').map((t) => t.name)).toEqual(['Rose']);
    expect(filterTiles(tiles, 'وردة').map((t) => t.name)).toEqual(['Rose']);
    expect(filterTiles(tiles, 'red', { v2: 'Red tulip' }).map((t) => t.name)).toEqual(['Tulip']);
    expect(filterTiles(tiles, '  ').length).toBe(2);
    expect(filterTiles(tiles, 'zzz')).toEqual([]);
  });
});

const ID_C = '11111111-1111-4111-8111-111111111111';
const ID_B1 = '22222222-2222-4222-8222-222222222222';
const ID_B2 = '33333333-3333-4333-8333-333333333333';
const access = (over: Partial<MeAccess>): MeAccess => ({
  accountType: 'USER',
  planKey: null,
  entitledModules: [],
  companyScope: [ID_C],
  branchScope: [ID_B1],
  permissions: ['orders:manage', 'orders:view', 'customers:manage'],
  perBranchOverlay: {},
  ...over,
});
const ORG_C: OrgCompanyRow[] = [{ id: ID_C, legalNameEn: 'Rose LLC' }];
const ORG_B: OrgBranchRow[] = [
  { id: ID_B1, companyId: ID_C, name: 'Main' },
  { id: ID_B2, companyId: ID_C, name: 'Mall' },
];

describe('till context — scope comes from the server', () => {
  it('a scoped cashier sells for exactly their company and branch; no org list is needed', () => {
    const r = resolveContext(access({}), null, null, null);
    expect(r).toMatchObject({
      ok: true,
      context: {
        companyId: ID_C,
        branchId: ID_B1,
        canSell: true,
        canViewSales: true,
        canCreateCustomer: true,
      },
    });
  });
  it('customer accounts and collections follow the session permissions (UI hints — the server enforces them again)', () => {
    const ctx = (permissions: string[]) => {
      const r = resolveContext(access({ permissions }), null, null, null);
      if (!r.ok) throw new Error('refused');
      return r.context;
    };
    const none = ctx(['orders:manage']);
    expect([none.canViewAccounts, none.canCollect]).toEqual([false, false]);
    // viewing an account needs BOTH the customer read and the receivables read
    expect(ctx(['orders:manage', 'customers:view']).canViewAccounts).toBe(false);
    expect(ctx(['orders:manage', 'receivables:view']).canViewAccounts).toBe(false);
    const viewer = ctx(['orders:manage', 'customers:view', 'receivables:view']);
    expect([viewer.canViewAccounts, viewer.canCollect]).toEqual([true, false]);
    const cashier = ctx([
      'orders:manage',
      'customers:view',
      'receivables:view',
      'receivables:collect',
    ]);
    expect([cashier.canViewAccounts, cashier.canCollect]).toEqual([true, true]);
    // collecting without being able to see the account is not offered
    expect(ctx(['orders:manage', 'receivables:collect']).canCollect).toBe(false);
  });
  it('an unrestricted Owner chooses among the organisation’s branches; a preference outside the allowed set is ignored', () => {
    const owner = access({ companyScope: 'ALL', branchScope: 'ALL' });
    const r = resolveContext(owner, ORG_C, ORG_B, ID_B2);
    expect(r).toMatchObject({
      ok: true,
      context: { companyId: ID_C, branchId: ID_B2, branchName: 'Mall', companyName: 'Rose LLC' },
    });
    const ignored = resolveContext(access({ branchScope: [ID_B1] }), ORG_C, ORG_B, ID_B2);
    expect(ignored).toMatchObject({ ok: true, context: { branchId: ID_B1 } });
  });
  it('refusals: no sell permission, no branch, no company', () => {
    expect(resolveContext(access({ permissions: ['orders:view'] }), null, null, null)).toEqual({
      ok: false,
      reason: 'NO_SELL_PERMISSION',
    });
    expect(resolveContext(access({ branchScope: [] }), null, null, null)).toEqual({
      ok: false,
      reason: 'NO_BRANCH_SCOPE',
    });
    expect(resolveContext(access({ companyScope: 'ALL' }), null, null, null)).toEqual({
      ok: false,
      reason: 'NO_COMPANY_SCOPE',
    });
    expect(resolveContext(access({ branchScope: ['not-a-uuid'] }), null, null, null)).toEqual({
      ok: false,
      reason: 'NO_BRANCH_SCOPE',
    });
  });
});

const LINE = (over: Partial<PosOrderLineRow>): PosOrderLineRow => ({
  id: 'l',
  orderId: 'o',
  linePosition: 1,
  productId: 'p1',
  variantId: 'v1',
  quantity: '2',
  unitPriceAmountMinor: '1000',
  unitPriceCurrencyCode: 'AED',
  discountMode: 'NONE',
  discountAmountMinor: '0',
  taxCategoryKey: 'STANDARD',
  rateBps: 500,
  lineTaxAmountMinor: '100',
  productNameEnSnapshot: 'Rose',
  productNameArSnapshot: null,
  variantNameEnSnapshot: 'Rose',
  variantNameArSnapshot: null,
  skuSnapshot: null,
  selectedUomCode: 'piece',
  uomDisplayLabelSnapshot: 'pc',
  ...over,
});
const INVOICE = {
  invoiceNumber: 'INV-0001',
  invoiceDate: '2026-11-14',
  currencyCode: 'AED',
  currencyExponent: 2,
  subtotalAmountMinor: '2000',
  documentDiscountAmountMinor: '0',
  taxTotalAmountMinor: '100',
  totalAmountMinor: '2100',
  paymentStatus: 'PAID',
};
const SELLER = { name: 'Rose LLC', trn: '100123456700003', address: 'Dubai' };

describe('receipt — arranges server figures, computes none', () => {
  const base = {
    seller: SELLER,
    branchName: 'Main',
    orderNumber: 'ORD-1',
    invoice: INVOICE,
    lines: [LINE({})],
    priceTaxMode: 'TAX_EXCLUSIVE',
    customerName: null,
    payments: [{ method: 'CASH', amountMinor: '2100' }],
    copy: 'ORIGINAL' as const,
  };
  it('a TAX INVOICE with the seller TRN, exact line amount, VAT by rate, server totals and the RECORDED payments only', () => {
    const m = buildReceipt(base);
    expect(m).toMatchObject({
      title: 'TAX INVOICE',
      headerIncomplete: false,
      subtotal: '20.00',
      vatTotal: '1.00',
      total: '21.00',
      amountColumnMeaning: 'EXCLUDING_VAT',
    });
    // the printed document carries ONLY what the system recorded: no cash-handed-over / change (those are never stored)
    expect(m).not.toHaveProperty('cashTendered');
    expect(m).not.toHaveProperty('changeDue');
    const printed = receiptText(m).join('\n');
    expect(printed).not.toMatch(/Cash received|Change/i);
    expect(m.lines[0]).toMatchObject({
      description: 'Rose',
      quantity: '2',
      unitPrice: '10.00',
      amount: '20.00',
      vatRatePercent: '5',
      vat: '1.00',
    });
    expect(m.vatSummary).toEqual([{ ratePercent: '5', vat: '1.00' }]);
    expect(m.payments).toEqual([{ method: 'Cash', amount: '21.00' }]);
    const text = receiptText(m).join('\n');
    expect(text).toContain('TRN 100123456700003');
    expect(text).toContain('INV-0001');
    expect(text).toMatch(/TOTAL AED\s+21\.00/);
    expect(text).toMatch(/Cash\s+21\.00/); // the recorded tender, nothing else
  });
  it('without the seller TRN the receipt is marked INVOICE with an incomplete header — never presented as a full VAT invoice', () => {
    const m = buildReceipt({ ...base, seller: { name: null, trn: null, address: null } });
    expect(m).toMatchObject({ title: 'INVOICE', headerIncomplete: true });
    expect(receiptText(m).join('\n')).toContain('seller VAT details not available');
  });
  it('a fractional quantity or an unknown tax mode omits the extended amount rather than guessing; discounts are shown', () => {
    expect(
      buildReceipt({ ...base, lines: [LINE({ quantity: '1.5' })] }).lines[0]!.amount,
    ).toBeNull();
    expect(buildReceipt({ ...base, priceTaxMode: null }).lines[0]!.amount).toBeNull();
    expect(
      buildReceipt({
        ...base,
        lines: [LINE({ discountAmountMinor: '200', discountMode: 'AMOUNT' })],
      }).lines[0],
    ).toMatchObject({ amount: '18.00', discount: '2.00' });
  });
  it('several rates are summarised separately; a variant name different from the product is shown; 3-decimal currencies keep their exponent', () => {
    const m = buildReceipt({
      ...base,
      invoice: { ...INVOICE, currencyCode: 'KWD', currencyExponent: 3, totalAmountMinor: '2100' },
      lines: [
        LINE({
          linePosition: 2,
          rateBps: 0,
          lineTaxAmountMinor: '0',
          variantNameEnSnapshot: 'Red',
        }),
        LINE({}),
      ],
    });
    expect(m.lines.map((l) => l.description)).toEqual(['Rose', 'Rose — Red']);
    expect(m.vatSummary).toEqual([
      { ratePercent: '0', vat: '0.000' },
      { ratePercent: '5', vat: '0.100' },
    ]);
    expect(m.total).toBe('2.100');
  });
  it('a reprint says COPY and has no tender detail the API does not provide', () => {
    const m = buildReceipt({
      ...base,
      copy: 'REPRINT',
      payments: null,
      priceTaxMode: null,
    });
    expect(m).toMatchObject({
      copy: 'REPRINT',
      payments: null,
    });
    expect(receiptText(m).join('\n')).toContain('(COPY)');
  });
  it('percent from basis points', () => {
    expect([0, 500, 550, 1500, 5].map(percentFromBps)).toEqual(['0', '5', '5.5', '15', '0.05']);
  });
});

describe('payment status label — a paid invoice never reads as an internal state', () => {
  it('shows PAID for both PAID and the settled state, and spells the rest out', () => {
    expect(paymentStatusLabel('PAID')).toBe('PAID');
    expect(paymentStatusLabel('SETTLED')).toBe('PAID');
    expect(paymentStatusLabel('PARTIAL')).toBe('PART PAID');
    expect(paymentStatusLabel('UNPAID')).toBe('UNPAID');
    expect(paymentStatusLabel('SOMETHING_NEW')).toBe('SOMETHING NEW'); // any other server state is shown, never hidden
  });
});

describe('change aid — a till counting aid, never a recorded fact', () => {
  it('exact cash: no change to hand back, nothing to say', () => {
    const plan = planTenders({
      totalMinor: 2888n,
      mode: 'CASH',
      cashTenderedMinor: 2888n,
      cardMinor: null,
    });
    expect(changeAid(plan, 2888n, 2)).toBeNull();
  });
  it('overpaid cash: the SERVER records only the exact tender (28.88), the aid says what to hand back and that it is not recorded', () => {
    const plan = planTenders({
      totalMinor: 2888n,
      mode: 'CASH',
      cashTenderedMinor: 5000n,
      cardMinor: null,
    });
    expect(plan).toMatchObject({ ok: true, tenders: [{ method: 'CASH', amountMinor: '2888' }] });
    const aid = changeAid(plan, 5000n, 2);
    expect(aid).toEqual({ handedOver: '50.00', recordedCash: '28.88', change: '21.12' });
  });
  it('split: change is measured against the CASH part only; 3-decimal currency keeps its exponent', () => {
    const plan = planTenders({
      totalMinor: 10_500n,
      mode: 'SPLIT',
      cashTenderedMinor: 5_000n,
      cardMinor: 6_000n,
    });
    expect(changeAid(plan, 5_000n, 2)).toEqual({
      handedOver: '50.00',
      recordedCash: '45.00',
      change: '5.00',
    });
    const kwd = planTenders({
      totalMinor: 2_100n,
      mode: 'CASH',
      cashTenderedMinor: 5_000n,
      cardMinor: null,
    });
    expect(changeAid(kwd, 5_000n, 3)).toEqual({
      handedOver: '5.000',
      recordedCash: '2.100',
      change: '2.900',
    });
  });
  it('card-only and refused plans have no aid', () => {
    expect(
      changeAid(
        planTenders({ totalMinor: 1000n, mode: 'CARD', cashTenderedMinor: null, cardMinor: null }),
        null,
        2,
      ),
    ).toBeNull();
    expect(
      changeAid(
        planTenders({ totalMinor: 1000n, mode: 'CASH', cashTenderedMinor: 10n, cardMinor: null }),
        10n,
        2,
      ),
    ).toBeNull();
  });
});

describe('seller identity → receipt header', () => {
  it('maps the server identity; blanks are "not configured" and keep the receipt marked incomplete', () => {
    expect(
      sellerFromIdentity({
        legalNameEn: ' Rose LLC ',
        trn: '100123456700003',
        registeredAddress: 'Dubai',
      }),
    ).toEqual({ name: 'Rose LLC', trn: '100123456700003', address: 'Dubai' });
    expect(
      sellerFromIdentity({ legalNameEn: 'Rose LLC', trn: '  ', registeredAddress: null }),
    ).toEqual({
      name: 'Rose LLC',
      trn: null,
      address: null,
    });
    expect(sellerFromIdentity(null)).toEqual({ name: null, trn: null, address: null });
    const m = buildReceipt({
      seller: sellerFromIdentity({ legalNameEn: 'Rose LLC', trn: null, registeredAddress: null }),
      branchName: 'Main',
      orderNumber: 'ORD-1',
      invoice: INVOICE,
      lines: [LINE({})],
      priceTaxMode: 'TAX_EXCLUSIVE',
      customerName: null,
      payments: null,
      copy: 'ORIGINAL',
    });
    expect(m).toMatchObject({ headerIncomplete: true, title: 'INVOICE' });
  });
});
