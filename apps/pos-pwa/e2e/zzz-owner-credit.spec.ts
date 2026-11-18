import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * OWNER WEB CUSTOMER CREDIT MANAGEMENT, end to end in real browsers against the real API and database (see run.mjs, `E2E_FOCUS=owner`).
 *
 * The owner switches credit on for Olive in Owner Web (a version-guarded, step-up gated save), and the CASHIER's till honours it: refused while credit
 * is off, accepted inside the limit, refused over it, accepted again once the owner raises the limit, refused again once the owner turns credit off.
 * Owner Web then shows what the SERVER holds: the balance, the available credit, the open invoice (the number printed on the cashier's receipt) and the
 * receivables report. A stale tab is refused with a version-conflict message and changes nothing; a manager (who may view customers but may not manage
 * credit) sees no way to change it.
 *
 * Money: Rose 10.00 + 5% VAT = 10.50 each. Olive starts with credit OFF and no limit. Results (sales, successful saves) go to E2E_OWNER_CREDIT_FILE
 * and run.mjs verifies them against the DATABASE: invoices, account version, audit rows, receivable control in the ledger.
 */
const creds = JSON.parse(readFileSync(process.env['E2E_CREDS_FILE']!, 'utf8')) as {
  slug: string;
  email: string;
  password: string;
  companyId: string;
  manager: { email: string; password: string };
  owner: { email: string; password: string; totpSecret: string };
};
const OWNER = 'http://localhost:3400';
const POS = 'http://localhost:3300';
const OLIVE = 'Olive Owner-Credit';
const ONLY_THIS_SPEC = process.env['E2E_FOCUS'] === 'owner';

interface Sale {
  label: string;
  invoiceNumber: string;
  totalMinor: string;
}
const result = {
  sales: [] as Sale[],
  saves: [] as { label: string; enabled: boolean; limitMinor: string | null }[],
  refusedSales: 0,
  final: null as { enabled: boolean; limitMinor: string | null } | null,
  owedAtEndMinor: '0',
};
const flush = (): void =>
  writeFileSync(process.env['E2E_OWNER_CREDIT_FILE']!, JSON.stringify(result, null, 2));

const text = async (page: Page, id: string) =>
  ((await page.getByTestId(id).textContent()) ?? '').trim();

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — the same code an authenticator app would show */
function totp(secretBase32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, ''))
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const n = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}
/** a code that has not been used yet: the server refuses a replayed code, so wait for the next 30-second window when needed */
let lastCode = '';
async function freshCode(secret: string): Promise<string> {
  for (let i = 0; i < 70; i += 1) {
    const c = totp(secret);
    if (c !== lastCode) {
      lastCode = c;
      return c;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no fresh authenticator code became available');
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000); // an authenticator code may have to wait for the next 30-second window

// ───────────────────────── POS (the cashier) ─────────────────────────
async function posLogin(page: Page): Promise<void> {
  await page.goto(`${POS}/login`);
  await page.getByLabel('Workspace').fill(creds.slug);
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sell$/);
  await expect(page.getByTestId('tiles')).toBeVisible();
}
async function posChargeOlive(page: Page, roses: number, total: string): Promise<void> {
  for (let i = 0; i < roses; i += 1) await page.getByTestId('tile-Rose').click();
  await expect(page.getByTestId('cart-count')).toHaveText(String(roses));
  await page.getByTestId('select-customer').click();
  await page.getByTestId('customer-search').fill(OLIVE);
  await page
    .getByTestId('customer-results')
    .getByRole('button', { name: new RegExp(OLIVE) })
    .click();
  await expect(page.getByTestId('select-customer')).toContainText(OLIVE);
  await page.getByTestId('charge').click();
  await expect(page.getByTestId('co-total')).toBeVisible();
  expect(await text(page, 'co-total')).toBe(total);
}
async function posLeave(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close' }).click(); // nothing was recorded: leave the checkout before signing out
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);
}

// ───────────────────────── Owner Web (the owner) ─────────────────────────
let ownerCtx: BrowserContext | null = null;
let ownerPage: Page | null = null;
let oliveUrl = '';

