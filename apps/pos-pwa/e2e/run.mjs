import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * POS pilot rehearsal orchestrator. REAL application, REAL clock, REAL login, REAL PostgreSQL + Redis (disposable containers):
 *   1. start the stack and migrate;
 *   2. seed a sale-ready shop through the platform's own HTTP routes (the sale-world seeder in `realClock` mode), add UAE 5% VAT,
 *      a second product and a CASHIER with a real password (the one thing the API has no route for: staff creation);
 *   3. serve the API on :3001, build the POS with `/v1` proxied to it, run the Playwright spec;
 *   4. after the browser run: verify the DATABASE (one invoice per sale, balanced journals, VAT posted, no duplicate payment after a retry).
 * Prerequisites: `pnpm --filter @flower/api build` and `pnpm --filter @flower/api-client build` (the API's compiled seeder is used).
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = path.resolve(here, '..');
const root = path.resolve(appDir, '../..');
const apiDir = path.join(root, 'apps/api');
const resultFile = path.join(here, '.e2e-result.json');
const credsFile = path.join(here, '.e2e-creds.json');
const creditFile = path.join(here, '.e2e-credit-result.json');
const collectionFile = path.join(here, '.e2e-collection-result.json');
const ownerCreditFile = path.join(here, '.e2e-owner-credit-result.json');
// E2E_FOCUS=credit: the memory-safe verification — ONE app build (POS), ONE Next server, ONE worker, only the credit/advance spec, no Owner Web.
const FOCUS = ['credit', 'pos', 'owner'].includes(process.env['E2E_FOCUS'] ?? '');
// E2E_FOCUS=owner: ONLY the Owner Web customer-credit journeys (Owner Web + POS servers, one worker): the owner sets credit, the cashier's till honours it
const FOCUS_OWNER = process.env['E2E_FOCUS'] === 'owner';
// E2E_FOCUS=pos: also the pilot + VAT-guard journeys (POS-only; their results are verified too)
const FOCUS_POS = process.env['E2E_FOCUS'] === 'pos';

/**
 * Run a child process WITHOUT blocking this process: the API runs IN this process, so a synchronous wait (spawnSync) would freeze it and
 * every request the browser makes would hang.
 */
const run = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

// Next.js 16.4's own tooling sometimes ABORTS a build once to print a security-upgrade notice ("Retry the same command to continue"; the build itself
// compiled and type-checked). One bounded retry, announced; a REAL build error fails both attempts, so it still fails the rehearsal. The
// advisory itself is real (`pnpm audit`) and is reported to the owner — it is NOT silenced by this retry and no upgrade is performed here.
const nextBuild = async (label, cwd, shell, env) => {
  let code = await run('pnpm', ['exec', 'next', 'build'], { cwd, shell, env });
  if (code !== 0) {
    console.log(
      `[e2e] ${label}: next build exited ${code}; retrying ONCE (see the note in run.mjs about the Next.js upgrade notice)`,
    );
    code = await run('pnpm', ['exec', 'next', 'build'], { cwd, shell, env });
  }
  return code;
};

const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { startTestStack, migrateTestDb } = await load('packages/testing/dist/index.js');
const { createSaleWorld } = await load('apps/api/dist/verification/load-sale-world.js');
const { hash } = createRequire(path.join(apiDir, 'package.json'))('@node-rs/argon2');

// pre-flight: the rehearsal uses FIXED ports (API 3001, POS 3300, Owner Web 3400). A busy port would make the browser talk to a stale server,
// so refuse loudly instead of running against the wrong process.
const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
for (const port of [3001, 3300, 3400]) {
  if (await portBusy(port)) {
    console.error(`port ${port} is already in use: stop the process using it and re-run`);
    process.exit(2);
  }
}

rmSync(resultFile, { force: true });
rmSync(credsFile, { force: true });
rmSync(creditFile, { force: true });
rmSync(collectionFile, { force: true });
rmSync(ownerCreditFile, { force: true });
const stack = await startTestStack({ services: ['postgres', 'redis'] });
let world;
let exit = 1;
try {
  migrateTestDb(stack.postgres.url);
  world = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 1, {
    realClock: true,
  });
  const w = world;
  const q = async (sql, p = []) => (await w.pool.query(sql, p)).rows;

  // ── UAE VAT: the standard category and its 5% rate; assign it to the product's variant through the real route ──
  await q(
    `INSERT INTO tax_category (key, "nameEn", "nameAr") VALUES ('STANDARD','Standard rate','x') ON CONFLICT (key) DO NOTHING`,
  );
  await q(
    `INSERT INTO tax_rate (id, "countryCode", "taxCategoryKey", "rateBps", "effectiveFrom") VALUES (uuidv7(),'AE','STANDARD',500,'2018-01-01')`,
  );
  const variant = await w.req('GET', `/catalog/variants/${w.variantId}`, w.ownerToken);
  const tax = await w.req(
    'PUT',
    `/catalog/variants/${w.variantId}/tax-category`,
    w.ownerToken,
    { taxCategoryKey: 'STANDARD' },
    { 'if-match': `"${variant.body.version}"` },
  );
  if (tax.status !== 200)
    throw new Error(`tax category failed ${tax.status} ${JSON.stringify(tax.body)}`);

  // ── a second product (Tulip, 7.50) through the same public routes ──
  const k = (p) => `e2e-${p}-${randomUUID().slice(0, 8)}`;
  const cat = await w.req(
    'POST',
    '/catalog/categories',
    w.ownerToken,
    { slug: k('tulips'), nameEn: 'Tulips' },
    { 'idempotency-key': k('cat') },
  );
  const prod = await w.req(
    'POST',
    '/catalog/products',
    w.ownerToken,
    { categoryId: cat.body.id, nameEn: 'Tulip', slug: k('tulip'), fulfilmentStrategy: 'STOCKED' },
    { 'idempotency-key': k('prod') },
  );
  if (prod.status !== 201)
    throw new Error(`tulip failed ${prod.status} ${JSON.stringify(prod.body)}`);
  const tVariants = (await w.req('GET', `/catalog/products/${prod.body.id}/variants`, w.ownerToken))
    .body;
  const tv = tVariants[0].id;
  let v0 = (await w.req('GET', `/catalog/variants/${tv}`, w.ownerToken)).body;
  await w.req(
    'PUT',
    `/catalog/variants/${tv}/base-uom`,
    w.ownerToken,
    { baseUomCode: 'piece' },
    { 'if-match': `"${v0.version}"` },
  );
  await w.req('POST', `/catalog/products/${prod.body.id}/activate`, w.ownerToken, undefined, {
    'if-match': '"1"',
    'idempotency-key': k('actp'),
  });
  // the VAT category BEFORE activation (a variant with no category must never be activated: the F-6 rule)
  v0 = (await w.req('GET', `/catalog/variants/${tv}`, w.ownerToken)).body;
  const tvTax = await w.req(
    'PUT',
    `/catalog/variants/${tv}/tax-category`,
    w.ownerToken,
    { taxCategoryKey: 'STANDARD' },
    { 'if-match': `"${v0.version}"` },
  );
  if (tvTax.status !== 200)
    throw new Error(`tulip tax category failed ${tvTax.status} ${JSON.stringify(tvTax.body)}`);
  v0 = (await w.req('GET', `/catalog/variants/${tv}`, w.ownerToken)).body;
  await w.req('POST', `/catalog/variants/${tv}/activate`, w.ownerToken, undefined, {
    'if-match': `"${v0.version}"`,
    'idempotency-key': k('actv'),
  });
  const prices = (
    await w.req('GET', `/catalog/companies/${w.a.companyId}/variants/${tv}/prices`, w.ownerToken)
  ).body;
  const put = await w.req(
    'PUT',
    `/catalog/companies/${w.a.companyId}/variants/${tv}/prices`,
    w.ownerToken,
    { prices: [{ uomCode: 'piece', sell: { amountMinor: '750', currency: 'AED', exponent: 2 } }] },
    { 'if-match': `"${prices.version}"` },
  );
  if (put.status !== 200)
    throw new Error(`tulip price failed ${put.status} ${JSON.stringify(put.body)}`);

  // ── F-6 fixture: a LEGACY product that is ACTIVE, priced and has NO tax category (the API still allows it). The till must refuse to sell it ──
  const fern = await w.req(
    'POST',
    '/catalog/products',
    w.ownerToken,
    {
      categoryId: cat.body.id,
      nameEn: 'Legacy Fern',
      slug: k('fern'),
      fulfilmentStrategy: 'STOCKED',
    },
    { 'idempotency-key': k('fern') },
  );
  if (fern.status !== 201)
    throw new Error(`fern failed ${fern.status} ${JSON.stringify(fern.body)}`);
  const fv = (await w.req('GET', `/catalog/products/${fern.body.id}/variants`, w.ownerToken))
    .body[0].id;
  let f0 = (await w.req('GET', `/catalog/variants/${fv}`, w.ownerToken)).body;
  await w.req(
    'PUT',
    `/catalog/variants/${fv}/base-uom`,
    w.ownerToken,
    { baseUomCode: 'piece' },
    { 'if-match': `"${f0.version}"` },
  );
  // LEGACY state, by SQL on purpose: once the server refuses to activate an unclassified variant (the F-6 amendment) the API can no longer
  // create it, but such rows exist in real data. This keeps the rehearsal valid before AND after that amendment.
  await q(`UPDATE product SET status = 'ACTIVE' WHERE id = $1`, [fern.body.id]);
  await q(`UPDATE variant SET status = 'ACTIVE' WHERE id = $1`, [fv]);
  const fp = (
    await w.req('GET', `/catalog/companies/${w.a.companyId}/variants/${fv}/prices`, w.ownerToken)
  ).body;
  const fput = await w.req(
    'PUT',
    `/catalog/companies/${w.a.companyId}/variants/${fv}/prices`,
    w.ownerToken,
    { prices: [{ uomCode: 'piece', sell: { amountMinor: '400', currency: 'AED', exponent: 2 } }] },
    { 'if-match': `"${fp.version}"` },
  );
  if (fput.status !== 200)
    throw new Error(`fern price failed ${fput.status} ${JSON.stringify(fput.body)}`);

  // the seller's legal identity (a VAT invoice needs the TRN); the cashier reads it through the F-3 endpoint
  await q(
    `UPDATE company SET trn = '100123456700003', "registeredAddress" = 'Shop 4, Rose Street, Dubai, UAE' WHERE id = $1`,
    [w.a.companyId],
  );
  // ── a cashier with a real password, scoped to this company and branch (staff creation has no API route yet) ──
  const slug = (await q(`SELECT slug FROM tenant WHERE id = $1`, [w.a.tenantId]))[0].slug;
  const email = `cashier-${randomUUID().slice(0, 6)}@pilot.test`;
  const password = `Pilot-Cashier-${randomUUID()}`;
  const userId = randomUUID();
  await q(
    `INSERT INTO "user" (id, "tenantId", "accountType", email, status, "updatedAt") VALUES ($1,$2,'USER',$3,'ACTIVE',now())`,
    [userId, w.a.tenantId, email],
  );
  await q(
    `INSERT INTO user_role ("tenantId","userId","roleId") SELECT $1,$2,id FROM role WHERE "tenantId"=$1 AND key='cashier'`,
    [w.a.tenantId, userId],
  );
  // FINDING (owner decision): the shipped `cashier` system role has NO `catalog:view`, so a cashier cannot list products. The role template is
  // NOT changed here (a template change needs a permissions migration + S0b approval); the rehearsal grants it to THIS rehearsal tenant's
  // cashier role only, to prove the rest of the journey.
  await q(
    `INSERT INTO role_permission ("tenantId","roleId","permissionKey") SELECT $1,id,'catalog:view' FROM role WHERE "tenantId"=$1 AND key='cashier' ON CONFLICT DO NOTHING`,
    [w.a.tenantId],
  );
  await q(
    `INSERT INTO data_scope_assignment ("tenantId","userId","companyScopeAll","companyIds","branchScopeAll","branchIds","updatedAt") VALUES ($1,$2,false,$3,false,$4,now())`,
    [w.a.tenantId, userId, [w.a.companyId], [w.a.branches[0]]],
  );
  const argon = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
  await q(
    `INSERT INTO credential ("tenantId","userId",kind,hash,"updatedAt") VALUES ($1,$2,'PASSWORD',$3,now())`,
    [w.a.tenantId, userId, await hash(password, argon)],
  );
  // ── a MANAGER with a real password, same company + branch: applying a customer advance is a manager authority, not a cashier one ──
  const managerEmail = `manager-${randomUUID().slice(0, 6)}@pilot.test`;
  const managerPassword = `Pilot-Manager-${randomUUID()}`;
  const managerUserId = randomUUID();
  await q(
    `INSERT INTO "user" (id, "tenantId", "accountType", email, status, "updatedAt") VALUES ($1,$2,'USER',$3,'ACTIVE',now())`,
    [managerUserId, w.a.tenantId, managerEmail],
  );
  await q(
    `INSERT INTO user_role ("tenantId","userId","roleId") SELECT $1,$2,id FROM role WHERE "tenantId"=$1 AND key='manager'`,
    [w.a.tenantId, managerUserId],
  );
  await q(
    `INSERT INTO data_scope_assignment ("tenantId","userId","companyScopeAll","companyIds","branchScopeAll","branchIds","updatedAt") VALUES ($1,$2,false,$3,false,$4,now())`,
    [w.a.tenantId, managerUserId, [w.a.companyId], [w.a.branches[0]]],
  );
  await q(
    `INSERT INTO credential ("tenantId","userId",kind,hash,"updatedAt") VALUES ($1,$2,'PASSWORD',$3,now())`,
    [w.a.tenantId, managerUserId, await hash(managerPassword, argon)],
  );
  // ── customers for the credit / advance journeys (names are what the cashier searches for) ──
  let oliveId = null;
  const mkCustomer = async (displayName, { creditEnabled, limitMinor }) => {
    const id = randomUUID();
    await q(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,$3,now())`,
      [id, w.a.tenantId, displayName],
    );
    await q(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","creditEnabled","creditLimitMinor","creditLimitCurrencyCode","creditLimitCurrencyExponent","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [
        randomUUID(),
        w.a.tenantId,
        w.a.companyId,
        id,
        creditEnabled,
        limitMinor === null ? null : String(limitMinor),
        limitMinor === null ? null : 'AED',
        limitMinor === null ? null : 2,
      ],
    );
    return id;
  };
  await mkCustomer('Carla Credit', { creditEnabled: true, limitMinor: 2500 }); // limit 25.00
  await mkCustomer('Nadia Nocredit', { creditEnabled: false, limitMinor: null });
  const amalId = await mkCustomer('Amal Advance', { creditEnabled: true, limitMinor: null });
  // Amal holds a 40.00 advance, made the real way: a cash receipt with nothing to settle, then an explicit conversion (owner authority)
  const amalBase = `/companies/${w.a.companyId}/branches/${w.a.branches[0]}/customers/${amalId}`;
  const amalRcpt = await w.req(
    'POST',
    `${amalBase}/receipts`,
    w.ownerToken,
    { amountMinor: '4000', method: 'CASH' },
    { 'idempotency-key': k('amal-rcpt') },
  );
  if (amalRcpt.status !== 201)
    throw new Error(`advance receipt failed ${amalRcpt.status} ${JSON.stringify(amalRcpt.body)}`);
  const amalConv = await w.req(
    'POST',
    `${amalBase}/advances/from-payment`,
    w.ownerToken,
    { paymentId: amalRcpt.body.paymentId, amountMinor: '4000' },
    { 'idempotency-key': k('amal-conv') },
  );
  if (amalConv.status !== 201)
    throw new Error(
      `advance conversion failed ${amalConv.status} ${JSON.stringify(amalConv.body)}`,
    );
  // customer-account journeys: Dora buys on credit through the till (so no seeded order disturbs the pilot counts); Nora holds a 5.00 advance, owes nothing
  await mkCustomer('Dora Debtor', { creditEnabled: true, limitMinor: null });
  oliveId = await mkCustomer('Olive Owner-Credit', { creditEnabled: false, limitMinor: null });
  const noraId = await mkCustomer('Nora Prepaid', { creditEnabled: true, limitMinor: null });
  const noraBase = `/companies/${w.a.companyId}/branches/${w.a.branches[0]}/customers/${noraId}`;
  const noraRcpt = await w.req(
    'POST',
    `${noraBase}/receipts`,
    w.ownerToken,
    { amountMinor: '500', method: 'CASH' },
    { 'idempotency-key': k('nora-rcpt') },
  );
  if (noraRcpt.status !== 201)
    throw new Error(`nora receipt failed ${noraRcpt.status} ${JSON.stringify(noraRcpt.body)}`);
  const noraConv = await w.req(
    'POST',
    `${noraBase}/advances/from-payment`,
    w.ownerToken,
    { paymentId: noraRcpt.body.paymentId, amountMinor: '500' },
    { 'idempotency-key': k('nora-conv') },
  );
  if (noraConv.status !== 201)
    throw new Error(`nora conversion failed ${noraConv.status} ${JSON.stringify(noraConv.body)}`);
  // ── an OWNER with a real password (all companies and branches) for the Owner Web rehearsal ──
  const ownerEmail = `owner-${randomUUID().slice(0, 6)}@pilot.test`;
  const ownerPassword = `Pilot-Owner-${randomUUID()}`;
  const ownerUserId = randomUUID();
  await q(
    `INSERT INTO "user" (id, "tenantId", "accountType", email, status, "updatedAt") VALUES ($1,$2,'USER',$3,'ACTIVE',now())`,
    [ownerUserId, w.a.tenantId, ownerEmail],
  );
  await q(
    `INSERT INTO user_role ("tenantId","userId","roleId") SELECT $1,$2,id FROM role WHERE "tenantId"=$1 AND key='owner'`,
    [w.a.tenantId, ownerUserId],
  );
  await q(
    `INSERT INTO data_scope_assignment ("tenantId","userId","companyScopeAll","companyIds","branchScopeAll","branchIds","updatedAt") VALUES ($1,$2,true,'{}',true,'{}',now())`,
    [w.a.tenantId, ownerUserId],
  );
  await q(
    `INSERT INTO credential ("tenantId","userId",kind,hash,"updatedAt") VALUES ($1,$2,'PASSWORD',$3,now())`,
    [w.a.tenantId, ownerUserId, await hash(ownerPassword, argon)],
  );
  // the owner has authenticator MFA enrolled (login asks for a code; the organisation settings ask for a fresh one: step-up)
  const totpSecret = 'JBSWY3DPEHPK3PXP';
  await q(
    `INSERT INTO mfa_factor ("tenantId","userId",kind,"secretRef",status,"confirmedAt") VALUES ($1,$2,'TOTP',$3,'CONFIRMED',now())`,
    [w.a.tenantId, ownerUserId, totpSecret],
  );
  // a SECOND owner with a password only (no authenticator yet) — the account that enrols one through the Owner Web Security screen
  const owner2Email = `owner2-${randomUUID().slice(0, 6)}@pilot.test`;
  const owner2Password = `Pilot-Owner2-${randomUUID()}`;
  const owner2Id = randomUUID();
  await q(
    `INSERT INTO "user" (id, "tenantId", "accountType", email, status, "updatedAt") VALUES ($1,$2,'OWNER',$3,'ACTIVE',now())`,
    [owner2Id, w.a.tenantId, owner2Email],
  );
  await q(
    `INSERT INTO user_role ("tenantId","userId","roleId") SELECT $1,$2,id FROM role WHERE "tenantId"=$1 AND key='owner'`,
    [w.a.tenantId, owner2Id],
  );
  await q(
    `INSERT INTO data_scope_assignment ("tenantId","userId","companyScopeAll","companyIds","branchScopeAll","branchIds","updatedAt") VALUES ($1,$2,true,'{}',true,'{}',now())`,
    [w.a.tenantId, owner2Id],
  );
  await q(
    `INSERT INTO credential ("tenantId","userId",kind,hash,"updatedAt") VALUES ($1,$2,'PASSWORD',$3,now())`,
    [w.a.tenantId, owner2Id, await hash(owner2Password, argon)],
  );
  writeFileSync(
    credsFile,
    JSON.stringify(
      {
        slug,
        email,
        password,
        manager: { email: managerEmail, password: managerPassword },
        owner: { email: ownerEmail, password: ownerPassword, totpSecret },
        owner2: { id: owner2Id, email: owner2Email, password: owner2Password },
        tenantId: w.a.tenantId,
        companyId: w.a.companyId,
        branchId: w.a.branches[0],
      },
      null,
      2,
    ),
  );

  // ── serve the API; build and run the POS against it ──
  await w.h.app.listen({ port: 3001, host: '127.0.0.1' });
  const env = {
    ...process.env,
    API_PROXY_TARGET: 'http://127.0.0.1:3001',
    NEXT_PUBLIC_API_BASE_URL: '',
  };
  const shell = process.platform === 'win32';
  const buildCode = await nextBuild('POS', appDir, shell, env);
  if (buildCode !== 0) throw new Error('next build failed');
  const ownerDir = path.join(appDir, '..', 'owner-web');
  if (!FOCUS || FOCUS_OWNER) {
    const ownerBuild = await nextBuild('owner-web', ownerDir, shell, env);
    if (ownerBuild !== 0) throw new Error('owner-web next build failed');
  }
  if (process.env['E2E_KEEP']) {
    // debugging aid: leave the API (:3001) and the POS (:3300) running for manual probing
    await run('pnpm', ['exec', 'next', 'start', '-p', '3300'], { cwd: appDir, shell, env });
  }
  const playwrightCli = createRequire(path.join(appDir, 'package.json')).resolve(
    '@playwright/test/cli',
  );
  exit = await run(process.execPath, [playwrightCli, 'test'], {
    cwd: appDir,
    env: {
      ...env,
      API_BASE_URL: 'http://127.0.0.1:3001',
      E2E_RESULT_FILE: resultFile,
      E2E_CREDIT_FILE: creditFile,
      E2E_COLLECTION_FILE: collectionFile,
      E2E_OWNER_CREDIT_FILE: ownerCreditFile,
      ...(FOCUS ? { E2E_FOCUS: process.env['E2E_FOCUS'] } : {}),
      E2E_CREDS_FILE: credsFile,
    },
  });

  // ── post-run database verification (what the browser cannot see) ──
  const res = FOCUS && !FOCUS_POS ? { sales: [] } : JSON.parse(readFileSync(resultFile, 'utf8'));
  // the credit / advance journeys report their own sales (they run after the pilot journey, so the pilot's counts stay exact)
  const credit = existsSync(creditFile)
    ? JSON.parse(readFileSync(creditFile, 'utf8'))
    : { sales: [] };
  // the customer-account / collection journeys report their own sales and collections (same reason)
  const coll = existsSync(collectionFile)
    ? JSON.parse(readFileSync(collectionFile, 'utf8'))
    : { sales: [], collections: [] };
  // the Owner Web customer-credit journeys report their own sales and credit saves (same reason)
  const oc = existsSync(ownerCreditFile)
    ? JSON.parse(readFileSync(ownerCreditFile, 'utf8'))
    : { sales: [], saves: [], refusedSales: 0 };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  for (const sale of res.sales) {
    const inv = await q(
      `SELECT i.id, i."totalAmountMinor"::text AS total, i."taxTotalAmountMinor"::text AS tax, i."subtotalAmountMinor"::text AS sub, i."invoicePaymentStatus" AS status FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE o."orderNumber" = $1`,
      [sale.orderNumber],
    );
    check(`${sale.label}: exactly ONE invoice`, inv.length === 1, inv.length);
    if (inv.length !== 1) continue;
    check(
      `${sale.label}: invoice total ${sale.totalMinor}, VAT ${sale.taxMinor}`,
      inv[0].total === sale.totalMinor && inv[0].tax === sale.taxMinor,
      JSON.stringify(inv[0]),
    );
    check(
      `${sale.label}: invoice is fully paid (PAID, or SETTLED once the settlement authority has closed it)`,
      inv[0].status === 'PAID' || inv[0].status === 'SETTLED',
      inv[0].status,
    );
    const pays = await q(
      `SELECT p.method, p."amountMinor"::text AS amt FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1 ORDER BY p.method`,
      [inv[0].id],
    );
    check(
      `${sale.label}: payments ${JSON.stringify(sale.tenders)}`,
      JSON.stringify(pays.map((p) => [p.method, p.amt])) === JSON.stringify(sale.tenders),
      JSON.stringify(pays),
    );
    const je = await q(
      `SELECT je.id, (SELECT coalesce(sum("debitMinor"),0) FROM journal_line WHERE "journalEntryId"=je.id)::text AS d, (SELECT coalesce(sum("creditMinor"),0) FROM journal_line WHERE "journalEntryId"=je.id)::text AS c FROM journal_entry je WHERE je."sourceId" = ANY($1::text[])`,
      [
        [
          inv[0].id,
          ...(
            await q(`SELECT o.id FROM "order" o WHERE o."orderNumber"=$1`, [sale.orderNumber])
          ).map((r) => r.id),
        ],
      ],
    );
    check(
      `${sale.label}: journal(s) exist and every entry balances`,
      je.length >= 1 && je.every((j) => j.d === j.c),
      JSON.stringify(je),
    );
    const vat = await q(
      `SELECT coalesce(sum(jl."creditMinor" - jl."debitMinor"),0)::text AS v FROM journal_line jl JOIN account a ON a.id = jl."accountId" JOIN journal_entry je ON je.id = jl."journalEntryId" WHERE a."key" = 'LIABILITY.TAX_PAYABLE' AND je."sourceId" = ANY($1::text[])`,
      [
        [
          inv[0].id,
          ...(
            await q(`SELECT o.id FROM "order" o WHERE o."orderNumber"=$1`, [sale.orderNumber])
          ).map((r) => r.id),
        ],
      ],
    );
    check(
      `${sale.label}: VAT payable credited ${sale.taxMinor}`,
      vat[0].v === sale.taxMinor,
      vat[0].v,
    );
    // the CASH ledger agrees with the recorded cash tender (28.88 / 4.50) — never with the cash the customer handed over (50.00 / 5.00)
    const cashTender = sale.tenders
      .filter(([m]) => m === 'CASH')
      .reduce((s, [, a]) => s + BigInt(a), 0n)
      .toString();
    const cashLedger = await q(
      `SELECT coalesce(sum(jl."debitMinor" - jl."creditMinor"),0)::text AS v FROM journal_line jl JOIN account a ON a.id = jl."accountId" JOIN journal_entry je ON je.id = jl."journalEntryId" WHERE a."key" = 'ASSET.CASH_ON_HAND' AND je."sourceId" = ANY($1::text[])`,
      [
        [
          inv[0].id,
          ...(
            await q(`SELECT o.id FROM "order" o WHERE o."orderNumber"=$1`, [sale.orderNumber])
          ).map((r) => r.id),
          ...(
            await q(
              `SELECT p.id FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1`,
              [inv[0].id],
            )
          ).map((r) => r.id),
        ],
      ],
    );
    check(
      `${sale.label}: cash ledger debited ${cashTender} (the recorded cash tender, not the cash handed over)`,
      cashLedger[0].v === cashTender,
      cashLedger[0].v,
    );
  }
  // ── credit / advance sales: what the DATABASE recorded must equal what the browser showed ──
  if (!FOCUS_OWNER)
    check('credit journeys ran and reported sales', credit.sales.length >= 5, credit.sales.length);
  for (const sale of credit.sales) {
    const inv = await q(
      `SELECT i.id, i."totalAmountMinor"::text AS total FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE o."orderNumber" = $1`,
      [sale.orderNumber],
    );
    check(`${sale.label}: exactly ONE invoice`, inv.length === 1, inv.length);
    if (inv.length !== 1) continue;
    check(
      `${sale.label}: invoice total ${sale.totalMinor}`,
      inv[0].total === sale.totalMinor,
      inv[0].total,
    );
    const pays = await q(
      `SELECT p.method, p."amountMinor"::text AS amt FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1 ORDER BY p.method`,
      [inv[0].id],
    );
    check(
      `${sale.label}: payments ${JSON.stringify(sale.tenders)}`,
      JSON.stringify(pays.map((p) => [p.method, p.amt])) === JSON.stringify(sale.tenders),
      JSON.stringify(pays),
    );
    const adv = await q(
      `SELECT coalesce(sum(a."amountMinor"),0)::text AS applied FROM customer_advance_application a JOIN customer_receivable r ON r.id = a."customerReceivableId" WHERE r."invoiceId" = $1`,
      [inv[0].id],
    );
    check(
      `${sale.label}: advance applied ${sale.advanceMinor}`,
      adv[0].applied === sale.advanceMinor,
      adv[0].applied,
    );
    const rec = await q(
      `SELECT count(*)::int AS n FROM customer_receivable WHERE "invoiceId" = $1`,
      [inv[0].id],
    );
    check(`${sale.label}: one customer receivable`, rec[0].n === 1, rec[0].n);
    // the receipt the cashier saw carries the invoice number — the database must hold the SAME invoice number for this order
    const num = await q(`SELECT "invoiceNumber" AS n FROM invoice WHERE id = $1`, [inv[0].id]);
    check(
      `${sale.label}: receipt invoice number ${sale.invoiceNumber} is the number stored in the database`,
      sale.invoiceNumber !== '' && num[0].n === sale.invoiceNumber,
      `${num[0].n} vs ${sale.invoiceNumber}`,
    );
    // the FINANCIAL JOURNAL: every leg of this sale, by source (invoice, order, payments, advance applications, receivable)
    const srcIds = [
      inv[0].id,
      ...(await q(`SELECT id FROM "order" WHERE "orderNumber" = $1`, [sale.orderNumber])).map(
        (r) => r.id,
      ),
      ...(
        await q(
          `SELECT pa."paymentId" AS id FROM payment_allocation pa WHERE pa."invoiceId" = $1`,
          [inv[0].id],
        )
      ).map((r) => r.id),
      ...(
        await q(
          `SELECT ap.id FROM customer_advance_application ap JOIN customer_receivable r ON r.id = ap."customerReceivableId" WHERE r."invoiceId" = $1`,
          [inv[0].id],
        )
      ).map((r) => r.id),
      ...(await q(`SELECT id FROM customer_receivable WHERE "invoiceId" = $1`, [inv[0].id])).map(
        (r) => r.id,
      ),
      // the settlement of each tender against the invoice is journalled against the payment ALLOCATION
      ...(await q(`SELECT id FROM payment_allocation WHERE "invoiceId" = $1`, [inv[0].id])).map(
        (r) => r.id,
      ),
    ];
    const legs = Object.fromEntries(
      (
        await q(
          `SELECT a."key" AS k, coalesce(sum(jl."debitMinor" - jl."creditMinor"),0)::text AS net FROM journal_line jl JOIN account a ON a.id = jl."accountId" JOIN journal_entry je ON je.id = jl."journalEntryId" WHERE je."tenantId" = $1 AND je."sourceId" = ANY($2::text[]) GROUP BY a."key"`,
          [w.a.tenantId, srcIds],
        )
      ).map((r) => [r.k, BigInt(r.net)]),
    );
    const leg = (k) => legs[k] ?? 0n;
    const cashT = sale.tenders
      .filter(([m]) => m === 'CASH')
      .reduce((s, [, a]) => s + BigInt(a), 0n);
    const cardT = sale.tenders
      .filter(([m]) => m !== 'CASH')
      .reduce((s, [, a]) => s + BigInt(a), 0n);
    const tax = BigInt(sale.taxMinor);
    const total = BigInt(sale.totalMinor);
    const jl = (name, ok, detail) => check(`${sale.label}: journal — ${name}`, ok, detail);
    jl(
      `receivable control debited ${sale.owedMinor} (what the customer owes)`,
      leg('ASSET.ACCOUNTS_RECEIVABLE') === BigInt(sale.owedMinor),
      String(leg('ASSET.ACCOUNTS_RECEIVABLE')),
    );
    jl(
      `customer-advance liability debited ${sale.advanceMinor}`,
      leg('LIABILITY.CUSTOMER_ADVANCES') === BigInt(sale.advanceMinor),
      String(leg('LIABILITY.CUSTOMER_ADVANCES')),
    );
    jl(
      `cash on hand debited ${cashT}`,
      leg('ASSET.CASH_ON_HAND') === cashT,
      String(leg('ASSET.CASH_ON_HAND')),
    );
    jl(
      `card legs (bank + clearing) debited ${cardT}`,
      leg('ASSET.BANK') + leg('ASSET.PAYMENT_CLEARING') === cardT,
      String(leg('ASSET.BANK') + leg('ASSET.PAYMENT_CLEARING')),
    );
    jl(
      'unapplied receipts net to zero (every tender received was allocated to this invoice)',
      leg('LIABILITY.UNAPPLIED_RECEIPTS') === 0n,
      String(leg('LIABILITY.UNAPPLIED_RECEIPTS')),
    );
    jl(
      `VAT payable credited ${tax}`,
      leg('LIABILITY.TAX_PAYABLE') === -tax,
      String(leg('LIABILITY.TAX_PAYABLE')),
    );
    jl(
      `sales revenue credited ${total - tax} (total − VAT)`,
      leg('REVENUE.SALES') === -(total - tax),
      String(leg('REVENUE.SALES')),
    );
    jl(
      'credit ≠ cash: money in = tenders only',
      cashT + cardT === total - BigInt(sale.owedMinor) - BigInt(sale.advanceMinor),
      `${cashT + cardT}`,
    );
    const owed =
      BigInt(inv[0].total) - pays.reduce((s, p) => s + BigInt(p.amt), 0n) - BigInt(adv[0].applied);
    check(
      `${sale.label}: the customer owes ${sale.owedMinor} (total − payments − advances)`,
      owed.toString() === sale.owedMinor,
      owed.toString(),
    );
  }
  // ── per-customer balances, straight from the tables (independent of any API summary or screen) ──
  for (const name of [...new Set(credit.sales.map((s) => s.customer))]) {
    const mine = credit.sales.filter((s) => s.customer === name);
    const owedExpected = mine.reduce((s, x) => s + BigInt(x.owedMinor), 0n);
    const advExpected = mine.reduce((s, x) => s + BigInt(x.advanceMinor), 0n);
    const owedDb = (
      await q(
        `SELECT coalesce(sum(i."totalAmountMinor" - coalesce(p.s,0) - coalesce(a.s,0)),0)::text AS v
           FROM customer c
           JOIN customer_company_account cca ON cca."customerId" = c.id
           JOIN customer_receivable r ON r."customerCompanyAccountId" = cca.id
           JOIN invoice i ON i.id = r."invoiceId"
           LEFT JOIN LATERAL (SELECT sum(p."amountMinor") AS s FROM payment_allocation pa JOIN payment p ON p.id = pa."paymentId" WHERE pa."invoiceId" = i.id) p ON true
           LEFT JOIN LATERAL (SELECT sum(ap."amountMinor") AS s FROM customer_advance_application ap WHERE ap."customerReceivableId" = r.id) a ON true
          WHERE c."tenantId" = $1 AND c."displayName" = $2`,
        [w.a.tenantId, name],
      )
    )[0].v;
    check(
      `${name}: database outstanding balance = ${owedExpected} (sum of what the receipts showed as owed)`,
      owedDb === owedExpected.toString(),
      owedDb,
    );
    const advDb = (
      await q(
        `SELECT coalesce(sum(ap."amountMinor"),0)::text AS applied,
                (SELECT coalesce(sum(ca."amountMinor"),0)::text FROM customer_advance ca JOIN customer_company_account cca2 ON cca2.id = ca."customerCompanyAccountId" JOIN customer c2 ON c2.id = cca2."customerId" WHERE c2."tenantId" = $1 AND c2."displayName" = $2) AS original
           FROM customer_advance_application ap
           JOIN customer_advance ca ON ca.id = ap."customerAdvanceId"
           JOIN customer_company_account cca ON cca.id = ca."customerCompanyAccountId"
           JOIN customer c ON c.id = cca."customerId"
          WHERE c."tenantId" = $1 AND c."displayName" = $2`,
        [w.a.tenantId, name],
      )
    )[0];
    check(
      `${name}: advances applied in the database = ${advExpected}`,
      advDb.applied === advExpected.toString(),
      advDb.applied,
    );
    if (name === 'Amal Advance')
      check(
        'Amal Advance: the 4000 advance is fully used (original − applied = 0), never overspent',
        BigInt(advDb.original) - BigInt(advDb.applied) === 0n,
        `${advDb.original} − ${advDb.applied}`,
      );
  }
  // ── customer account + credit collection: what the DATABASE recorded must equal what the browser showed ──
  if (!FOCUS_OWNER) {
    check(
      'collection journeys ran and reported sales and collections',
      coll.sales.length === 2 && coll.collections.length === 2,
      `${coll.sales.length} sales, ${coll.collections.length} collections`,
    );
    const invNums = coll.sales.map((s) => s.invoiceNumber);
    const invs = await q(
      `SELECT id, "invoiceNumber" AS num, "totalAmountMinor"::text AS total, "invoicePaymentStatus" AS status FROM invoice WHERE "tenantId" = $1 AND "invoiceNumber" = ANY($2::text[]) ORDER BY "invoiceNumber"`,
      [w.a.tenantId, invNums],
    );
    check('Dora: the two credit-sale invoices exist, once each', invs.length === 2, invs.length);
    const totalOwed = invs.reduce((s, i) => s + BigInt(i.total), 0n);
    let collectedSoFar = 0n;
    for (const c of coll.collections) {
      const pay = await q(`SELECT method, "amountMinor"::text AS amt FROM payment WHERE id = $1`, [
        c.paymentId,
      ]);
      check(
        `${c.label}: exactly ONE payment row with the receipt's reference, ${c.method} ${c.amountMinor}`,
        pay.length === 1 && pay[0].method === c.method && pay[0].amt === c.amountMinor,
        JSON.stringify(pay),
      );
      const allocs = await q(
        `SELECT i."invoiceNumber" AS n, pa."amountMinor"::text AS a, pa.id FROM payment_allocation pa JOIN invoice i ON i.id = pa."invoiceId" WHERE pa."paymentId" = $1 ORDER BY i."invoiceNumber"`,
        [c.paymentId],
      );
      const expectedAllocs = [...c.allocations].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      check(
        `${c.label}: the database allocated it to the invoices the receipt listed (${JSON.stringify(c.allocations)})`,
        JSON.stringify(allocs.map((a) => [a.n, a.a])) === JSON.stringify(expectedAllocs),
        JSON.stringify(allocs.map((a) => [a.n, a.a])),
      );
      check(
        `${c.label}: allocations add up to the amount received (nothing left unapplied)`,
        allocs.reduce((s, a) => s + BigInt(a.a), 0n).toString() === c.amountMinor,
        '',
      );
      const srcIds = [c.paymentId, ...allocs.map((a) => a.id)];
      const legRows = await q(
        `SELECT a."key" AS k, coalesce(sum(jl."debitMinor" - jl."creditMinor"),0)::text AS net FROM journal_line jl JOIN account a ON a.id = jl."accountId" JOIN journal_entry je ON je.id = jl."journalEntryId" WHERE je."tenantId" = $1 AND je."sourceId" = ANY($2::text[]) GROUP BY a."key"`,
        [w.a.tenantId, srcIds],
      );
      const leg = (k) => BigInt(legRows.find((r) => r.k === k)?.net ?? '0');
      const amt = BigInt(c.amountMinor);
      const moneyIn =
        c.method === 'CASH'
          ? leg('ASSET.CASH_ON_HAND')
          : leg('ASSET.BANK') + leg('ASSET.PAYMENT_CLEARING');
      check(
        `${c.label}: journal — ${c.method === 'CASH' ? 'cash on hand' : 'bank / clearing'} debited ${amt}`,
        moneyIn === amt,
        String(moneyIn),
      );
      check(
        `${c.label}: journal — receivable control credited ${amt}`,
        leg('ASSET.ACCOUNTS_RECEIVABLE') === -amt,
        String(leg('ASSET.ACCOUNTS_RECEIVABLE')),
      );
      check(
        `${c.label}: journal — unapplied receipts net 0, no revenue and no VAT re-booked`,
        leg('LIABILITY.UNAPPLIED_RECEIPTS') === 0n &&
          leg('REVENUE.SALES') === 0n &&
          leg('LIABILITY.TAX_PAYABLE') === 0n,
        JSON.stringify(legRows),
      );
      collectedSoFar += amt;
      check(
        `${c.label}: the balance after on the receipt (${c.balanceAfterMinor}) = total invoiced − collected so far, from the tables`,
        (totalOwed - collectedSoFar).toString() === c.balanceAfterMinor,
        (totalOwed - collectedSoFar).toString(),
      );
    }
    // a lost response + retry must not have produced a second payment: exactly the collections made
    const dora = await q(
      `SELECT count(DISTINCT p.id)::int AS n FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = ANY($1::uuid[])`,
      [invs.map((i) => i.id)],
    );
    check(
      'Dora: exactly 2 payments exist for her invoices (the retried collection did not create a third)',
      dora[0].n === coll.collections.length,
      dora[0].n,
    );
    check(
      'Dora: both invoices are paid / settled at the end',
      invs.length === 2 &&
        (
          await q(`SELECT "invoicePaymentStatus" AS s FROM invoice WHERE id = ANY($1::uuid[])`, [
            invs.map((i) => i.id),
          ])
        ).every((r) => r.s === 'PAID' || r.s === 'SETTLED'),
      '',
    );
    // the register tables arrive with the Phase 4 migrations; before them no movement can exist
    const regTable = await q(`SELECT to_regclass('public.cash_movement') IS NOT NULL AS present`);
    const regMoves = regTable[0].present
      ? await q(`SELECT count(*)::int AS n FROM cash_movement WHERE "tenantId" = $1`, [
          w.a.tenantId,
        ])
      : [{ n: 0 }];
    check(
      'E-5 is inactive: no cash-register movement was written by any sale or collection',
      regMoves[0].n === 0,
      regMoves[0].n,
    );
  }
  // ── Owner Web customer credit: what the DATABASE recorded must equal what the owner and the cashier saw ──
  if (FOCUS_OWNER || oc.sales.length > 0) {
    check(
      'owner-credit journeys ran and reported their sales and credit saves',
      oc.sales.length === 2 && oc.saves.length === 3 && !!oc.final,
      `${oc.sales.length} sales, ${oc.saves.length} saves`,
    );
    const acc = await q(
      `SELECT id, "creditEnabled" AS enabled, "creditLimitMinor"::text AS lim, "creditLimitCurrencyCode" AS cur, version FROM customer_company_account WHERE "customerId" = $1`,
      [oliveId],
    );
    check('Olive: exactly one company account row', acc.length === 1, acc.length);
    const a = acc[0];
    check(
      `Olive: the stored credit state is what the owner last saw (enabled=${oc.final.enabled}, limit=${oc.final.limitMinor})`,
      a.enabled === oc.final.enabled && a.lim === oc.final.limitMinor,
      JSON.stringify(a),
    );
    check(
      'Olive: the stored limit is in the company currency (the client never sent one)',
      a.cur === 'AED',
      a.cur,
    );
    check(
      `Olive: the account version advanced exactly once per successful save (1 + ${oc.saves.length})`,
      a.version === 1 + oc.saves.length,
      `version ${a.version}`,
    );
    const audits = await q(
      `SELECT after FROM audit_log WHERE action = 'customer.credit_config_updated' AND "resourceId" = $1`,
      [a.id],
    );
    check(
      `Olive: exactly one credit-config audit row per successful save (${oc.saves.length}); refused and stale attempts left none`,
      audits.length === oc.saves.length,
      audits.length,
    );
    const inv = await q(
      `SELECT i.id, i."invoiceNumber" AS num, i."totalAmountMinor"::text AS total, o.id AS order_id FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE o."customerId" = $1 ORDER BY i."invoiceNumber"`,
      [oliveId],
    );
    check(
      `Olive: exactly the ${oc.sales.length} credit sales the cashier completed were invoiced — the refused ones (${oc.refusedSales}) left nothing`,
      inv.length === oc.sales.length &&
        oc.sales.every((s) =>
          inv.some((i) => i.num === s.invoiceNumber && i.total === s.totalMinor),
        ),
      JSON.stringify(inv.map((i) => [i.num, i.total])),
    );
    const owed = inv.reduce((s, i) => s + BigInt(i.total), 0n);
    check(
      `Olive: nothing was paid, so she owes ${owed} — the figure Owner Web showed (${oc.owedAtEndMinor})`,
      owed.toString() === oc.owedAtEndMinor,
      owed.toString(),
    );
    const paid = await q(
      `SELECT count(*)::int AS n FROM payment_allocation WHERE "invoiceId" = ANY($1::uuid[])`,
      [inv.map((i) => i.id)],
    );
    check('Olive: no payment was recorded against her credit invoices', paid[0].n === 0, paid[0].n);
    const recvIds = await q(
      `SELECT id FROM customer_receivable WHERE "invoiceId" = ANY($1::uuid[])`,
      [inv.map((i) => i.id)],
    );
    check(
      'Olive: one customer receivable per credit invoice',
      recvIds.length === inv.length,
      recvIds.length,
    );
    const srcIds = [
      ...inv.map((i) => i.id),
      ...inv.map((i) => i.order_id),
      ...recvIds.map((r) => r.id),
    ];
    const arRows = await q(
      `SELECT coalesce(sum(jl."debitMinor" - jl."creditMinor"),0)::text AS net FROM journal_line jl JOIN account ac ON ac.id = jl."accountId" JOIN journal_entry je ON je.id = jl."journalEntryId" WHERE je."tenantId" = $1 AND je."sourceId" = ANY($2::text[]) AND ac."key" = 'ASSET.ACCOUNTS_RECEIVABLE'`,
      [w.a.tenantId, srcIds],
    );
    check(
      `Olive: the ledger's receivable control for her invoices is ${owed} (equals what she owes)`,
      arRows[0].net === owed.toString(),
      arRows[0].net,
    );
  }
  const totals = await q(`SELECT count(*)::int AS invoices FROM invoice WHERE "tenantId" = $1`, [
    w.a.tenantId,
  ]);
  check(
    `the shop has exactly ${res.sales.length + credit.sales.length + coll.sales.length + oc.sales.length} invoices (no duplicates from retries)`,
    totals[0].invoices ===
      res.sales.length + credit.sales.length + coll.sales.length + oc.sales.length,
    totals[0].invoices,
  );
  // F-6: the unclassified legacy product was refused at the till — no order line for it was ever invoiced
  const fernSold = await q(
    `SELECT count(*)::int AS n FROM order_line ol JOIN invoice i ON i."orderId" = ol."orderId" WHERE ol."tenantId" = $1 AND ol."productNameEnSnapshot" = 'Legacy Fern'`,
    [w.a.tenantId],
  );
  check(
    'F-6: the product with no VAT category was never sold (0 invoiced lines)',
    fernSold[0].n === 0,
    fernSold[0].n,
  );
  if (!FOCUS) {
    // the Owner Web authenticator enrolment: exactly ONE confirmed TOTP factor for the second owner, nothing left pending
    const mfa2 = await q(
      `SELECT status, length("secretRef") AS len FROM mfa_factor WHERE "userId" = $1 ORDER BY status`,
      [JSON.parse(readFileSync(credsFile, 'utf8')).owner2.id],
    );
    check(
      'Owner Web enrolment: the second owner has exactly one CONFIRMED authenticator and none pending',
      mfa2.length === 1 && mfa2[0].status === 'CONFIRMED' && mfa2[0].len >= 16,
      JSON.stringify(mfa2),
    );
    // signing out (and the enrolment confirmation) REVOKE the server session — they do not just delete cookies
    const revoked = await q(
      `SELECT count(*)::int AS n FROM session WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`,
      [JSON.parse(readFileSync(credsFile, 'utf8')).owner2.id],
    );
    check(
      'Owner Web sign-out and the enrolment step revoke the server session (>= 2 revoked sessions for the second owner)',
      revoked[0].n >= 2,
      revoked[0].n,
    );
  }
  const unbalanced = await q(
    `SELECT count(*)::int AS n FROM (SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id WHERE je."tenantId" = $1 GROUP BY je.id HAVING sum(jl."debitMinor") <> sum(jl."creditMinor")) x`,
    [w.a.tenantId],
  );
  check('every journal entry of the shop balances', unbalanced[0].n === 0, unbalanced[0].n);
  console.log('\nDATABASE VERIFICATION');
  for (const c of checks)
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  ← ${c.detail}`}`);
  if (checks.some((c) => !c.ok)) exit = exit || 1;
} catch (err) {
  console.error(err);
  exit = 1;
} finally {
  try {
    await world?.h.close();
    await world?.pool.end();
  } catch {
    /* best effort */
  }
  await stack.stop();
  rmSync(credsFile, { force: true });
  // the per-journey result files are scratch output of THIS run (they live in an untracked folder — never leave them to be committed)
  for (const f of [resultFile, creditFile, collectionFile, ownerCreditFile])
    rmSync(f, { force: true });
}
process.exit(exit);
