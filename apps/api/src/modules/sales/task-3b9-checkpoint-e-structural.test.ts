import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planSale, SalePlanError } from './sale-plan.js';

/**
 * Task 3b.9 Checkpoint E — structural pins of the PUBLIC surface.
 *
 * Checkpoint E exposes the already-proven atomic-sale core over HTTP: one module, one
 * controller, a strict DTO, a conditional-authority guard, an idempotency fingerprint, a thin
 * application facade (dispatch + the sale-level event + response), a read-only totals preview and
 * the additive issued-invoice recovery read. These tests read the REAL source (comments
 * stripped) and content-hash every surface E must NOT change, so:
 *
 *   - a silent edit to the frozen orchestrator, the shared idempotency system, the global
 *     permission guard, the outbox writer, the realtime authorization or the permission registry
 *     fails loudly;
 *   - the trusted fields (`finalSaleOutstandingMinor`, `operationKey`, the customer, the scope)
 *     can never become client-suppliable;
 *   - there is exactly ONE financial orchestrator, ONE idempotency system and ONE event.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..'); // apps/api/src
const SALES = join(SRC, 'modules/sales');
const read = (abs: string): string => readFileSync(abs, 'utf8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
/** executable code only: comments gone, string / template contents blanked */
function codeOnly(src: string): string {
  return stripComments(src)
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === 'generated' ||
      name.startsWith('.')
    ) {
      continue;
    }
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}
const isTest = (abs: string): boolean => /\.(test|spec)\.ts$/.test(abs);
const productionFiles = (dir: string): string[] =>
  walk(dir).filter((f) => f.endsWith('.ts') && !isTest(f));
const rel = (abs: string): string => relative(SRC, abs).replace(/\\/g, '/');
const sha = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const sha256 = (abs: string): string => sha(read(abs));

const sales = (name: string): string => join(SALES, name);
const CONTROLLER = sales('sales.controller.ts');
const MODULE = sales('sales.module.ts');
const FACADE = sales('sales-application.service.ts');
const GUARD = sales('complete-sale-authority.guard.ts');
const PROVIDER = sales('complete-sale-fingerprint.provider.ts');
const DTO = sales('dto/complete-sale.dto.ts');
const RESPONSE = sales('complete-sale-response.ts');
const EVENTS = sales('sale-events.ts');
const PREVIEW_REPO = sales('order-totals-preview.repository.ts');
const PREVIEW_SERVICE = sales('order-totals-preview.service.ts');