/** Owner Web asks for a fresh authenticator code (step-up) before some screens and saves; answer it when it appears */
async function stepUpIfAsked(page: Page, landed: Locator): Promise<boolean> {
  const stepUp = page.getByRole('heading', { name: 'Confirm it is you' });
  await stepUp.or(landed).first().waitFor();
  if (!(await stepUp.isVisible())) return false;
  await page.getByLabel('Authenticator code').fill(await freshCode(creds.owner.totpSecret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await landed.first().waitFor();
  return true;
}
async function ownerSession(browser: import('@playwright/test').Browser): Promise<Page> {
  if (ownerPage) return ownerPage;
  ownerCtx = await browser.newContext({ baseURL: OWNER });
  const o = await ownerCtx.newPage();
  await o.goto('/customers');
  await expect(o).toHaveURL(/\/login$/);
  await o.getByLabel('Workspace').fill(creds.slug);
  await o.getByLabel('Email').fill(creds.owner.email);
  await o.getByLabel('Password').fill(creds.owner.password);
  await o
    .getByLabel('Authenticator code (if enabled)')
    .fill(await freshCode(creds.owner.totpSecret));
  await o.getByRole('button', { name: 'Sign in' }).click();
  await expect(o).toHaveURL(/\/products$/);
  // two companies in this workspace: Owner Web never guesses
  await o.goto('/company');
  const use = o.getByTestId(`use-company-${creds.companyId}`);
  await stepUpIfAsked(o, use);
  await use.click();
  await expect(o).toHaveURL(/\/products$/);
  ownerPage = o;
  return o;
}
async function openOlive(page: Page): Promise<void> {
  if (oliveUrl) {
    await page.goto(oliveUrl);
  } else {
    await page.goto('/customers');
    await stepUpIfAsked(page, page.getByTestId('customer-link').first());
    await page.getByLabel('Search by name').fill('Olive');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByTestId('customer-link').filter({ hasText: OLIVE }).click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
    oliveUrl = page.url().replace(OWNER, '');
  }
  await stepUpIfAsked(page, page.getByTestId('credit-state'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(OLIVE);
}
/** fill the credit form and save; if Owner Web asks for a fresh authenticator code, answer it and save again (the form is re-read from the server) */
async function saveCredit(page: Page, want: { enabled: boolean; limit: string }): Promise<void> {
  const fill = async (): Promise<void> => {
    const box = page.getByTestId('credit-enabled');
    if ((await box.isChecked()) !== want.enabled) await box.setChecked(want.enabled);
    await page.getByTestId('credit-limit-input').fill(want.limit);
    await page.getByTestId('credit-save').click();
  };
  await fill();
  const stepUp = page.getByRole('heading', { name: 'Confirm it is you' });
  const flash = page.getByTestId('flash-ok').or(page.getByTestId('flash-error'));
  await stepUp.or(flash).first().waitFor();
  if (await stepUp.isVisible()) {
    await page.getByLabel('Authenticator code').fill(await freshCode(creds.owner.totpSecret));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.getByTestId('credit-form').waitFor();
    await fill();
    await flash.first().waitFor();
  }
}

test.afterAll(async () => {
  await ownerCtx?.close();
});

test('cashier: credit is OFF for Olive — the till says so, the server refuses, nothing is recorded', async ({
  page,
}) => {
  await posLogin(page);
  await posChargeOlive(page, 1, '10.50');
  await page.getByTestId('mode-CREDIT').click();
  await expect(page.getByTestId('credit-advisory')).toContainText('not enabled');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('Credit is not enabled');
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  result.refusedSales += 1;
  flush();
  await posLeave(page);
});

test('owner: Olive’s page shows credit OFF; switching it on with a 25.00 limit is saved by the server (after an authenticator code) and shown back', async ({
  browser,
}) => {
  const o = await ownerSession(browser);
  await openOlive(o);
  await expect(o.getByTestId('credit-state')).toContainText('Credit is OFF');
  await expect(o.getByTestId('credit-limit')).toHaveText('No limit set');
  await expect(o.getByTestId('credit-exposure')).toHaveText('0.00 AED');
  await expect(o.getByTestId('credit-available')).toHaveText('Credit is off');
  await expect(o.getByTestId('credit-no-permission')).toHaveCount(0);

  // an invalid limit is refused before any request, in words
  await saveCredit(o, { enabled: true, limit: '0' });
  await expect(o.getByTestId('flash-error')).toContainText('greater than zero');

  await saveCredit(o, { enabled: true, limit: '25.00' });
  await expect(o.getByTestId('flash-ok')).toContainText('credit is ON');
  await expect(o.getByTestId('credit-state')).toContainText('Credit is ON');
  await expect(o.getByTestId('credit-limit')).toHaveText('25.00 AED');
  await expect(o.getByTestId('credit-exposure')).toHaveText('0.00 AED');
  await expect(o.getByTestId('credit-available')).toHaveText('25.00 AED');
  await expect(o.getByTestId('credit-utilisation')).toContainText('0.0%');
  result.saves.push({ label: 'enable with 25.00', enabled: true, limitMinor: '2500' });
  flush();
});

test('cashier: 21.00 on credit fits the 25.00 limit; one more rose does not — the server refuses and nothing is recorded', async ({
  page,
}) => {
  await posLogin(page);
  await posChargeOlive(page, 2, '21.00');
  await expect(page.getByTestId('account-credit')).toContainText('25.00');
  await page.getByTestId('mode-CREDIT').click();
  await expect(page.getByTestId('credit-advisory')).toContainText('Within');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  expect(await text(page, 'receipt-balance-due')).toBe('21.00');
  result.sales.push({
    label: 'Olive 2 roses on credit',
    invoiceNumber: await text(page, 'receipt-invoice-number'),
    totalMinor: '2100',
  });
  flush();
  await page.getByTestId('new-sale').click();

  await posChargeOlive(page, 1, '10.50');
  await expect(page.getByTestId('account-owes')).toHaveText('21.00');
  await page.getByTestId('mode-CREDIT').click();
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('credit limit');
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  result.refusedSales += 1;
  flush();
  await posLeave(page);
});

test('owner: Olive owes 21.00 of 25.00 — balance, available credit, the receipt’s invoice, and the receivables report all agree', async ({
  browser,
}) => {
  const o = await ownerSession(browser);
  await openOlive(o);
  await expect(o.getByTestId('credit-exposure')).toHaveText('21.00 AED');
  await expect(o.getByTestId('credit-available')).toHaveText('4.00 AED');
  await expect(o.getByTestId('credit-utilisation')).toContainText('84.0%');
  await expect(o.getByTestId('credit-utilisation')).not.toContainText('at or over');

  // the open invoice is the one the cashier's receipt printed, unpaid, with the server's amounts
  const row = o.getByTestId('open-invoice-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(result.sales[0]!.invoiceNumber);
  await expect(row).toContainText('UNPAID');
  await expect(row.locator('td').nth(7)).toContainText('21.00');
  await expect(o.getByTestId('branch-owes').first()).toHaveText('21.00 AED');
  await expect(o.getByTestId('age-note')).toContainText('no due date');
  await expect(o.getByTestId('statement-row').first()).toBeVisible();

  // the company-wide "who owes us" report lists her with the same figure, and reconciles with the ledger
  await o.goto('/receivables');
  await stepUpIfAsked(o, o.getByTestId('rec-totals'));
  const olive = o.getByTestId('rec-customer-row').filter({ hasText: OLIVE });
  await expect(olive).toHaveCount(1);
  await expect(olive).toContainText('21.00');
  if (ONLY_THIS_SPEC) await expect(o.getByTestId('rec-outstanding')).toHaveText('21.00 AED');
  await expect(o.getByTestId('rec-reconciled')).toContainText(
    'Reconciled with the accounting ledger',
  );
  await expect(o.getByTestId('rec-caveat')).toContainText('no due date');
  // the branch view of the same company: the branch that holds her invoice lists her once. When this spec runs on its own that branch's total is
  // exactly her 21.00, but in the full run other customers owe in the same branch, so find the branch by WHO it lists, not by an exact total.
  const branchRows = o.getByTestId('rec-branch-row');
  const branchCount = await branchRows.count();
  expect(branchCount).toBeGreaterThan(0);
  let branchListsOlive = false;
  for (let i = 0; i < branchCount && !branchListsOlive; i += 1) {
    if (i > 0) {
      await o.goto('/receivables');
      await stepUpIfAsked(o, o.getByTestId('rec-totals'));
    }
    await branchRows.nth(i).getByRole('link').first().click();
    await expect(o).toHaveURL(/receivables[?]branch=/);
    await o.waitForLoadState('load');
    branchListsOlive =
      (await o.getByTestId('rec-customer-row').filter({ hasText: OLIVE }).count()) === 1;
  }
  expect(branchListsOlive, 'one branch view lists Olive exactly once').toBe(true);
  // and the customer link goes back to her page
  await o.getByTestId('rec-customer-link').filter({ hasText: OLIVE }).click();
  await expect(o.getByTestId('credit-state')).toBeVisible();
});

test('owner: a STALE tab is refused with a version-conflict message and changes nothing; the fresh tab’s 60.00 limit stands', async ({
  browser,
}) => {
  const a = await ownerSession(browser);
  await openOlive(a); // tab A holds the current version…
  const b = await ownerCtx!.newPage(); // …tab B (same signed-in session) saves first
  await openOlive(b);
  await saveCredit(b, { enabled: true, limit: '60.00' });
  await expect(b.getByTestId('flash-ok')).toBeVisible();
  await expect(b.getByTestId('credit-limit')).toHaveText('60.00 AED');
  await expect(b.getByTestId('credit-available')).toHaveText('39.00 AED');
  result.saves.push({ label: 'raise to 60.00', enabled: true, limitMinor: '6000' });
  flush();
  await b.close();

  // tab A still carries the OLD version: its save must conflict, in plain words, and not touch the 60.00
  await saveCredit(a, { enabled: true, limit: '70.00' });
  await expect(a.getByTestId('flash-error')).toContainText('changed by someone else');
  await expect(a.getByTestId('flash-error')).toContainText('Reload');
  await a.goto(oliveUrl);
  await expect(a.getByTestId('credit-limit')).toHaveText('60.00 AED');
});

test('cashier: with the limit raised to 60.00 the same extra rose now goes through on credit', async ({
  page,
}) => {
  await posLogin(page);
  await posChargeOlive(page, 1, '10.50');
  await expect(page.getByTestId('account-owes')).toHaveText('21.00');
  await page.getByTestId('mode-CREDIT').click();
  await expect(page.getByTestId('credit-advisory')).toContainText('Within');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  expect(await text(page, 'receipt-balance-due')).toBe('10.50');
  await expect(page.getByTestId('account-after-owes')).toHaveText('31.50');
  result.sales.push({
    label: 'Olive 1 rose on credit after the limit was raised',
    invoiceNumber: await text(page, 'receipt-invoice-number'),
    totalMinor: '1050',
  });
  result.owedAtEndMinor = '3150';
  flush();
  await page.getByTestId('new-sale').click();
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);
});

test('owner: turning credit OFF keeps the 60.00 limit and the 31.50 debt; the cashier’s next credit sale is refused', async ({
  browser,
  page,
}) => {
  const o = await ownerSession(browser);
  await openOlive(o);
  await expect(o.getByTestId('credit-exposure')).toHaveText('31.50 AED');
  await expect(o.getByTestId('credit-available')).toHaveText('28.50 AED');
  await saveCredit(o, { enabled: false, limit: '' });
  await expect(o.getByTestId('flash-ok')).toContainText('credit is OFF');
  await expect(o.getByTestId('credit-state')).toContainText('Credit is OFF');
  await expect(o.getByTestId('credit-limit')).toHaveText('60.00 AED'); // retained
  await expect(o.getByTestId('credit-exposure')).toHaveText('31.50 AED'); // the debt is untouched
  await expect(o.getByTestId('open-invoice-row')).toHaveCount(2);
  result.saves.push({ label: 'turn credit off', enabled: false, limitMinor: '6000' });
  result.final = { enabled: false, limitMinor: '6000' };
  flush();

  await posLogin(page);
  await posChargeOlive(page, 1, '10.50');
  await page.getByTestId('mode-CREDIT').click();
  await expect(page.getByTestId('credit-advisory')).toContainText('not enabled');
  await page.getByTestId('confirm-payment').click();
  await expect(page.getByTestId('checkout-error')).toContainText('Credit is not enabled');
  result.refusedSales += 1;
  flush();
  await posLeave(page);
});

test('manager: Owner Web is not for this role — the server refuses the organisation reads, the page shows no customer data and no credit form, and nothing changes', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL: OWNER });
  const m = await ctx.newPage();
  await m.goto('/login');
  await m.getByLabel('Workspace').fill(creds.slug);
  await m.getByLabel('Email').fill(creds.manager.email);
  await m.getByLabel('Password').fill(creds.manager.password);
  await m.getByRole('button', { name: 'Sign in' }).click();
  await expect(m).toHaveURL(/products$/);
  await m.goto(oliveUrl);
  // the server answered MISSING_PERMISSION for the organisation reads: Owner Web's error screen, never the customer or a way to edit credit
  await expect(m.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(m.getByTestId('credit-state')).toHaveCount(0);
  await expect(m.getByTestId('credit-form')).toHaveCount(0);
  await expect(m.getByTestId('credit-save')).toHaveCount(0);
  await expect(m.locator('body')).not.toContainText(OLIVE);
  await ctx.close();
});
