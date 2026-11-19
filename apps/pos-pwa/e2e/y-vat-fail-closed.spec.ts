import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * F-6 — a missing VAT category must never silently mean zero VAT. The rehearsal seeds an ACTIVE, priced product ("Legacy Fern", 4.00) with NO tax
 * category (the API still allows that state). The till must refuse to take payment for it, name it, and still sell a correctly classified product.
 * run.mjs afterwards verifies in the database that no invoice line exists for the Fern.
 */
const creds = JSON.parse(readFileSync(process.env['E2E_CREDS_FILE']!, 'utf8')) as {
  slug: string;
  email: string;
  password: string;
};

test('an unclassified product cannot be paid for at the till; a classified one still can be reached', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Workspace').fill(creds.slug);
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sell$/);

  await page.getByTestId('tile-Legacy Fern').click();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  await page.getByTestId('charge').click();

  // Either the server prices it (4.00, VAT 0.00) and the till refuses payment (today), or — once the F-6 server amendment is applied — the
  // server refuses the order itself. In BOTH cases no payment can be taken for the unclassified product.
  const blocked = page.getByTestId('vat-blocked');
  const refused = page.getByTestId('checkout-error');
  await expect(blocked.or(refused)).toBeVisible();
  if ((await blocked.count()) > 0) {
    await expect(page.getByTestId('co-total')).toBeVisible();
    await expect(blocked).toContainText('Legacy Fern');
    await expect(blocked).toContainText('VAT category');
    await expect(page.getByTestId('confirm-payment')).toBeDisabled();
    // even with enough cash entered the button stays disabled
    await page.getByTestId('cash-received').fill('10');
    await expect(page.getByTestId('confirm-payment')).toBeDisabled();
  } else {
    await expect(refused).toContainText('VAT category');
    await expect(page.getByTestId('confirm-payment')).toHaveCount(0);
  }

  // closing and removing the unclassified item restores a normal, payable checkout for a classified product
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Remove one Legacy Fern' }).click();
  await page.getByTestId('tile-Tulip').click();
  await page.getByTestId('charge').click();
  await expect(page.getByTestId('co-total')).toBeVisible();
  await expect(page.getByTestId('vat-blocked')).toHaveCount(0);
  await page.getByTestId('cash-received').fill('10');
  await expect(page.getByTestId('confirm-payment')).toBeEnabled();

  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);
});