/** the identifiers of an array property of a Nest module declaration */
function listOf(code: string, key: string): string[] {
  const m = code.match(new RegExp(String.raw`\b${key}:\s*\[([^\]]*)\]`));
  if (!m) throw new Error(`no ${key}: [...] in the module declaration`);
  return m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — every surface Checkpoint E must NOT change is byte-identical (content-hash pins)', () => {
  const FROZEN: Record<string, string> = {
    // the corrected-D orchestrator and its pure authority metadata: E only CALLS them
    'modules/sales/atomic-walk-in-sale.service.ts':
      '493391e8ca9ff69b7c686dd0261b3cd4790f1741d91375cce468c06c449319ab',
    'modules/sales/sale-authority.ts':
      '01783f20826838a02088ec970b305c876d22bf0a69400f97f0eb99626bc8c55e',
    // the ONE shared idempotency system — E extends it only through its documented opt-in provider hook
    'common/idempotency/idempotency.interceptor.ts':
      'd304b34d19cbd099af97c951430807a4236ad56c2d78791e8b9e4c62693426e4',
    'common/idempotency/idempotent.decorator.ts':
      '90cf3e34e5f1cc139c341aa809b0aca363f6eb41c44b00a4552d3aa60760c056',
    'common/idempotency/idempotency.repository.ts':
      '13ca3cb7908588d5190b7b7b52da553d49c476c1aa4e5795db125cccee50a082',
    'common/idempotency/idempotency.module.ts':
      '8228ce89333b94bbce6430fc04868236c5e832b710e89211ccd335cf542b386a',
    'common/idempotency/semantic-fingerprint.provider.ts':
      '6a85bf141926f3426aabe6a06e193ee7d66af10220da3e0a0ffc1df00dfd79c1',
    'common/idempotency/canonical-hash.ts':
      'ff7fb019aa9620513eea91652965fd6421b645a1b697f9217c7e8c6b521e2288',
    'common/idempotency/snapshot.ts':
      '33431e963e89998f6020d4e2a658d0a0e91f50e4e671bf00419c5811723f3ef7',
    // the global guard pipeline and the policy engine — never weakened for an idempotent replay
    'common/auth/permission.guard.ts':
      '55eef3431078efc1c6837960cbd1034d4928a5b06ab815cdc67e9d69052c80b8',
    'common/auth/pipeline.module.ts':
      '701574108256c585e3fa5c01b9002a88652c5a62543d24ded4b0bc48ca5855f3',
    'modules/access/policy-engine.ts':
      'c9f9da28608233496bcccb40e558f2b77883810e81dff0a1c11fe5abb241a8d7',
    // the outbox writer and the frozen payments.* event vocabulary
    'common/audit/outbox.writer.ts':
      'a1a20ad2fba4bfb1cf5ab386239fa900ae920f78d640a530bde8c6c67187007c',
    'modules/payments/payment-events.ts':
      '4b8d09f9e1e3e47853bc0c3f1c70c89f656406e2b9ceff6cc421543669fba527',
    // the posting engine (the sale facade never posts anything itself)
    'modules/accounting/posting-engine.service.ts':
      '16ce70384a3522177f4038c79aadea563526c92ea5166ceddb3f222d8de4cbc0',
    // the shared error filter and the If-Match / uuid helpers the route reuses
    'common/errors/all-exceptions.filter.ts':
      '37dba35380859c2fefbaac9fc9c31fb70dd04ea268fa1b4fc01458c2c73dae17',
    'modules/catalog/catalog-write.helpers.ts':
      '7feb7e3add2909d6ed80fc543b1a2931d837e1aa783d7f00676f5b31cdfa2827',
  };
  for (const [file, hash] of Object.entries(FROZEN)) {
    it(`${file} is unchanged`, () => {
      expect(sha256(join(SRC, file))).toBe(hash);
    });
  }

  it('realtime authorization and the worker envelope are unchanged — there is NO event allow-list to extend; the sale event is authorised by its scope fields alone', () => {
    expect(sha256(join(ROOT, 'apps/realtime/src/auth/topics.ts'))).toBe(
      'a91af7a3471dd2d33e0f9345bea9c488f98abdc696d7e4695114a87c53624b59',
    );
    expect(sha256(join(ROOT, 'apps/worker/src/outbox/envelope.ts'))).toBe(
      'd1c6738cc4cc140ba911a3ee4612e233a9dfbfc19891f534acc3a862052b2ef6',
    );
  });

  it('the permission registry is unchanged — Checkpoint E adds NO permission', () => {
    expect(sha256(join(ROOT, 'packages/permissions/src/index.ts'))).toBe(
      '20f66e4258f62899b67471a4f0e64fe84f8098a2dffe9a4b6575734729ed4c42',
    );
  });

  it('the migration chain is exactly the frozen 49 — the surface needed no new persistence', () => {
    const dir = join(ROOT, 'packages/db/prisma/migrations');
    const migrations = readdirSync(dir).filter((n) => !n.endsWith('.toml'));
    expect(migrations).toHaveLength(49);
    expect([...migrations].sort().pop()).toBe(
      '20261010120000_phase_3b8_currency_and_release_integrity',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — SalesModule wiring: the minimum imports, no duplicate provider, no cycle', () => {
  const code = stripComments(read(MODULE));

  it('imports exactly the five modules that own the frozen collaborators, and declares exactly its own providers', () => {
    expect(listOf(code, 'imports')).toEqual([
      'OrderModule',
      'PaymentModule',
      'ReceivablesModule',
      'AccountingModule',
      'AccessModule',
    ]);
    expect(listOf(code, 'controllers')).toEqual(['SalesController']);
    expect(listOf(code, 'providers')).toEqual([
      'AtomicWalkInSaleService',
      'WalkInSaleJournalRepository',
      'SalesApplicationService',
      'OrderTotalsPreviewRepository',
      'OrderTotalsPreviewService',
      'CompleteSaleFingerprintProvider',
      'CompleteSaleAuthorityGuard',
    ]);
    expect(code).not.toMatch(/\bexports\s*:/);
  });

  it('never re-declares a collaborator another module owns (Nest would create a COMPETING instance)', () => {
    const providers = listOf(code, 'providers');
    for (const owned of [
      'TaxFinalizationService',
      'PaymentCollectionRepository',
      'CustomerInvoiceArRepository',
      'CustomerAdvanceApplicationRepository',
      'CreditOverrideAuthorizationService',
      'PostingEngineService',
      'CompanyFinancialConfigRepository',
      'PolicyEngine',
      'OutboxWriter',
      'AuditWriter',
      'DbService',
    ]) {
      expect(providers, owned).not.toContain(owned);
    }
  });

  it('has no circular dependency and no forwardRef: no module but the root imports SalesModule', () => {
    for (const abs of productionFiles(SALES)) {
      expect(stripComments(read(abs)), rel(abs)).not.toMatch(/forwardRef/);
    }
    const importers = productionFiles(SRC)
      .filter((f) => /\bSalesModule\b/.test(stripComments(read(f))))
      .map(rel)
      .sort();
    expect(importers).toEqual(['app.module.ts', 'modules/sales/sales.module.ts']);
  });

  it('the three upstream modules export ONLY the one collaborator E needs from each (additive; the existing exports are kept)', () => {
    const orders = stripComments(read(join(SRC, 'modules/orders/order.module.ts')));
    expect(listOf(orders, 'exports')).toEqual(['TaxFinalizationService']);
    const payments = stripComments(read(join(SRC, 'modules/payments/payment.module.ts')));
    expect(listOf(payments, 'exports')).toEqual(['PaymentCollectionRepository']);
    const receivables = stripComments(read(join(SRC, 'modules/receivables/receivables.module.ts')));
    expect(listOf(receivables, 'exports')).toEqual([
      'CustomerInvoiceArRepository',
      'CreditOverrideAuthorizationService',
      'PaymentCustomerAttributionRepository',
      'CustomerReceiptEffectsRepository',
      'OpeningBalanceRepository',
      'CustomerAdvanceApplicationRepository',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the controller: scoped, permissioned, idempotent, and free of any financial logic', () => {
  const src = stripComments(read(CONTROLLER));
  const decorators = (anchor: string, until: string): string =>
    src.slice(src.indexOf(anchor), src.indexOf(until));
  const totalsDecorators = (): string => decorators("@Get(':orderId/totals')", 'async preview(');
  const completeDecorators = (): string =>
    decorators("@Post(':orderId/complete-sale')", 'async completeSale(');

  it('is mounted on the branch-nested orders path and declares exactly the two routes', () => {
    expect(src).toMatch(/@Controller\('companies\/:companyId\/branches\/:branchId\/orders'\)/);
    expect(src.match(/@Get\(/g)).toHaveLength(1);
    expect(src.match(/@Post\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/@(Put|Patch|Delete|Options|Head|All)\(/);
    expect(src).not.toMatch(/@Public\b/);
  });

  it('EVERY route carries an explicit permission and the established scoped-param resolution (branch comes from the route pipeline)', () => {
    expect(totalsDecorators()).toMatch(/@RequirePermission\('orders:view'\)/);
    expect(completeDecorators()).toMatch(/@RequirePermission\('orders:manage'\)/);
    for (const d of [totalsDecorators(), completeDecorators()]) {
      expect(d).toMatch(/@ScopedParam\(\{ company: 'companyId', branch: 'branchId' \}\)/);
    }
    expect(src.match(/@RequirePermission\(/g)).toHaveLength(2);
    expect(src.match(/@ScopedParam\(/g)).toHaveLength(2);
  });

  it('complete-sale: the conditional-authority guard + the shared idempotency scope with the If-Match-aware provider, 200', () => {
    const d = completeDecorators();
    expect(d).toMatch(/@UseGuards\(CompleteSaleAuthorityGuard\)/);
    expect(d).toMatch(
      /@Idempotent\(\{\s*scope: 'orders\.complete_sale',\s*semanticFingerprintProvider: CompleteSaleFingerprintProvider,?\s*\}\)/,
    );
    expect(d).toMatch(/@HttpCode\(200\)/);
    // the totals preview is a plain read: no idempotency, no guard
    expect(totalsDecorators()).not.toMatch(/@Idempotent|@UseGuards/);
  });

  it('the expected order version is the If-Match header via the established helpers — never a body value', () => {
    expect(src).toMatch(/@Headers\('if-match'\) ifMatch: string \| undefined/);
    expect(src).toMatch(/const expectedVersion = requireIfMatch\(parseIfMatch\(ifMatch\)\);/);
    expect(src).not.toMatch(/dto\.(version|expectedVersion)/);
  });

  it('trusted values come from the route pipeline / session only: no @Req, no raw body, no context read, nothing named tenant / actor / operationKey', () => {
    const code = codeOnly(read(CONTROLLER));
    expect(code).not.toMatch(/@Req\b|@Request\b|\breq\.body\b|\bgetContext\b|requireTenantContext/);
    expect(src.match(/@Body\(/g)).toHaveLength(1);
    expect(src).toMatch(/@Body\(new ZodBody\(completeSaleSchema\)\) dto: CompleteSaleDto/);
    expect(src).not.toMatch(
      /\btenantId\b|\bactorUserId\b|\boperationKey\b|\bposTerminalId\b|\bterminalId\b|finalSaleOutstanding|creditExposure/,
    );
    // the request Idempotency-Key is handed over as the nested operation identity, under its own name
    expect(src).toMatch(/@Headers\('idempotency-key'\) idempotencyKey: string \| undefined/);
  });

  it('holds NO financial logic: no tax / money / credit arithmetic, only the two decimal-string → BigInt conversions; it delegates to the facade and the preview service', () => {
    const code = codeOnly(read(CONTROLLER));
    expect(code).not.toMatch(/\bMoney\b|\bQuantity\b|Number\s*\(|parseFloat|\bMath\./);
    expect(src).not.toMatch(/AmountMinor\s*[-+*/%]|[-+*/%]\s*\w*AmountMinor/);
    expect(src.match(/BigInt\(/g)).toHaveLength(2);
    expect(src.match(/this\.sales\.completeSale\(/g)).toHaveLength(1);
    expect(src.match(/this\.totals\.preview\(/g)).toHaveLength(1);
    // it never reaches past the facade / preview service
    expect(src).not.toMatch(
      /AtomicWalkInSaleService|PaymentCollection|CustomerInvoiceAr|CustomerAdvance|CreditOverride|PostingEngine|computeCanonicalTotals|\$queryRaw|runScoped|ScopedTx/,
    );
  });

  it("the credit decision is NOT in the controller (nor the guard, provider or facade): the override is the frozen orchestrator's, via the frozen authorize()", () => {
    for (const abs of [CONTROLLER, GUARD, PROVIDER, FACADE]) {
      expect(stripComments(read(abs)), rel(abs)).not.toMatch(
        /\.authorize\(|CreditOverrideAuthorizationService|customers:credit:override|CUSTOMER_CREDIT_|AuthorizedCreditOverride/,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the DTO is strict and owns no authority', () => {
  const code = stripComments(read(DTO));

  it('every object schema is .strict() (an unknown / trusted field is a 400 — the repository DTO policy)', () => {
    expect(code.match(/\.object\(/g)).toHaveLength(3); // tender, advance application, body
    expect(code.match(/\.strict\(\)/g)).toHaveLength(3);
  });

  it('names NO scope, actor, customer, money-authority, server-owned or bypass field', () => {
    expect(code).not.toMatch(
      /\b(customerId|customerCompanyAccountId|customerReceivableId|tenantId|companyId|branchId|terminalId|posTerminalId|userId|actorUserId|operationKey|finalSaleOutstanding\w*|creditExposure\w*|creditOverride|override|force|bypass|currencyCode|currencyExponent|totalAmountMinor|taxTotalAmountMinor|subtotalAmountMinor|outstandingMinor|expectedVersion|version|paymentGroupId|providerCredentialId)\b/,
    );
  });

  it('the ONLY credit input is a reason; paymentIntent is required and closed; money is a decimal STRING, never a number', () => {
    expect(code.match(/creditLimitExceptionReason/g)).toHaveLength(1);
    expect(code).toMatch(/paymentIntent: z\.enum\(\['PAY_NOW', 'ON_CREDIT'\]\)/);
    // (the pattern must span the commas of the enum list on the same line)
    expect(code).not.toMatch(/paymentIntent:[^\n]*\.(default|optional)\(/);
    expect(code).toMatch(/\.regex\(\/\^\[1-9\]\\d\*\$\/,/);
    expect(code).not.toMatch(/z\.number\(|z\.coerce|z\.bigint\(|\.int\(\)/);
  });

  it('mirrors the frozen tender enum — ONLINE_GATEWAY and any provider-backed shape are unrepresentable', () => {
    expect(code).toMatch(
      /method: z\.enum\(\['CASH', 'BANK_TRANSFER', 'OTHER_MANUAL', 'CARD_TERMINAL'\]\)/,
    );
    // (`ON_CREDIT` is a paymentIntent, not a tender — only a CREDIT *tender method* is forbidden)
    expect(code).not.toMatch(/ONLINE_GATEWAY|'CREDIT'|providerCredential/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the idempotency fingerprint binds If-Match; there is ONE idempotency system', () => {
  const code = stripComments(read(PROVIDER));

  it('hashes the NORMALIZED semantic request including the expected version (If-Match), before any claim', () => {
    expect(code).toMatch(/implements SemanticFingerprintProvider/);
    expect(code).toMatch(/const expectedVersion = requireIfMatch\(/);
    expect(code).toMatch(/parseIfMatch\(/);
    expect(code).toMatch(/req\.headers\['if-match'\]/);
    // the returned semantic body carries it
    expect(code.slice(code.indexOf('return {'))).toMatch(/\bexpectedVersion,/);
    expect(code).toMatch(/completeSaleSchema\.safeParse\(req\.body\)/);
  });

  it('takes the tenant from the authenticated context and the scope from the route params — never from the body', () => {
    expect(code).toMatch(/getContext\(\)/);
    expect(code).toMatch(/params\?\.\['companyId'\]/);
    expect(code).toMatch(/params\?\.\['branchId'\]/);
    expect(code).toMatch(/params\?\.\['orderId'\]/);
    expect(code).not.toMatch(/\.body\??\.(tenantId|companyId|branchId|customerId)/);
  });

  it('there is exactly ONE use of the shared mechanism for this operation: one @Idempotent, one scope literal, no second store or claim', () => {
    const production = productionFiles(SRC).map((f) => ({ f, c: stripComments(read(f)) }));
    expect(
      production.filter((p) => /'orders\.complete_sale'/.test(p.c)).map((p) => rel(p.f)),
    ).toEqual(['modules/sales/sales.controller.ts']);
    for (const abs of productionFiles(SALES)) {
      const c = stripComments(read(abs));
      expect(c, rel(abs)).not.toMatch(
        /IdempotencyRepository|IdempotencyService|idempotency_key|claimToken|IDEMPOTENT_META/,
      );
    }
    expect(stripComments(read(CONTROLLER)).match(/@Idempotent\(/g)).toHaveLength(1);
  });

  it('is provided by SalesModule (the interceptor resolves it app-wide through ModuleRef)', () => {
    expect(listOf(stripComments(read(MODULE)), 'providers')).toContain(
      'CompleteSaleFingerprintProvider',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — conditional authority is a ROUTE GUARD (runs before any replay) through the one PolicyEngine', () => {
  const code = stripComments(read(GUARD));

  it('derives the implicated keys from the frozen PURE saleAuthorityRequirements and asks the shared PolicyEngine — no permission literal of its own', () => {
    expect(code).toMatch(/import \{ saleAuthorityRequirements \} from '\.\/sale-authority\.js'/);
    expect(code).toMatch(/import \{ PolicyEngine \} from '\.\.\/access\/policy-engine\.js'/);
    expect(code.match(/this\.engine\.can\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/'[a-z_]+:[a-z_]+(?::[a-z_]+)?'/);
  });

  it('fails closed: a malformed (non-array) tenders / advanceApplications value still implicates its key; it never grants the override', () => {
    expect(code).toMatch(/return Array\.isArray\(value\) \? value\.length : 1;/);
    expect(code).toMatch(/creditOverrideUsed: false/);
  });

  it('maps a deny exactly as the global PermissionGuard does (same codes / statuses)', () => {
    for (const c of [
      "'MODULE_NOT_ENTITLED'",
      "'STEP_UP_REQUIRED'",
      "'MISSING_PERMISSION'",
      "'COMPANY_OUT_OF_SCOPE'",
      "'BRANCH_OUT_OF_SCOPE'",
    ]) {
      expect(code).toContain(c);
    }
    expect(code).toMatch(/new NotFoundError\('resource'\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the facade is thin: dispatch + the sale-level event + the response, never a second orchestrator', () => {
  const src = stripComments(read(FACADE));
  const code = codeOnly(read(FACADE));
  const completeBody = (): string =>
    src.slice(
      src.indexOf('async completeSale('),
      src.indexOf('private async lockOrderAndReadCustomer('),
    );

  it('opens exactly ONE scoped transaction and dispatches to the two frozen in-Tx primitives, one call each', () => {
    expect(src).toMatch(/export class SalesApplicationService extends ScopedRepository/);
    expect(src.match(/this\.scoped\(/g)).toHaveLength(1);
    expect(src.match(/this\.atomicSale\.completeAnonymousPayNowInTx\(/g)).toHaveLength(1);
    expect(src.match(/this\.atomicSale\.completeCustomerSaleInTx\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/\$transaction|\brunScoped\b|\brunPlatform\b/);
  });

  it("dispatches on the ORDER'S persisted customer (read under the order lock), never on a client flag", () => {
    expect(src).toMatch(/SELECT "customerId" FROM "order"/);
    expect(src).toMatch(/FOR UPDATE/);
    expect(src).toMatch(/if \(customerId === null\) \{/);
    expect(src).not.toMatch(/command\.customer|dto\.customer|\.customerId\s*=/);
    // the order-lock read is exact-scope
    expect(src).toMatch(/"tenantId" = \$\{tenantId\}::uuid/);
    expect(src).toMatch(/"companyId" = \$\{command\.companyId\}::uuid/);
    expect(src).toMatch(/"originBranchId" = \$\{command\.branchId\}::uuid/);
  });

  it('contains NO tax / money / credit / exposure formula and NO payment, receivable, advance or journal write', () => {
    expect(code).not.toMatch(
      /\bMoney\b|totalAmountMinor|taxTotal|subtotalAmountMinor|finalSaleOutstanding|currentOutstandingMinor|advanceBalanceMinor|creditLimit(?!ExceptionReason)|planSale|computeCanonicalTotals|issuePrepared|prepareFinalization|captureSynchronousTendersInTx|applyInTx|postJournal|lockAndAuthorizeCredit|PostingEngine|AuditWriter/,
    );
    // (the one `FOR UPDATE` is the order-row LOCK of a SELECT — the only thing it may contain)
    expect(src.replace(/FOR UPDATE/g, '')).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
    expect(src.match(/FOR UPDATE/g)).toHaveLength(1);
    expect(src).not.toMatch(
      /"payment"|"payment_allocation"|"customer_advance|"customer_receivable"|"customer_account|"journal|"invoice"/,
    );
    expect(src.match(/\$queryRaw/g)).toHaveLength(2); // the two reads of `order`
    expect(src.match(/FROM "order"/g)).toHaveLength(2);
  });

  it("the anonymous path refuses an advance request with the frozen plan's own code (the anonymous primitive cannot carry one)", () => {
    expect(src).toMatch(/'SALE_ADVANCE_REQUIRES_CUSTOMER'/);
    expect(src.indexOf("'SALE_ADVANCE_REQUIRES_CUSTOMER'")).toBeLessThan(
      src.indexOf('this.atomicSale.completeAnonymousPayNowInTx('),
    );
  });

  it("the facade's anonymous-advance rejection is the frozen plan's OWN error — same code, message and status (it cannot drift)", () => {
    let planError: unknown;
    try {
      planSale({
        intent: 'PAY_NOW',
        customerId: null,
        total: { amountMinor: 1_000n, currencyCode: 'AED', currencyExponent: 2 },
        tenders: [
          {
            method: 'CASH',
            amountMinor: 600n,
            currencyCode: 'AED',
            currencyExponent: 2,
          },
        ],
        advances: [
          { advanceId: 'a-1', amountMinor: 400n, currencyCode: 'AED', currencyExponent: 2 },
        ],
      });
    } catch (err) {
      planError = err;
    }
    expect(planError).toBeInstanceOf(SalePlanError);
    const e = planError as SalePlanError;
    expect(e.code).toBe('SALE_ADVANCE_REQUIRES_CUSTOMER');
    const block = src.slice(src.indexOf("'SALE_ADVANCE_REQUIRES_CUSTOMER'"));
    const message = block.match(/'SALE_ADVANCE_REQUIRES_CUSTOMER',\s*'([^']+)',\s*(\d+),/);
    expect(message).not.toBeNull();
    expect(message![1]).toBe(e.message);
    expect(Number(message![2])).toBe(e.httpStatus);
  });

  it('operationKey is server-owned: it is the request Idempotency-Key and nothing else', () => {
    expect(src.match(/operationKey:/g)).toHaveLength(1);
    expect(src).toMatch(/operationKey: command\.idempotencyKey,/);
  });

  it('the credit-limit reason is passed through untouched and the authentication context goes to the frozen service only', () => {
    expect(src).toMatch(/creditLimitExceptionReason: command\.creditLimitExceptionReason/);
    expect(src).toMatch(/authorizationContext: ctx,/);
    expect(src).toMatch(/const ctx = getContext\(\) \?\? null;/);
  });

  it('the event is written INSIDE the sale transaction, AFTER the sale primitive and BEFORE the response — never by the controller after commit', () => {
    const b = completeBody();
    const enqueue = b.indexOf('await this.enqueueSaleCompleted(');
    expect(enqueue).toBeGreaterThan(b.indexOf('this.atomicSale.completeAnonymousPayNowInTx('));
    expect(enqueue).toBeGreaterThan(b.indexOf('this.atomicSale.completeCustomerSaleInTx('));
    expect(enqueue).toBeLessThan(b.indexOf('return toCompleteSaleResponse('));
    expect(src.match(/this\.outbox\.enqueue\(/g)).toHaveLength(1);
    expect(stripComments(read(CONTROLLER))).not.toMatch(/outbox|enqueue|OutboxWriter/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — orders.sale_completed: exactly one coarse, bounded, scoped event', () => {
  it('the vocabulary is exactly the one event; the payload is exactly two identifiers', () => {
    const code = stripComments(read(EVENTS));
    expect(code).toMatch(/export type SaleEventType = 'orders\.sale_completed';/);
    const payload = code.match(/export interface SaleCompletedPayload \{([\s\S]*?)\n\}/);
    expect(payload).not.toBeNull();
    expect(payload![1]!.match(/readonly \w+:/g)).toEqual([
      'readonly orderId:',
      'readonly invoiceId:',
    ]);
  });

  it('the literal appears only in the vocabulary file and the facade; the facade carries NO other event type', () => {
    const holders = productionFiles(SRC)
      .filter((f) => /'orders\.sale_completed'/.test(stripComments(read(f))))
      .map(rel)
      .sort();
    expect(holders).toEqual([
      'modules/sales/sale-events.ts',
      'modules/sales/sales-application.service.ts',
    ]);
    const events = [...stripComments(read(FACADE)).matchAll(/'([a-z]+(?:\.[a-z_]+)+)'/g)].map(
      (m) => m[1],
    );
    expect(events).toEqual(['orders.sale_completed']);
  });

  it('it is scoped to tenant + company + branch (defence in depth), versioned, and carries only the bounded payload', () => {
    const m = stripComments(read(FACADE));
    const call = m.slice(m.indexOf('await this.outbox.enqueue('));
    expect(call).toMatch(/aggregateType: 'order',/);
    expect(call).toMatch(/aggregateId: command\.orderId,/);
    expect(call).toMatch(/eventType: 'orders\.sale_completed' satisfies SaleEventType,/);
    expect(call).toMatch(/tenantId,/);
    expect(call).toMatch(/companyId: command\.companyId,/);
    expect(call).toMatch(/branchId: command\.branchId,/);
    expect(call).toMatch(/resourceVersion: version,/);
    expect(call).toMatch(/\} satisfies SaleCompletedPayload,/);
    expect(call.slice(0, call.indexOf('satisfies SaleCompletedPayload'))).toMatch(
      /payload: \{\s*orderId: command\.orderId,\s*invoiceId,\s*\}/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the totals preview is read-only and shares the ONE canonical computation', () => {
  const src = stripComments(read(PREVIEW_REPO));

  it('is a single read statement: no lock, no write, no audit, no outbox', () => {
    expect(src.match(/\$queryRaw/g)).toHaveLength(1);
    expect(src).not.toMatch(
      /FOR UPDATE|FOR SHARE|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\boutbox\b|\baudit\b|AuditWriter|OutboxWriter|allocateNumber/i,
    );
  });

  it('is scoped by explicit tenant / company / origin-branch predicates (RLS on orders is tenant-only)', () => {
    expect(src).toMatch(/o\."tenantId" = \$\{tenantId\}::uuid/);
    expect(src).toMatch(/o\."companyId" = \$\{input\.companyId\}::uuid/);
    expect(src).toMatch(/o\."originBranchId" = \$\{input\.branchId\}::uuid/);
    expect(src).toMatch(/requireTenantContext\(\)/);
  });

  it('calls the ONE canonical Checkpoint-A computation and its wire mapper — no formula of its own; only finalization and the preview ever call it', () => {
    expect(src).toMatch(/computeCanonicalTotals\(head, lines\)/);
    expect(src).toMatch(/toOrderTotalsPreview\(head, result\)/);
    expect(codeOnly(read(PREVIEW_REPO))).not.toMatch(
      /\bMoney\b|mulRatio|allocateDocumentDiscount|exactLineTax/,
    );
    const callers = productionFiles(SRC)
      .filter((f) => /computeCanonicalTotals\(/.test(stripComments(read(f))))
      .map(rel)
      .sort();
    expect(callers).toEqual([
      'modules/orders/canonical-totals.ts',
      'modules/orders/tax-finalization.service.ts',
      'modules/sales/order-totals-preview.repository.ts',
    ]);
  });

  it('the preview service is a pass-through', () => {
    const s = stripComments(read(PREVIEW_SERVICE));
    expect(s.match(/this\.repo\.previewForBranchScoped\(/g)).toHaveLength(1);
    expect(codeOnly(read(PREVIEW_SERVICE))).not.toMatch(
      /\$queryRaw|runScoped|computeCanonicalTotals/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the Order GET recovery read: additive, invoice-sourced, five fields', () => {
  const repoText = read(join(SRC, 'modules/orders/order.repository.ts'));
  const blocks = [
    ...repoText.matchAll(/\/\/ 3b\.9-order-invoice:begin([\s\S]*?)\/\/ 3b\.9-order-invoice:end/g),
  ].map((m) => m[1]!);

  it('is exactly TWO marked blocks in the frozen repository (the import + ONE new method)', () => {
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(/import \{ toOrderInvoiceSummary, type OrderInvoiceSummary \}/);
    expect(blocks[1]).toMatch(/async getWithIssuedInvoiceForBranchScoped\(/);
  });

  it('the method reads ONLY the issued invoice (exact scope), maps it with the frozen pure mapper, and writes / locks / reads nothing else', () => {
    const m = stripComments(blocks[1]!);
    expect(m).toMatch(/FROM "invoice"/);
    expect(m).toMatch(/"orderId" = \$\{order\.id\}::uuid/);
    expect(m).toMatch(/"tenantId" = \$\{tenantId\}::uuid/);
    expect(m).toMatch(/"companyId" = \$\{input\.companyId\}::uuid/);
    expect(m).toMatch(/"branchId" = \$\{input\.branchId\}::uuid/);
    expect(m).toMatch(/toOrderInvoiceSummary\(invoices\[0\] \?\? null\)/);
    expect(m).not.toMatch(
      /"payment\w*"|\bpayment_\w+|customer_\w+|journal|receivable|advance|FOR UPDATE|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i,
    );
    expect(m.match(/\$queryRaw/g)).toHaveLength(1);
  });

  it('the Order service and controller expose it under the existing orders:view route, as `issuedInvoice`', () => {
    expect(stripComments(read(join(SRC, 'modules/orders/order.service.ts')))).toMatch(
      /return this\.repo\.getWithIssuedInvoiceForBranchScoped\(input\);/,
    );
    const controller = stripComments(read(join(SRC, 'modules/orders/order.controller.ts')));
    const get = controller.slice(
      controller.indexOf("@Get(':id')"),
      controller.indexOf("@Patch(':id')"),
    );
    expect(get).toMatch(/@RequirePermission\('orders:view'\)/);
    expect(get).toMatch(/issuedInvoice/);
    expect(get).toMatch(
      /return \{ order: serializeOrder\(order\), lines: lines\.map\(serializeLine\), issuedInvoice \};/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the response exposes stable business results only', () => {
  const code = stripComments(read(RESPONSE));
  it('names no credit-gate structure, journal, operationKey, exposure parameter, customer id, authority metadata or idempotency id', () => {
    // (the doc comment lists what is withheld; only CODE is checked)
    expect(code).not.toMatch(
      /creditAuthorizationMode|authorities|journalEntryId|operationKey|finalSaleOutstanding|customerId|customerCompanyAccountId|idempotency|claimToken/,
    );
  });
  it('renders every Money value as a decimal string (.toString()) and holds no formula', () => {
    // subtotal, discount, tax, total, outstanding, tender amount, advance amount
    expect(code.match(/\.toString\(\)/g)!.length).toBeGreaterThanOrEqual(7);
    expect(codeOnly(read(RESPONSE))).not.toMatch(/Number\s*\(|parseFloat|\bMath\.|\bMoney\b/);
    expect(code).not.toMatch(/AmountMinor\s*[-+*/%]|[-+*/%]\s*\w*AmountMinor/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the trusted fields and the single-orchestrator rule (closed world over the whole API)', () => {
  it('finalSaleOutstandingMinor still lives ONLY in the issuance primitive, the finalization pass-through and the orchestrator — never in a controller, DTO or the new surface', () => {
    const holders = productionFiles(SRC)
      .filter((f) => /finalSaleOutstandingMinor/.test(stripComments(read(f))))
      .map(rel)
      .sort();
    expect(holders).toEqual([
      'modules/orders/invoice-issuance.repository.ts',
      'modules/orders/tax-finalization.service.ts',
      'modules/sales/atomic-walk-in-sale.service.ts',
    ]);
  });

  it('operationKey is named by no controller, DTO, guard, provider or response — it stays server-owned and opaque', () => {
    for (const abs of [CONTROLLER, DTO, GUARD, PROVIDER, RESPONSE]) {
      expect(stripComments(read(abs)), rel(abs)).not.toMatch(/operationKey/);
    }
  });

  it("the frozen in-Tx primitives are CALLED from outside the orchestrator only by the facade (the orchestrator's own scoped entry points call them internally)", () => {
    for (const call of ['completeAnonymousPayNowInTx', 'completeCustomerSaleInTx']) {
      const callers = productionFiles(SRC)
        .filter((f) => !f.endsWith('atomic-walk-in-sale.service.ts'))
        .filter((f) => new RegExp(String.raw`\.${call}\(`).test(stripComments(read(f))))
        .map(rel);
      expect(callers, call).toEqual(['modules/sales/sales-application.service.ts']);
    }
  });

  it('there is one financial orchestrator: nothing outside the frozen orchestrator composes issuance + capture + advance + journal', () => {
    const composes = productionFiles(SALES)
      .filter((f) => {
        const c = stripComments(read(f));
        return /issuePrepared\(/.test(c) && /captureSynchronousTendersInTx\(/.test(c);
      })
      .map(rel);
    expect(composes).toEqual(['modules/sales/atomic-walk-in-sale.service.ts']);
    for (const abs of [
      CONTROLLER,
      FACADE,
      GUARD,
      PROVIDER,
      PREVIEW_REPO,
      PREVIEW_SERVICE,
      RESPONSE,
    ]) {
      expect(stripComments(read(abs)), rel(abs)).not.toMatch(
        /planSale\(|issuePrepared\(|captureSynchronousTendersInTx\(|applyInTx\(|postWalkInSaleJournalInTx\(|buildWalkInSaleJournal\(|lockAndAuthorizeCredit\(/,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — still forbidden: provider execution, inventory, a new app, anonymous refund / void, Task 3b.10 / Checkpoint F work', () => {
  it('no provider execution, inventory or reporting reaches the sale surface', () => {
    for (const abs of productionFiles(SALES)) {
      expect(codeOnly(read(abs)), rel(abs)).not.toMatch(
        /PaymentProviderRegistry|ProviderConfigRepository|PaymentProviderPort|WebhookRecovery|\binventory\b|stock_movement|\breporting\b/i,
      );
    }
  });

  it('no new app: the four user-facing web apps + the runtime roles are exactly the frozen set (no Staff App, no fifth / sixth app)', () => {
    expect(readdirSync(join(ROOT, 'apps')).sort()).toEqual([
      'api',
      'customer-web',
      'owner-web',
      'pos-pwa',
      'realtime',
      'scheduler',
      'super-admin-web',
      'worker',
    ]);
  });

  it('RB-1 stays open (no anonymous refund / void) and HG3b-SALE-LATENCY stays an open Phase-3 final hard gate', () => {
    const plan = read(join(ROOT, 'docs/phase-3/PHASE-3B-PLAN.md'));
    expect(plan).toMatch(
      /HG3b-SALE-LATENCY[^\n]*Phase-3 FINAL hard gate[^\n]*non-production benchmark/,
    );
    const task = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
    expect(task).toMatch(/RB-1/);
    // the frozen 3b.8 restriction is still what answers an anonymous post-invoice cancellation
    expect(read(join(SRC, 'modules/orders/order.repository.ts'))).toMatch(
      /a walk-in \(no customer\) invoiced order cannot be cancelled — credit note issuance requires a customer-linked order/,
    );
    for (const abs of productionFiles(SALES)) {
      expect(codeOnly(read(abs)), rel(abs)).not.toMatch(
        /credit_?note|refund|cancel|voided|void_?sale|\bvoid[A-Z_]/i,
      );
    }
  });

  it('no Task 3b.10 / Checkpoint F artifact exists', () => {
    expect(existsSync(join(SRC, 'modules/reporting'))).toBe(false);
    expect(existsSync(join(SRC, 'modules/sales/reporting'))).toBe(false);
    const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
    expect(plan).not.toMatch(/Checkpoint F[^\n]*\*\*done\*\*/);
  });
});
