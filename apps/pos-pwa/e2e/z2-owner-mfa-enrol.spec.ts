import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * OWNER WEB — authenticator (TOTP) enrolment, in a real browser against the real API and database, using ONLY the existing auth routes.
 * A password-only Owner opens Security, sees the QR code + manual key, gets a WRONG code refused (still enrolling, still signed in), confirms
 * with a correct code, is signed out, and from then on the sign-in asks for the code.
 * Also proves: an expired session during enrolment sends the user to sign in (not a raw error); the secret is never in the URL, browser
 * storage or a script-readable cookie, disappears from the page once confirmed, and the page is served `no-store`; the session cookie is
 * HttpOnly + Secure.
 * Runs against the local rehearsal (OWNER_BASE_URL unset) or, with OWNER_BASE_URL + E2E_CREDS_FILE, against a staging stack over HTTPS.
 */
const creds = JSON.parse(readFileSync(process.env['E2E_CREDS_FILE']!, 'utf8')) as {
  slug: string;
  owner2: { email: string; password: string };
};
const OWNER = process.env['OWNER_BASE_URL'] ?? 'http://localhost:3400';

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

async function signIn(page: Page, code?: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Workspace').fill(creds.slug);
  await page.getByLabel('Email').fill(creds.owner2.email);
  await page.getByLabel('Password').fill(creds.owner2.password);
  if (code) await page.getByLabel('Authenticator code (if enabled)').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const storageText = (page: Page) =>
  page.evaluate(() =>
    JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }),
  );

test.use({ baseURL: OWNER, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } }); // a phone-sized screen

test.describe.configure({ mode: 'serial' });

test('an expired session during enrolment sends the owner to sign in — never a raw error', async ({
  page,
  context,
}) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/products$/);
  await page.goto('/security');
  await expect(page.getByTestId('mfa-status')).toBeVisible();
  await page.getByTestId('mfa-ack').check();
  await page.getByTestId('mfa-start').click();
  await expect(page.getByTestId('mfa-qr')).toBeVisible();
  await context.clearCookies(); // the session ends while the QR is on screen
  await page.getByTestId('mfa-code').fill('123456');
  await page.getByTestId('mfa-confirm').click();
  await expect(page).toHaveURL(/\/login$/);
});

test('enrol an authenticator: QR + key, a wrong code is refused, a right code confirms, sign-in then needs the code', async ({
  page,
  context,
}) => {
  await signIn(page); // password only: the account has no authenticator yet
  await expect(page).toHaveURL(/\/products$/);

  // the session cookie is HttpOnly + Secure and unreadable by page scripts
  const session = (await context.cookies()).find((c) => c.name === 'ow_access')!;
  expect(session.httpOnly).toBe(true);
  expect(session.secure).toBe(true);

  // the screen is served no-store
  const nav = await page.goto('/security');
  expect(nav!.headers()['cache-control']).toMatch(/no-store/);
  await expect(page.getByTestId('mfa-status')).toContainText('authenticator');
  await expect(page.getByTestId('mfa-warning')).toContainText('First-time setup only');
  // without the acknowledgement the browser refuses to submit: no QR, no secret
  await page.getByTestId('mfa-start').click();
  await expect(page.getByTestId('mfa-qr')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Security' })).toBeVisible();

  await page.getByTestId('mfa-ack').check();
  await page.getByTestId('mfa-start').click();
  await expect(page.getByTestId('mfa-qr').locator('svg')).toBeVisible();
  const secret = ((await page.getByTestId('mfa-secret').textContent()) ?? '').replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

  // the QR is a real, sized image the camera can read (not a collapsed box), and nothing here leaks the secret
  const box = (await page.getByTestId('mfa-qr').boundingBox())!;
  expect(box.width).toBeGreaterThan(150);
  expect(page.url()).not.toContain(secret);
  expect(await storageText(page)).not.toContain(secret);
  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  expect(noOverflow).toBe(true); // responsive: no horizontal scroll on a phone

  // a WRONG code is refused; the owner stays on the screen (still enrolling, still signed in)
  await page.getByTestId('mfa-code').fill('000000');
  await page.getByTestId('mfa-confirm').click();
  await expect(page.getByTestId('mfa-error')).toContainText('not correct');
  await expect(page.getByTestId('mfa-secret')).toBeVisible();
  await expect(page).toHaveURL(/\/security$/);
  // a malformed code is refused before any request
  await page.getByTestId('mfa-code').fill('12ab');
  await page.getByTestId('mfa-confirm').click();
  await expect(page.getByTestId('mfa-error')).toContainText('6-digit');

  // the right code confirms; the secret disappears from the page; the session is ended
  await page.getByTestId('mfa-code').fill(totp(secret));
  await page.getByTestId('mfa-confirm').click();
  await expect(page).toHaveURL(/\/login\?mfa=enabled$/);
  await expect(page.getByTestId('mfa-enabled-notice')).toBeVisible();
  await expect(page.getByTestId('mfa-secret')).toHaveCount(0); // (this is the sign-in page now)
  await expect(page.getByTestId('mfa-qr')).toHaveCount(0);
  expect(await page.content()).not.toContain(secret);
  expect(await storageText(page)).not.toContain(secret);
  expect((await context.cookies()).find((c) => c.name === 'ow_access')).toBeUndefined();
  await page.goto('/security');
  await expect(page).toHaveURL(/\/login$/); // the old password-only session is gone

  // from now on a password alone is not enough
  await signIn(page);
  await expect(page.getByText('Multi-factor code required')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, '000000');
  await expect(page).toHaveURL(/\/login$/); // a wrong code does not sign in
  await signIn(page, totp(secret));
  await expect(page).toHaveURL(/\/products$/);

  // the account state cannot be read from the API, so the screen keeps its first-time-only warning and its acknowledgement box
  await page.goto('/security');
  await expect(page.getByTestId('mfa-warning')).toBeVisible();
  await expect(page.getByTestId('mfa-ack')).not.toBeChecked();

  // signing out ends the SERVER session too (the plan allows only a few per user), not just the cookies
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
