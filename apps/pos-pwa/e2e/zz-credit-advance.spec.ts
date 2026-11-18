import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * CUSTOMER CREDIT + ADVANCE PAYMENTS in a real browser against the real API and database (see run.mjs). It runs after the pilot journey, so the
 * pilot's invoice counts stay exact; its own sales are reported in E2E_CREDIT_FILE and verified in the database by run.mjs.
 *
 * Money in this shop: Rose 10.00 + 5% VAT = 10.50 each (2 roses = 21.00). Carla's credit limit is 25.00, Nadia has no credit, Amal holds a 40.00
 * advance. The CASHIER may sell on credit but may NOT apply an advance (manager authority); every rule is the server's — the till only previews.
 */
const creds = JSON.parse(readFileSync(process.env['E2E_CREDS_FILE']!, 'utf8')) as {
  slug: string;
  email: string;
  password: string;
  manager: { email: string; password: string };
};

interface CreditSale {
  label: string;
  customer: string;
  orderNumber: string;
  /** the number printed on the receipt the cashier saw — the database must hold the same one */
  invoiceNumber: string;
  taxMinor: string;
  totalMinor: string;
  owedMinor: string;
  advanceMinor: string;
  tenders: [string, string][];
}
const sales: CreditSale[] = [];
const text = async (page: Page, id: string) =>
  ((await page.getByTestId(id).textContent()) ?? '').trim();

/** report one completed sale (read from the receipt on screen) so run.mjs can verify it in the database */
async function record(
  page: Page,
  customer: string,
  sale: Omit<CreditSale, 'customer' | 'invoiceNumber' | 'taxMinor'>,
): Promise<void> {
  sales.push({
    ...sale,
    customer,
    invoiceNumber: await text(page, 'receipt-invoice-number'),
    // 5% VAT on a VAT-exclusive price: tax = total × 5 / 105 (2100 → 100, 1050 → 50)
    taxMinor: (BigInt(sale.totalMinor) / 21n).toString(),
  });
  // written after EVERY sale: a later failure must not hide the sales already made from the database cross-check
  writeFileSync(process.env['E2E_CREDIT_FILE']!, JSON.stringify({ sales }, null, 2));
}

test.describe.configure({ mode: 'serial' });

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Workspace').fill(creds.slug);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sell$/);
  await expect(page.getByTestId('tiles')).toBeVisible();
}
async function pickCustomer(page: Page, name: string): Promise<void> {
  await page.getByTestId('select-customer').click();
  await page.getByTestId('customer-search').fill(name);
  await page
    .getByTestId('customer-results')
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(page.getByTestId('select-customer')).toContainText(name);
}
async function roses(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await page.getByTestId('tile-Rose').click();
  await expect(page.getByTestId('cart-count')).toHaveText(String(n));
}
async function openCheckout(page: Page, total: string): Promise<void> {
  await page.getByTestId('charge').click();
  await expect(page.getByTestId('co-total')).toBeVisible();
  expect(await text(page, 'co-total')).toBe(total);
}
/** what the browser ACTUALLY submits to complete-sale */
function captureBodies(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/complete-sale'))
      bodies.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>);
  });
  return bodies;
}
async function signOut(page: Page): Promise<void> {
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);
}

