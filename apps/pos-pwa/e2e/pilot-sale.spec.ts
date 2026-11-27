import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * THE PILOT JOURNEY in a real browser against the real API and database (see run.mjs):
 * Staff login → product search → add to cart → select customer → checkout → payment (cash; split card + cash, with a lost response and a safe
 * retry) → invoice with VAT → receipt → sales history → receipt reprint → sign out.
 */
const creds = JSON.parse(readFileSync(process.env['E2E_CREDS_FILE']!, 'utf8')) as {
  slug: string;
  email: string;
  password: string;
};

interface Sale {
  label: string;
  orderNumber: string;
  totalMinor: string;
  taxMinor: string;
  tenders: [string, string][];
}
const sales: Sale[] = [];
const text = async (page: Page, id: string) =>
  ((await page.getByTestId(id).textContent()) ?? '').trim();

test.describe.configure({ mode: 'serial' });

// diagnostics for a failing run: every API call the browser makes, with its status (set E2E_DEBUG=1)
test.beforeEach(({ page }) => {
  if (!process.env['E2E_DEBUG']) return;
  page.on('response', (r) => {
    if (r.url().includes('/v1/'))
      console.log(`[api] ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  });
  page.on('requestfailed', (r) =>
    console.log(`[api] FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`),
  );
  page.on('console', (m) => console.log(`[console] ${m.type()} ${m.text()}`));
});

test('anonymous visitors are sent to the login page; a wrong password is refused', async ({
  page,
}) => {
  await page.goto('/sell');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Workspace').fill(creds.slug);
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.error')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('cashier journey: login → search → cart → customer → cash checkout with VAT → receipt → history → reprint → sign out', async ({
  page,
}) => {
  // ── staff login ──
  await page.goto('/login');
  await page.getByLabel('Workspace').fill(creds.slug);
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sell$/);
  await expect(page.getByTestId('tiles')).toBeVisible();

  // ── the catalog shows server prices; search filters ──
  await expect(page.getByTestId('tile-Rose')).toContainText('10.00');
  await expect(page.getByTestId('tile-Tulip')).toContainText('7.50');
  await page.getByTestId('product-search').fill('tul');
  await expect(page.getByTestId('tile-Tulip')).toBeVisible();
  await expect(page.getByTestId('tile-Rose')).toHaveCount(0);
  await page.getByTestId('product-search').fill('zzz');
  await expect(page.getByTestId('tiles').locator('li')).toHaveCount(0);
  await page.getByTestId('product-search').fill('');

  // ── cart: 2 roses + 1 tulip; quantity controls ──
  await page.getByTestId('tile-Rose').click();
  await page.getByTestId('tile-Rose').click();
  await page.getByTestId('tile-Tulip').click();
  await expect(page.getByTestId('cart-count')).toHaveText('3');
  await page.getByRole('button', { name: 'Add one Tulip' }).click();
  await page.getByRole('button', { name: 'Remove one Tulip' }).click();
  await expect(page.getByTestId('qty-Tulip')).toHaveText('1');
  await expect(page.getByTestId('estimate')).toContainText('27.50');

  // ── customer ──
  await page.getByTestId('select-customer').click();
  await page.getByTestId('customer-search').fill('Customer 1');
  await page
    .getByTestId('customer-results')
    .getByRole('button', { name: /Customer 1/ })
    .click();
  await expect(page.getByTestId('select-customer')).toContainText('Customer 1');

  // ── checkout: the SERVER's totals with 5% VAT (line rounding: 1.00 + 0.38) ──
  await page.getByTestId('charge').click();
  await expect(page.getByTestId('co-total')).toBeVisible();
  expect(await text(page, 'co-subtotal')).toBe('27.50');
  expect(await text(page, 'co-vat')).toBe('1.38');
  expect(await text(page, 'co-total')).toBe('28.88');
  await expect(page.getByTestId('confirm-payment')).toBeDisabled(); // no cash entered yet
  await page.getByTestId('cash-received').fill('20');
  await expect(page.getByTestId('confirm-payment')).toBeDisabled(); // short
  await page.getByTestId('cash-received').fill('50');
  expect(await text(page, 'change-due')).toContain('21.12');
  await page.evaluate(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed += 1;
    };
  });
  // what the browser ACTUALLY submits: the exact-tender contract — CASH for the amount due (28.88), never the 50.00 handed over
  const completeBodies: { tenders: { method: string; amountMinor: string }[] }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/complete-sale'))
      completeBodies.push(JSON.parse(r.postData() ?? '{}'));
  });
  await page.getByTestId('confirm-payment').click();

  // ── invoice + receipt ──
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  const receipt = page.getByTestId('receipt');
  await expect(receipt).toContainText('TAX INVOICE');
  await expect(receipt).toContainText('100123456700003'); // the seller TRN, read by the CASHIER through F-3
  await expect(receipt).toContainText('Shop 4, Rose Street');
  await expect(page.getByTestId('receipt-incomplete')).toHaveCount(0);
  expect(await text(page, 'receipt-total')).toBe('28.88');
  expect(await text(page, 'receipt-vat')).toBe('1.38');
  expect(await text(page, 'receipt-subtotal')).toBe('27.50');
  expect(completeBodies).toHaveLength(1);
  expect(completeBodies[0]!.tenders).toEqual([{ method: 'CASH', amountMinor: '2888' }]);
  expect(JSON.stringify(completeBodies[0])).not.toMatch(/5000|2112|change|tendered/i);
  // the change is an ON-SCREEN counting aid that says it is not recorded; the invoice itself carries only recorded figures
  expect(await text(page, 'aid-change')).toBe('21.12');
  await expect(page.getByTestId('change-aid')).toContainText('NOT recorded');
  await expect(receipt).not.toContainText(/Cash received|Change/);
  await expect(receipt).toContainText('Cash');
  expect(await text(page, 'receipt-total')).toBe('28.88');
  expect(await text(page, 'receipt-status')).toBe('PAID');
  await expect(receipt).toContainText('Customer 1');
  await expect(receipt).toContainText('Rose');
  await expect(receipt).toContainText('VAT 5%');
  const invoiceNumber = await text(page, 'receipt-invoice-number');
  expect(invoiceNumber).not.toBe('');
  const orderNumber1 = await text(page, 'receipt-order-number');
  sales.push({
    label: 'sale 1 (cash, customer)',
    orderNumber: orderNumber1,
    totalMinor: '2888',
    taxMinor: '138',
    tenders: [['CASH', '2888']],
  });
  await page.getByTestId('print').click();
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

  // print layout: only the receipt remains
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.getByTestId('change-aid')).toBeHidden(); // the counting aid is never printed
  await expect(receipt).toBeVisible();
  // what the PRINT medium actually contains: the legal invoice content, and it fits a 80 mm roll (72 mm printable)
  const printed = (await receipt.innerText()).replace(/\s+/g, ' ');
  for (const needle of [
    'TAX INVOICE',
    'TRN 100123456700003',
    'Shop 4, Rose Street',
    invoiceNumber,
    'VAT 5%',
    'TOTAL AED 28.88',
    'Cash 28.88',
  ])
    expect(printed, needle).toContain(needle);
  expect(printed).not.toMatch(/Cash received|Change/);
  const box = (await receipt.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(72 * 3.7795 + 1); // 72 mm in CSS px (+1 px rounding)
  // Chromium's own print pipeline renders it to a single 80 mm page (browser PDF output — NOT a physical-printer test)
  const pdf = await page.pdf({
    width: '80mm',
    margin: { top: '4mm', bottom: '4mm', left: '4mm', right: '4mm' },
  });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
  await page.emulateMedia({ media: 'screen' });

  // ── new sale starts empty ──
  await page.getByTestId('new-sale').click();
  await expect(page.getByTestId('cart-count')).toHaveText('0');
  await expect(page.getByTestId('select-customer')).toContainText('walk-in');

  // ── split payment, and a LOST RESPONSE: the server records the sale, the browser never hears; the retry must not sell twice ──
  await page.getByTestId('tile-Rose').click();
  await page.getByTestId('charge').click();
  await expect(page.getByTestId('co-total')).toBeVisible();
  expect(await text(page, 'co-total')).toBe('10.50');
  await page.getByTestId('mode-SPLIT').click();
  await page.getByTestId('card-amount').fill('6');
  await page.getByTestId('cash-received').fill('5');
  expect(await text(page, 'change-due')).toContain('0.50');
  let first = true;
  await page.route('**/complete-sale', async (route) => {
    if (first) {
      first = false;
      await route.fetch(); // the server processes the sale …
      await route.abort('connectionreset'); // … and the answer is lost
      return;
    }
    await route.continue();
  });
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('Connection problem');
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  await page.getByTestId('confirm-payment').click(); // the safe retry: same Idempotency-Key → the server replays
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  expect(await text(page, 'receipt-total')).toBe('10.50');
  expect(await text(page, 'receipt-vat')).toBe('0.50');
  const orderNumber2 = await text(page, 'receipt-order-number');
  expect(orderNumber2).not.toBe(orderNumber1);
  sales.push({
    label: 'sale 2 (split card + cash, retried)',
    orderNumber: orderNumber2,
    totalMinor: '1050',
    taxMinor: '50',
    tenders: [
      ['CARD_TERMINAL', '600'],
      ['CASH', '450'],
    ],
  });
  await page.unroute('**/complete-sale');
  await page.getByTestId('new-sale').click();

  // ── sales history + reprint ──
  await page.getByRole('link', { name: 'Sales' }).click();
  await expect(page.getByTestId('sales-list')).toBeVisible();
  await expect(page.getByTestId(`sale-${orderNumber1}`)).toBeVisible();
  await expect(page.getByTestId(`sale-${orderNumber2}`)).toBeVisible();
  await expect(page.getByTestId('sales-list').locator('li')).toHaveCount(2); // the retried sale appears ONCE
  await page.getByTestId(`sale-${orderNumber1}`).click();
  await expect(page.getByTestId('receipt')).toContainText('(COPY)');
  expect(await text(page, 'receipt-total')).toBe('28.88');
  expect(await text(page, 'receipt-vat')).toBe('1.38');
  expect(await text(page, 'receipt-invoice-number')).toBe(invoiceNumber);
  await expect(page.getByTestId('receipt')).not.toContainText(/Cash received|Change/); // the reprint agrees with the original
  await expect(page.getByTestId('reprint')).toBeVisible();

  // ── sign out; the till is closed again ──
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/sales');
  await expect(page).toHaveURL(/\/login$/);

  writeFileSync(process.env['E2E_RESULT_FILE']!, JSON.stringify({ sales }, null, 2));
});
