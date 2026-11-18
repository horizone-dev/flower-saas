import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * CUSTOMER ACCOUNT + CREDIT COLLECTION in a real browser against the real API and database (see run.mjs). Runs after the pilot / owner journeys (their
 * counts stay exact); its own results are written to E2E_COLLECTION_FILE and verified in the database by run.mjs.
 *
 * Money: Rose 10.00 + 5% VAT = 10.50. Dora Debtor (credit enabled, no limit) buys 2 roses (21.00) then 1 rose (10.50) ON CREDIT → owes 31.50. The
 * cashier collects 15.00 cash (a lost response retried), the manager collects the rest 16.50 by bank transfer. Nora holds a 5.00 advance and owes nothing.
 */
const creds = JSON.parse(readFileSync(process.env['E2E_CREDS_FILE']!, 'utf8')) as {
  slug: string;
  email: string;
  password: string;
  manager: { email: string; password: string };
};

interface Collected {
  label: string;
  customer: string;
  paymentId: string;
  amountMinor: string;
  method: string;
  /** invoice number → amount, in the order the receipt listed them */
  allocations: [string, string][];
  balanceAfterMinor: string;
}
const result: {
  sales: { label: string; orderNumber: string; invoiceNumber: string; totalMinor: string }[];
  collections: Collected[];
} = { sales: [], collections: [] };
const flush = (): void =>
  writeFileSync(process.env['E2E_COLLECTION_FILE']!, JSON.stringify(result, null, 2));

const text = async (page: Page, id: string) =>
  ((await page.getByTestId(id).textContent()) ?? '').trim();

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
async function signOut(page: Page): Promise<void> {
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);
}
async function sellOnCredit(
  page: Page,
  roses: number,
  total: string,
  label: string,
): Promise<void> {
  for (let i = 0; i < roses; i += 1) await page.getByTestId('tile-Rose').click();
  await page.getByTestId('select-customer').click();
  await page.getByTestId('customer-search').fill('Dora');
  await page
    .getByTestId('customer-results')
    .getByRole('button', { name: /Dora Debtor/ })
    .click();
  await page.getByTestId('charge').click();
  await expect(page.getByTestId('co-total')).toBeVisible();
  expect(await text(page, 'co-total')).toBe(total);
  await page.getByTestId('mode-CREDIT').click();
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  result.sales.push({
    label,
    orderNumber: await text(page, 'receipt-order-number'),
    invoiceNumber: await text(page, 'receipt-invoice-number'),
    totalMinor: total.replace('.', ''),
  });
  flush();
  await page.getByTestId('new-sale').click();
}
async function openAccount(page: Page, name: string, search: string): Promise<void> {
  await page.getByRole('link', { name: 'Customers' }).click();
  await expect(page).toHaveURL(/\/customers$/);
  await page.getByTestId('cust-search').fill(search);
  await page.getByTestId(`cust-row-${name}`).click();
  await expect(page.getByTestId('acct-name')).toHaveText(name);
}

