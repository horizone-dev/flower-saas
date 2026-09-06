import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

interface SmokeAuth {
  email: string;
  password: string;
  totpSecret: string;
  planVersionId: string;
}

const auth = JSON.parse(
  readFileSync(fileURLToPath(new URL('./.smoke-auth.json', import.meta.url)), 'utf8'),
) as SmokeAuth;

const API = `http://localhost:${process.env['API_PORT'] ?? '3001'}`;
const SLUG = `smoke-${Date.now().toString(36)}`;

test('Super Admin: login → provision → lifecycle → role assign → preview → impersonation → secret', async ({
  page,
  context,
}) => {
  // ── login (TOTP) ─────────────────────────────────────────────────────────
  await page.goto('/login');
  await page.fill('input[name="email"]', auth.email);
  await page.fill('input[name="password"]', auth.password);
  await page.fill('input[name="code"]', authenticator.generate(auth.totpSecret));
  await page.click('button[type="submit"]');
  await page.waitForURL('**/tenants');

  // ── provision a tenant ───────────────────────────────────────────────────
  await page.fill('input[name="slug"]', SLUG);
  await page.fill('input[name="name"]', 'Smoke Florist FZE');
  await page.fill('input[name="ownerEmail"]', `owner@${SLUG}.test`);
  // task 3.1 — Business Type is REQUIRED (no blank option); pick the florist preset
  await page.selectOption('select[name="businessTypeKey"]', 'FLOWER_FLORIST');
  await page.click('button:has-text("Provision")');
  await page.waitForURL(/\/tenants\/[0-9a-f-]{36}$/);
  const tenantId = page.url().split('/').pop()!;
  await expect(page.locator('.badge', { hasText: 'ACTIVE' }).first()).toBeVisible();

  // ── task 3.1 — the Catalog / Business Capabilities card is populated + toggles ─
  await expect(page.locator('h2:has-text("Catalog / Business Capabilities")')).toBeVisible();
  await expect(page.locator('td code', { hasText: 'strategy.bom' })).toBeVisible();
  const bomRow = page.locator('tr', { has: page.locator('td code', { hasText: 'strategy.bom' }) });
  await bomRow.locator('button:has-text("Disable")').click();
  await expect(bomRow.locator('button:has-text("Enable")')).toBeVisible();

  // ── lifecycle ────────────────────────────────────────────────────────────
  await page.click('button:has-text("suspend")');
  await expect(page.locator('.badge', { hasText: 'SUSPENDED' }).first()).toBeVisible();
  await page.click('button:has-text("resume")');
  await expect(page.locator('.badge', { hasText: 'ACTIVE' }).first()).toBeVisible();

  // ── normal-platform role creation + assignment (outside impersonation) ────
  await page.click('a:has-text("Users & roles")');
  await page.waitForURL('**/access');
  await page.fill('input[name="key"]', 'ops_lead');
  await page.fill('input[name="name"]', 'Ops Lead');
  await page.check('input[name="perm:audit:view"]');
  await page.click('button:has-text("Create role")');
  await expect(page.locator('td code', { hasText: 'ops_lead' })).toBeVisible();

  await page.click('a:has-text("manage")'); // the owner user
  await page.waitForURL(/\/access\?user=/);
  await page.check('label:has-text("ops_lead") input[type="checkbox"]');
  await page.click('button:has-text("Save roles")');
  await page.waitForURL(/\/access\?user=/);

  // ── read-only effective-permission preview ───────────────────────────────
  await expect(page.locator('text=Preview (DENY audit:view) → removes:')).toContainText(
    'audit:view',
  );

  // ── impersonation: start → banner → read ok → MUTATION BLOCKED → stop ────
  await page.goto(`/tenants/${tenantId}`);
  await page
    .getByLabel('Reason (audited)')
    .fill('smoke test — verifying impersonation is read-only');
  await page.click('button:has-text("Start impersonation")');
  await page.waitForURL(`**/tenants/${tenantId}`);
  await expect(page.locator('.banner')).toContainText('Impersonating this tenant');

  // the impersonation token (tenant-realm) must NOT be able to mutate platform RBAC
  const cookies = await context.cookies();
  const impCookie = cookies.find((c) => c.name === 'sa_imp')!;
  const imp = JSON.parse(decodeURIComponent(impCookie.value)) as { token: string };
  const blocked = await page.request.put(
    `${API}/v1/platform/tenants/${tenantId}/users/${'00000000-0000-0000-0000-000000000000'}/roles`,
    { headers: { authorization: `Bearer ${imp.token}` }, data: { roleIds: [] } },
  );
  expect([401, 403]).toContain(blocked.status());

  await page.click('.banner button:has-text("Stop")');
  await expect(page.locator('.banner')).toHaveCount(0);

  // ── provider credential (masked) ─────────────────────────────────────────
  await page.fill('input[name="provider"]', 'stripe');
  await page.fill('input[name="secret"]', 'sk_test_smoke_9f8e7d6c5b4a0000');
  await page.click('button:has-text("Store credential")');
  await expect(page.locator('td code', { hasText: '••••' })).toBeVisible();
});