test.beforeEach(({ page }) => {
  if (!process.env['E2E_DEBUG']) return;
  page.on('response', (r) => {
    if (r.url().includes('/v1/'))
      console.log(`[api] ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  });
});

test('cashier sells on credit: the account panel, the exact request, a lost response retried safely, a receipt that says what is owed', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await roses(page, 2);
  await pickCustomer(page, 'Carla Credit');
  await openCheckout(page, '21.00');

  // the customer's account is shown from the server (nothing owed yet, credit limit 25.00)
  await expect(page.getByTestId('account-panel')).toBeVisible();
  await expect(page.getByTestId('account-owes')).toHaveText('0.00');
  await expect(page.getByTestId('account-credit')).toContainText('25.00');
  await expect(page.getByTestId('advances-panel')).toHaveCount(0); // Carla has no advance

  await page.getByTestId('mode-CREDIT').click();
  await expect(page.getByTestId('credit-advisory')).toContainText('Within');
  expect(await text(page, 'figure-credit')).toBe('21.00');
  expect(await text(page, 'figure-paynow')).toBe('0.00');
  await expect(page.getByTestId('confirm-payment')).toContainText('on credit');

  // the first answer is lost after the server recorded the sale; the retry must replay, never sell twice
  const bodies = captureBodies(page);
  let first = true;
  await page.route('**/complete-sale', async (route) => {
    if (first) {
      first = false;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('Connection problem');
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  await page.unroute('**/complete-sale');

  // the request is the FROZEN contract and nothing else: an intent and no tender — no customer, scope, currency or override
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual({ paymentIntent: 'ON_CREDIT', tenders: [] });
  expect(bodies[1]).toEqual(bodies[0]);

  // the receipt shows what the SERVER recorded: not paid, 21.00 owed on the account
  await expect(page.getByTestId('receipt')).toContainText('Carla Credit');
  expect(await text(page, 'receipt-total')).toBe('21.00');
  expect(await text(page, 'receipt-balance-due')).toBe('21.00');
  expect(await text(page, 'receipt-status')).toBe('UNPAID');
  await expect(page.getByTestId('receipt-advance')).toHaveCount(0);
  await expect(page.getByTestId('account-after-owes')).toHaveText('21.00');
  const orderNumber = await text(page, 'receipt-order-number');
  await record(page, 'Carla Credit', {
    label: 'credit 1 (full credit, lost response retried)',
    orderNumber,
    totalMinor: '2100',
    owedMinor: '2100',
    advanceMinor: '0',
    tenders: [],
  });
  await page.getByTestId('new-sale').click();
  await signOut(page);
});

test('over the credit limit: the till warns, the SERVER refuses, a cashier cannot grant an exception, a part payment recovers the sale', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await roses(page, 1);
  await pickCustomer(page, 'Carla Credit');
  await openCheckout(page, '10.50');
  // Carla already owes 21.00 of her 25.00: only 4.00 of credit is left
  await expect(page.getByTestId('account-owes')).toHaveText('21.00');
  await expect(page.getByTestId('account-credit')).toContainText('4.00');
  await page.getByTestId('mode-CREDIT').click();
  await expect(page.getByTestId('credit-advisory')).toContainText('6.50'); // over by 6.50 — a warning, not a block
  await expect(page.getByTestId('confirm-payment')).toBeEnabled(); // the server decides

  const bodies = captureBodies(page);
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('credit limit');
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  // the reason field appears; a cashier still cannot grant the exception (owner permission + step-up): a reason alone authorises nothing
  await page.getByTestId('credit-reason').fill('regular customer, pays monthly');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toBeVisible();
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  expect(bodies[1]).toEqual({
    paymentIntent: 'ON_CREDIT',
    tenders: [],
    creditLimitExceptionReason: 'regular customer, pays monthly',
  });

  // recovery: take 7.00 cash now — the 3.50 left on credit fits the 4.00 available
  await page.getByTestId('credit-deposit').fill('7');
  await expect(page.getByTestId('credit-advisory')).toContainText('Within');
  expect(await text(page, 'figure-credit')).toBe('3.50');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  expect(await text(page, 'receipt-balance-due')).toBe('3.50');
  expect(await text(page, 'receipt-status')).toBe('PART PAID');
  await expect(page.getByTestId('receipt')).toContainText('Cash');
  await expect(page.getByTestId('account-after-owes')).toHaveText('24.50');
  const last = bodies[bodies.length - 1] as { tenders: unknown };
  expect(last.tenders).toEqual([{ method: 'CASH', amountMinor: '700' }]);
  await record(page, 'Carla Credit', {
    label: 'credit 2 (part payment after a refused over-limit sale)',
    orderNumber: await text(page, 'receipt-order-number'),
    totalMinor: '1050',
    owedMinor: '350',
    advanceMinor: '0',
    tenders: [['CASH', '700']],
  });
  await page.getByTestId('new-sale').click();
  await signOut(page);
});

test('a customer without credit: the till says so and the server refuses; nothing is recorded', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await roses(page, 1);
  await pickCustomer(page, 'Nadia Nocredit');
  await openCheckout(page, '10.50');
  await page.getByTestId('mode-CREDIT').click();
  await expect(page.getByTestId('credit-advisory')).toContainText('not enabled');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('Credit is not enabled');
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  // she can still pay now
  await page.getByTestId('mode-CARD').click();
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  await record(page, 'Nadia Nocredit', {
    label: 'credit 3 (no-credit customer pays by card)',
    orderNumber: await text(page, 'receipt-order-number'),
    totalMinor: '1050',
    owedMinor: '0',
    advanceMinor: '0',
    tenders: [['CARD_TERMINAL', '1050']],
  });
  await page.getByTestId('new-sale').click();
  await signOut(page);
});

test('a cashier cannot apply a customer advance: the till names the missing authority and nothing is spent', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await roses(page, 2);
  await pickCustomer(page, 'Amal Advance');
  await openCheckout(page, '21.00');
  // the cashier can SEE the advance (receivables:view) …
  await expect(page.getByTestId('account-advances')).toHaveText('40.00');
  await expect(page.getByTestId('advances-panel')).toBeVisible();
  await page.getByTestId('advance-use-0').click();
  await expect(page.getByTestId('advance-input-0')).toHaveValue('21.00');
  await expect(page.getByTestId('advance-covers')).toBeVisible();
  // … but applying it is a manager authority
  const bodies = captureBodies(page);
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('needs a manager');
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  expect(bodies[0]).toEqual({
    paymentIntent: 'PAY_NOW',
    tenders: [],
    advanceApplications: [
      { advanceId: expect.stringMatching(/^[0-9a-f-]{36}$/), amountMinor: '2100' },
    ],
  });
  await page.getByRole('button', { name: 'Close' }).click(); // leave the checkout dialog (nothing was recorded) before signing out
  await signOut(page);
});

test('a manager spends part of the advance and pays the rest in cash; then an advance-only sale', async ({
  page,
}) => {
  await login(page, creds.manager.email, creds.manager.password);

  // ── part advance + cash ──
  await roses(page, 2);
  await pickCustomer(page, 'Amal Advance');
  await openCheckout(page, '21.00');
  await expect(page.getByTestId('account-advances')).toHaveText('40.00');
  await page.getByTestId('advance-input-0').fill('10');
  expect(await text(page, 'left-to-pay')).toContain('11.00');
  await page.getByTestId('cash-received').fill('11');
  expect(await text(page, 'figure-advance')).toBe('10.00');
  expect(await text(page, 'figure-paynow')).toBe('11.00');
  const bodies = captureBodies(page);
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  expect(bodies[0]).toEqual({
    paymentIntent: 'PAY_NOW',
    tenders: [{ method: 'CASH', amountMinor: '1100' }],
    advanceApplications: [
      { advanceId: expect.stringMatching(/^[0-9a-f-]{36}$/), amountMinor: '1000' },
    ],
  });
  expect(await text(page, 'receipt-advance')).toBe('10.00');
  await expect(page.getByTestId('receipt')).toContainText('Cash');
  expect(await text(page, 'receipt-status')).toBe('PAID');
  await expect(page.getByTestId('receipt-balance-due')).toHaveCount(0);
  await expect(page.getByTestId('account-after-advances')).toHaveText('30.00');
  await record(page, 'Amal Advance', {
    label: 'advance 1 (advance 10.00 + cash 11.00)',
    orderNumber: await text(page, 'receipt-order-number'),
    totalMinor: '2100',
    owedMinor: '0',
    advanceMinor: '1000',
    tenders: [['CASH', '1100']],
  });
  await page.getByTestId('new-sale').click();

  // ── the advance covers the whole sale ──
  await roses(page, 2);
  await pickCustomer(page, 'Amal Advance');
  await openCheckout(page, '21.00');
  await expect(page.getByTestId('account-advances')).toHaveText('30.00');
  await page.getByTestId('advance-use-0').click();
  await expect(page.getByTestId('advance-covers')).toBeVisible();
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  expect(await text(page, 'receipt-advance')).toBe('21.00');
  expect(await text(page, 'receipt-status')).toBe('PAID');
  await expect(page.getByTestId('account-after-advances')).toHaveText('9.00');
  await record(page, 'Amal Advance', {
    label: 'advance 2 (advance-only)',
    orderNumber: await text(page, 'receipt-order-number'),
    totalMinor: '2100',
    owedMinor: '0',
    advanceMinor: '2100',
    tenders: [],
  });
  await page.getByTestId('new-sale').click();

  // ── advance + card deposit + the rest on credit: the three parts add up to the total ──
  await roses(page, 2);
  await pickCustomer(page, 'Amal Advance');
  await openCheckout(page, '21.00');
  await page.getByTestId('advance-use-0').click(); // the remaining 9.00
  await page.getByTestId('mode-CREDIT').click();
  await page.getByTestId('credit-deposit').fill('2');
  await page.getByTestId('deposit-CARD').click();
  expect(await text(page, 'figure-advance')).toBe('9.00');
  expect(await text(page, 'figure-paynow')).toBe('2.00');
  expect(await text(page, 'figure-credit')).toBe('10.00');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  expect(await text(page, 'receipt-advance')).toBe('9.00');
  expect(await text(page, 'receipt-balance-due')).toBe('10.00');
  expect(await text(page, 'receipt-status')).toBe('PART PAID');
  await expect(page.getByTestId('account-after-owes')).toHaveText('10.00');
  await expect(page.getByTestId('account-after-advances')).toHaveText('0.00');
  await record(page, 'Amal Advance', {
    label: 'advance 3 (advance 9.00 + card 2.00 + credit 10.00)',
    orderNumber: await text(page, 'receipt-order-number'),
    totalMinor: '2100',
    owedMinor: '1000',
    advanceMinor: '900',
    tenders: [['CARD_TERMINAL', '200']],
  });
  await page.getByTestId('new-sale').click();
  await signOut(page);

  writeFileSync(process.env['E2E_CREDIT_FILE']!, JSON.stringify({ sales }, null, 2));
});