test.beforeEach(({ page }) => {
  if (!process.env['E2E_DEBUG']) return;
  page.on('response', (r) => {
    if (r.url().includes('/v1/'))
      console.log(`[api] ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  });
});

test('setup: a cashier sells to Dora on credit twice (21.00 then 10.50) — she now owes 31.50', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await sellOnCredit(page, 2, '21.00', 'Dora credit sale 1 (2 roses)');
  await sellOnCredit(page, 1, '10.50', 'Dora credit sale 2 (1 rose)');
  await signOut(page);
});

test('the account: balance, open invoices with amounts and status, statement, credit — read from the server', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await openAccount(page, 'Dora Debtor', 'Dora');
  const [inv1, inv2] = result.sales.map((s) => s.invoiceNumber);
  expect(await text(page, 'acct-owes')).toBe('31.50');
  expect(await text(page, 'acct-open-count')).toBe('2');
  await expect(page.getByTestId('acct-credit')).toHaveText('no limit set');
  const rows = page.getByTestId('acct-invoices').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  // oldest first, the server's own order; each invoice: total / paid / owes / status
  await expect(rows.nth(0)).toContainText(inv1!);
  await expect(rows.nth(0)).toContainText('21.00');
  await expect(rows.nth(0).getByTestId('acct-inv-status')).toHaveText('UNPAID');
  await expect(rows.nth(1)).toContainText(inv2!);
  await expect(rows.nth(1).getByTestId('acct-inv-owes')).toHaveText('10.50');
  // the statement shows both invoices, newest first, with the server's signs
  const stmt = page.getByTestId('acct-statement');
  await expect(stmt).toContainText('Invoice');
  await expect(stmt).toContainText('+21.00');
  await expect(stmt).toContainText('+10.50');
  // collection is offered to this session (receivables:collect)
  await expect(page.getByTestId('acct-collect')).toBeVisible();
  await signOut(page);
});

test('cashier collects 15.00 cash: oldest invoice first, a lost response retried safely (ONE payment), receipt from server values, reprint as COPY', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await openAccount(page, 'Dora Debtor', 'Dora');
  const [inv1, inv2] = result.sales.map((s) => s.invoiceNumber);
  await page.getByTestId('acct-collect').click();
  expect(await text(page, 'collect-owes')).toBe('31.50');

  // only the methods the frozen contract accepts — never card
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(page.getByTestId('collect-method-CASH')).toBeVisible();
  await expect(page.getByTestId('collect-method-BANK_TRANSFER')).toBeVisible();
  await expect(page.getByTestId('collect-method-OTHER_MANUAL')).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText(/card/i);
  // E-5 is inactive: the till says so and does not claim register integration
  await expect(page.getByTestId('collect-register-note')).toContainText('not yet linked');

  // over-collection is stopped at the till (the server would keep the excess as unapplied money)
  await page.getByTestId('collect-amount').fill('99');
  await expect(page.getByTestId('collect-refusal')).toContainText('more than the customer owes');
  await expect(page.getByTestId('collect-confirm')).toBeDisabled();
  await page.getByTestId('collect-amount').fill('15');
  await expect(page.getByTestId('collect-preview')).toContainText('16.50');
  await expect(page.getByTestId('collect-confirm')).toBeEnabled();

  // what the browser ACTUALLY submits
  const requests: { body: unknown; key: string | undefined }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/receipts'))
      requests.push({
        body: JSON.parse(r.postData() ?? '{}'),
        key: r.headers()['idempotency-key'],
      });
  });
  await page.evaluate(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed += 1;
    };
  });
  // the server records the payment, the answer is lost, the cashier presses Confirm again
  let first = true;
  await page.route('**/receipts', async (route) => {
    if (first && route.request().method() === 'POST') {
      first = false;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await page.getByTestId('collect-confirm').click();
  await expect(page.getByTestId('collect-error')).toContainText('may or may not');
  await expect(page.getByTestId('collect-complete')).toHaveCount(0);
  await page.getByTestId('collect-confirm').click();
  await expect(page.getByTestId('collect-complete')).toBeVisible();
  await page.unroute('**/receipts');

  expect(requests).toHaveLength(2);
  expect(requests[0]!.body).toEqual({ amountMinor: '1500', method: 'CASH' });
  expect(requests[1]!.body).toEqual(requests[0]!.body);
  expect(requests[0]!.key).toBeTruthy();
  expect(requests[1]!.key).toBe(requests[0]!.key); // same Idempotency-Key → the server replays, never collects twice

  // the receipt: SERVER values only
  const receipt = page.getByTestId('collect-receipt');
  await expect(receipt).toContainText('PAYMENT RECEIPT');
  await expect(receipt).toContainText('100123456700003'); // seller TRN
  await expect(receipt).toContainText('Shop 4, Rose Street');
  expect(await text(page, 'collect-receipt-customer')).toBe('Dora Debtor');
  expect(await text(page, 'collect-receipt-amount')).toBe('15.00');
  await expect(receipt).toContainText('Cash');
  expect(await text(page, 'collect-receipt-alloc-ref-0')).toBe(inv1);
  expect(await text(page, 'collect-receipt-alloc-amount-0')).toBe('15.00');
  await expect(page.getByTestId('collect-receipt-alloc-ref-1')).toHaveCount(0); // the newer invoice is untouched
  expect(await text(page, 'collect-receipt-balance')).toBe('16.50');
  await expect(page.getByTestId('collect-receipt-date')).toContainText('UTC');
  await expect(receipt).not.toContainText(/register|drawer|shift/i);
  const paymentId = (await receipt.getAttribute('data-payment-id'))!;
  expect(await text(page, 'collect-receipt-reference')).toBe(paymentId.slice(0, 8));
  result.collections.push({
    label: 'collection 1 (cashier, cash 15.00, response lost then retried)',
    customer: 'Dora Debtor',
    paymentId,
    amountMinor: '1500',
    method: 'CASH',
    allocations: [[inv1!, '1500']],
    balanceAfterMinor: '1650',
  });
  flush();

  await page.getByTestId('collect-print').click();
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  // print medium: only the receipt, and it fits an 80 mm roll
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.getByTestId('acct-page')).toBeHidden();
  await expect(receipt).toBeVisible();
  const printed = (await receipt.innerText()).replace(/\s+/g, ' ');
  for (const needle of [
    'PAYMENT RECEIPT',
    'Dora Debtor',
    'Cash',
    '15.00',
    inv1!,
    'Balance after',
    '16.50',
    paymentId.slice(0, 8),
  ])
    expect(printed, needle).toContain(needle);
  expect((await receipt.boundingBox())!.width).toBeLessThanOrEqual(72 * 3.7795 + 1);
  await page.emulateMedia({ media: 'screen' });
  await page.getByTestId('collect-done').click();

  // the account moved: one payment applied, first invoice PART PAID, second untouched
  await expect(page.getByTestId('acct-owes')).toHaveText('16.50');
  const rows = page.getByTestId('acct-invoices').locator('tbody tr');
  await expect(rows.nth(0).getByTestId('acct-inv-owes')).toHaveText('6.00');
  await expect(rows.nth(0).getByTestId('acct-inv-status')).toHaveText('PART PAID');
  await expect(rows.nth(1).getByTestId('acct-inv-status')).toHaveText('UNPAID');
  await expect(page.getByTestId('acct-payments').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('acct-payments')).toContainText('15.00');

  // reprint: the same server values, marked COPY
  await expect(page.getByTestId('acct-reprints').locator('li')).toHaveCount(1);
  await page.getByTestId('reprint-0').click();
  await expect(page.getByTestId('collect-receipt-title')).toContainText('(COPY)');
  expect(await text(page, 'collect-receipt-amount')).toBe('15.00');
  expect(await text(page, 'collect-receipt-reference')).toBe(paymentId.slice(0, 8));
  expect(await text(page, 'collect-receipt-balance')).toBe('16.50');
  await page.getByTestId('reprint-close').click();
  void inv2;
  await signOut(page);
});

test('a manager collects the rest (16.50) by bank transfer: both invoices are settled, balance 0.00; the previous user’s receipts are gone', async ({
  page,
}) => {
  await login(page, creds.manager.email, creds.manager.password);
  await openAccount(page, 'Dora Debtor', 'Dora');
  const [inv1, inv2] = result.sales.map((s) => s.invoiceNumber);
  await expect(page.getByTestId('acct-owes')).toHaveText('16.50');
  // the cashier's kept receipts were cleared at sign-out (a shared till)
  await expect(page.getByTestId('acct-reprints')).toHaveCount(0);

  await page.getByTestId('acct-collect').click();
  await page.getByTestId('collect-method-BANK_TRANSFER').click();
  await expect(page.getByTestId('collect-register-note')).toHaveCount(0); // not a cash tender
  await page.getByTestId('collect-full').click();
  await expect(page.getByTestId('collect-amount')).toHaveValue('16.50');
  await page.getByTestId('collect-confirm').click();
  await expect(page.getByTestId('collect-complete')).toBeVisible();

  const receipt = page.getByTestId('collect-receipt');
  await expect(receipt).toContainText('Bank transfer');
  expect(await text(page, 'collect-receipt-amount')).toBe('16.50');
  expect(await text(page, 'collect-receipt-alloc-ref-0')).toBe(inv1);
  expect(await text(page, 'collect-receipt-alloc-amount-0')).toBe('6.00'); // what was left on the oldest invoice
  expect(await text(page, 'collect-receipt-alloc-ref-1')).toBe(inv2);
  expect(await text(page, 'collect-receipt-alloc-amount-1')).toBe('10.50');
  expect(await text(page, 'collect-receipt-balance')).toBe('0.00');
  const paymentId = (await receipt.getAttribute('data-payment-id'))!;
  result.collections.push({
    label: 'collection 2 (manager, bank transfer 16.50, clears the account)',
    customer: 'Dora Debtor',
    paymentId,
    amountMinor: '1650',
    method: 'BANK_TRANSFER',
    allocations: [
      [inv1!, '600'],
      [inv2!, '1050'],
    ],
    balanceAfterMinor: '0',
  });
  flush();
  await page.getByTestId('collect-done').click();

  await expect(page.getByTestId('acct-owes')).toHaveText('0.00');
  await expect(page.getByTestId('acct-no-invoices')).toBeVisible();
  await expect(page.getByTestId('acct-collect')).toHaveCount(0); // nothing owed → nothing to collect
  await expect(page.getByTestId('acct-payments').locator('li')).toHaveCount(3); // 15.00 + 6.00 + 10.50 applied
  await page.reload(); // survives a reload: the receipt copy is kept for this session only
  await expect(page.getByTestId('acct-reprints').locator('li')).toHaveCount(1);
  await signOut(page);
});

test('an account with an advance and nothing owed: advance shown, no collect button; opening it needs only view permissions', async ({
  page,
}) => {
  await login(page, creds.email, creds.password);
  await openAccount(page, 'Nora Prepaid', 'Nora');
  expect(await text(page, 'acct-owes')).toBe('0.00');
  expect(await text(page, 'acct-advances')).toBe('5.00');
  await expect(page.getByTestId('acct-advance-list')).toContainText('5.00');
  await expect(page.getByTestId('acct-no-invoices')).toBeVisible();
  await expect(page.getByTestId('acct-collect')).toHaveCount(0);
  await signOut(page);
});
