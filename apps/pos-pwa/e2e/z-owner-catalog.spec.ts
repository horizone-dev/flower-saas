import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * OWNER WEB → POS, in real browsers against the real API and database (see run.mjs). The owner creates a product, sets its unit, price and
 * VAT category, activates it and controls branch availability in Owner Web; the cashier then finds it in the POS with the SERVER's price and
 * VAT, and sees it disappear when the owner marks it unavailable. (Runs after pilot-sale.spec.ts: it only drafts an order, it never sells.)
 */
const creds = JSON.parse(readFileSync(process.env['E2E_CREDS_FILE']!, 'utf8')) as {
  slug: string;
  email: string;
  password: string;
  companyId: string;
  owner: { email: string; password: string; totpSecret: string };
};
const OWNER = 'http://localhost:3400';

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

/** Owner Web asks for a fresh authenticator code (step-up) before the organisation screens; answer it when it appears */
async function confirmStepUpIfAsked(page: Page, secret: string, landed: Locator): Promise<void> {
  // the redirect to /step-up happens while the page renders, so decide by what is ON SCREEN, not by the first URL seen
  const stepUp = page.getByRole('heading', { name: 'Confirm it is you' });
  await stepUp.or(landed).first().waitFor();
  if (await stepUp.isVisible()) {
    await page.getByLabel('Authenticator code').fill(totp(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await landed.first().waitFor();
  }
}

test('the owner sets up a product in Owner Web and the cashier sells it in the POS', async ({
  browser,
}) => {
  // ── owner signs in ──
  const ownerCtx = await browser.newContext({ baseURL: OWNER });
  const o = await ownerCtx.newPage();
  await o.goto('/products');
  await expect(o).toHaveURL(/\/login$/); // not signed in → the sign-in page
  await o.getByLabel('Workspace').fill(creds.slug);
  await o.getByLabel('Email').fill(creds.owner.email);
  await o.getByLabel('Password').fill(creds.owner.password);
  await o.getByLabel('Authenticator code (if enabled)').fill(totp(creds.owner.totpSecret));
  await o.getByRole('button', { name: 'Sign in' }).click();
  await expect(o).toHaveURL(/\/products$/);

  // ── this workspace has TWO companies: Owner Web refuses to guess and asks which one (after a fresh authenticator code) ──
  await o.goto('/company');
  const useCompany = o.getByTestId(`use-company-${creds.companyId}`);
  await confirmStepUpIfAsked(o, creds.owner.totpSecret, useCompany);
  await expect(o.locator('[data-testid^="use-company-"]')).toHaveCount(2);
  await useCompany.click();
  await expect(o).toHaveURL(/\/products$/);

  // ── create the product (a draft) ──
  await o.getByLabel('Product name').fill('Peony');
  await o.getByLabel('…or a new category').fill('Premium');
  await o.getByRole('button', { name: 'Create product' }).click();
  await expect(o.getByTestId('readiness')).toBeVisible();
  await expect(o).toHaveURL(/\/products\/[0-9a-f-]{36}/);
  const steps = o.getByTestId('readiness');
  await expect(steps).toContainText('Set the unit of measure');
  await expect(steps).toContainText('Set a selling price');
  await expect(steps).toContainText('Activate the product');
  await expect(steps).toContainText('Set the VAT category'); // F-6: a missing VAT category is a blocking step

  // ── unit, price (text → exact minor units), VAT category ──
  await o.getByRole('button', { name: 'Set unit' }).click();
  await expect(o.getByTestId('flash-ok')).toContainText('Unit of measure set');
  await o.getByLabel(/Selling price per piece/).fill('12.345'); // too many decimals for AED: refused before any request
  await o.getByRole('button', { name: 'Save price' }).click();
  await expect(o.getByTestId('flash-error')).toContainText('at most 2 decimals');
  await o.getByLabel(/Selling price per piece/).fill('12.00');
  await o.getByRole('button', { name: 'Save price' }).click();
  await expect(o.getByTestId('flash-ok')).toContainText('Selling price set');
  // F-6: with no VAT category the variant cannot be activated (the button is disabled and says why)
  await expect(o.getByTestId('activate-variant')).toBeDisabled();
  await expect(o.getByTestId('activate-blocked')).toContainText('VAT category');
  await o.getByTestId('tax-form').locator('select').selectOption('STANDARD');
  await o.getByRole('button', { name: 'Save VAT category' }).click();
  await expect(o.getByTestId('flash-ok')).toContainText('VAT category set to STANDARD');

  // ── activate: the product, then its variant ──
  await o.getByTestId('activate-product').click();
  await expect(o.getByTestId('flash-ok')).toContainText('Product is now active');
  await expect(o.getByTestId('activate-variant')).toBeEnabled(); // the category was set above
  await o.getByTestId('activate-variant').click();
  await expect(o.getByTestId('flash-ok')).toContainText('Variant is now active');
  await expect(o.getByTestId('ready')).toBeVisible();
  await expect(o.getByText('5% (STANDARD)')).toBeVisible(); // the server resolved the rate from the company's country

  // ── the cashier finds it in the POS, with the server's price and VAT ──
  const posCtx = await browser.newContext();
  const p = await posCtx.newPage();
  await p.goto('/login');
  await p.getByLabel('Workspace').fill(creds.slug);
  await p.getByLabel('Email').fill(creds.email);
  await p.getByLabel('Password').fill(creds.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p).toHaveURL(/\/sell$/);
  await expect(p.getByTestId('tile-Peony')).toContainText('12.00');
  await p.getByTestId('tile-Peony').click();
  await p.getByTestId('charge').click();
  await expect(p.getByTestId('co-total')).toBeVisible();
  expect((await p.getByTestId('co-subtotal').textContent())?.trim()).toBe('12.00');
  expect((await p.getByTestId('co-vat').textContent())?.trim()).toBe('0.60');
  expect((await p.getByTestId('co-total').textContent())?.trim()).toBe('12.60');

  // ── the owner marks it unavailable at the branch; the POS stops offering it ──
  await o.goto('/stock');
  await confirmStepUpIfAsked(o, creds.owner.totpSecret, o.getByTestId('stock-notice'));
  await expect(o.getByTestId('stock-notice')).toContainText('not available yet'); // honest: no quantities exist
  const row = o.getByTestId('stock-row-Peony');
  await expect(row).toContainText('Available');
  await row.getByRole('button', { name: 'Mark unavailable' }).click();
  await expect(o.getByTestId('flash-ok')).toContainText('unavailable');
  await expect(o.getByTestId('stock-row-Peony')).toContainText('Unavailable');
  await p.goto('/sell');
  await expect(p.getByTestId('tile-Peony')).toContainText('Unavailable');
  await expect(p.getByTestId('tile-Peony')).toBeDisabled();

  // ── …and back ──
  await o.getByTestId('stock-row-Peony').getByRole('button', { name: 'Mark available' }).click();
  await p.goto('/sell');
  await expect(p.getByTestId('tile-Peony')).toContainText('12.00');

  // ── customers ──
  await o.goto('/customers');
  await o.getByLabel('Name', { exact: true }).fill('Layla Hassan');
  await o.getByLabel('Phone').fill('+971501234567');
  await o.getByRole('button', { name: 'Add customer' }).click();
  await expect(o.getByTestId('flash-ok')).toContainText('Layla Hassan added');
  await expect(o.getByText('+971501234567')).toBeVisible();

  // ── sales report: the two sales the cashier made (28.88 + 10.50) read back from the real, ledger-reconciled report ──
  await o.goto('/reports');
  await expect(o.getByTestId('sales-report')).toBeVisible();
  expect((await o.getByTestId('rep-count').textContent())?.trim()).toBe('2');
  expect((await o.getByTestId('rep-total').textContent())?.trim()).toBe('39.38 AED');
  expect((await o.getByTestId('rep-vat').textContent())?.trim()).toBe('1.88 AED');
  expect((await o.getByTestId('rep-net').textContent())?.trim()).toBe('37.50 AED');
  await expect(o.getByTestId('rep-reconciled')).toContainText('Reconciled');
  await expect(o.getByTestId('rep-caveat')).toContainText('not profit');
  // a bad date is refused on the page before any request
  await o.getByLabel('From').fill('2026-02-30');
  await o.getByTestId('run-report').click();
  await expect(o.getByText('YYYY-MM-DD')).toBeVisible();

  // ── sign out closes the owner session ──
  await o.getByRole('button', { name: 'Sign out' }).click();
  await expect(o).toHaveURL(/\/login$/);
  await o.goto('/products');
  await expect(o).toHaveURL(/\/login$/);
});
