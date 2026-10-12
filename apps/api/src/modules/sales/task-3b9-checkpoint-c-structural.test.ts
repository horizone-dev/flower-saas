import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 3b.9 Checkpoint C — structural pins.
 *
 * Checkpoint C adds exactly ONE production file — the internal anonymous PAY_NOW
 * orchestrator `modules/sales/atomic-walk-in-sale.service.ts` — and one narrow,
 * behaviour-preserving split of `TaxFinalizationService`. These tests read the
 * real source (comments stripped) so they cannot be satisfied by wording.
 *
 * `[CHECKPOINT-C SCOPE]` pins describe what C legitimately does NOT contain yet
 * (HTTP, module wiring, public idempotency, permissions, the sale-completed
 * event, customer-linked sales): the checkpoint that adds that surface replaces
 * the pin in the same change.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..'); // apps/api/src
const SALES = join(SRC, 'modules/sales');
const read = (abs: string): string => readFileSync(abs, 'utf8');

const SERVICE = join(SALES, 'atomic-walk-in-sale.service.ts');
const FINALIZATION = join(SRC, 'modules/orders/tax-finalization.service.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
function codeOnly(src: string): string {
  return stripComments(src)
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const specifiersOf = (abs: string): string[] =>
  [...stripComments(read(abs)).matchAll(IMPORT_RE)].map((m) => m[1]!);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
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
const sha256 = (abs: string): string =>
  createHash('sha256').update(read(abs).replace(/\r\n/g, '\n')).digest('hex');

/** the ANONYMOUS part of the service: its entry point + its primitive (Checkpoint D adds the customer path AFTER it) */
const ANON_START = '  async completeAnonymousPayNowForBranchScoped(';
const ANON_END = '  /**\n   * The conventional entry point of the identified-customer path';
function anonymousRegion(): string {
  const s = read(SERVICE);
  const a = s.indexOf(ANON_START);
  const b = s.indexOf(ANON_END);
  if (a < 0 || b < 0 || b < a) throw new Error('anonymous region markers not found');
  return s.slice(a, b);
}

describe('C — Checkpoint A and B production files are FROZEN (content-hash pins)', () => {
  const FROZEN: Record<string, string> = {
    'modules/orders/canonical-totals.ts':
      '231d09308fdf8002c6cbb7e9914050b331165bcb822cf9f45d2bb8c3761b35dd',
    // (comment-only edit at Checkpoint F: the header now names the field `issuedInvoice` and the real wiring)
    'modules/orders/order-invoice-summary.ts':
      '135fb272658f797f677bc33336768e5073d9349fe42b4eef2bbce109dde34549',
    'modules/sales/sale-plan.ts':
      'b5a437bef60dc62210c3d9315eca2bc22b76ef8abb6d5729c44cd216be74198d',
    'modules/sales/walk-in-sale-journal.ts':
      'a1c5eeadef8e32aeb8bb4d79fa9fb1c60c3b497aad31106b87ae182a1d33e547',
    'modules/sales/walk-in-sale-journal.repository.ts':
      '0335a9df9e07289d17be304284de3b4869adc71f72fa2f24ec993c4864cf510c',
  };
  for (const [file, hash] of Object.entries(FROZEN)) {
    it(`${file} is byte-identical to its approved version`, () => {
      expect(sha256(join(SRC, file))).toBe(hash);
    });
  }
});

describe('C — the orchestrator is the ONLY orchestrator file (closed-world; D adds only pure sale-authority metadata)', () => {
  it('modules/sales holds exactly the fifteen expected production files (E added the public surface)', () => {
    expect(
      productionFiles(SALES)
        .map((f) => relative(SALES, f).replace(/\\/g, '/'))
        .sort(),
    ).toEqual([
      'atomic-walk-in-sale.service.ts',
      'complete-sale-authority.guard.ts',
      'complete-sale-fingerprint.provider.ts',
      'complete-sale-response.ts',
      'dto/complete-sale.dto.ts',
      'order-totals-preview.repository.ts',
      'order-totals-preview.service.ts',
      'sale-authority.ts',
      'sale-events.ts',
      'sale-plan.ts',
      'sales-application.service.ts',
      'sales.controller.ts',
      'sales.module.ts',
      'walk-in-sale-journal.repository.ts',
      'walk-in-sale-journal.ts',
    ]);
  });

  it('[CHECKPOINT-C SCOPE, advanced by E] the orchestrator is provided by SalesModule alone and named only by that module and the thin facade; the root module never names it', () => {
    expect(read(join(SRC, 'app.module.ts'))).not.toMatch(/AtomicWalkInSale/);
    const mentions = productionFiles(SRC).filter((f) =>
      /AtomicWalkInSaleService/.test(stripComments(read(f))),
    );
    expect(mentions.map(rel).sort()).toEqual([
      'modules/sales/atomic-walk-in-sale.service.ts',
      'modules/sales/sales-application.service.ts',
      'modules/sales/sales.module.ts',
    ]);
    // and no existing order / payment route learned a sale endpoint
    for (const c of [
      join(SRC, 'modules/orders/order.controller.ts'),
      join(SRC, 'modules/payments/payment.controller.ts'),
    ]) {
      expect(read(c), rel(c)).not.toMatch(/complete-sale|\/totals|'totals'|completeAnonymous/);
    }
  });

  it('[CHECKPOINT-C SCOPE] no HTTP decorator, permission, step-up or public-idempotency machinery in the orchestrator', () => {
    const code = codeOnly(read(SERVICE));
    const src = stripComments(read(SERVICE));
    expect(code).not.toMatch(
      /@(Controller|Get|Post|Put|Patch|Delete|RequirePermission|Public|UseGuards|Body|Param|Query|Headers)\b/,
    );
    expect(src).not.toMatch(/@flower\/permissions|RequirePermission|'[a-z_]+:[a-z_]+'/);
    expect(src).not.toMatch(
      /common\/idempotency|IdempotencyInterceptor|Idempotency-Key|IdempotencyScope/,
    );
    expect(code).not.toMatch(/claim|replay/i);
    expect(code).not.toMatch(/StepUp|step-up|stepUp/);
  });
});

describe('C — ONE outer transaction, caller-owned primitive, no side channel of its own', () => {
  const src = stripComments(read(SERVICE));
  const code = codeOnly(read(SERVICE));

  it('opens exactly ONE scoped transaction per entry point (the anonymous one holds exactly one) and each primitive takes the caller tx', () => {
    expect(codeOnly(anonymousRegion()).match(/this\.scoped\s*\(/g)).toHaveLength(1);
    expect(code.match(/this\.scoped\s*\(/g)).toHaveLength(2); // anonymous + customer entry points
    expect(code).toMatch(/completeCustomerSaleInTx\s*\(\s*tx\s*:\s*ScopedTx\s*,/);
    expect(code).toMatch(/completeAnonymousPayNowInTx\s*\(\s*tx\s*:\s*ScopedTx\s*,/);
    expect(code).not.toMatch(/\$transaction|\brunScoped\b|\brunPlatform\b/);
    expect(src).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b/i);
  });

  it('writes NO row itself: SELECT-only SQL, no $executeRaw, no model write, no audit, no outbox, no sale event', () => {
    // (`FOR UPDATE` is a row LOCK on a SELECT, not a write)
    expect(src).not.toMatch(
      /\bINSERT\b|(?<!for\s)\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bALTER\b|\bDROP\b/i,
    );
    expect(src).not.toMatch(
      /\$executeRaw|\.create\(|\.update\(|\.delete\(|\.upsert\(|\.createMany\(/,
    );
    const raws = [...src.matchAll(/\$queryRaw<[^>]*>`\s*(\w+)/g)].map((m) => m[1]!.toUpperCase());
    expect(raws.length).toBeGreaterThan(0);
    expect(raws.every((w) => w === 'SELECT')).toBe(true);
    expect(code).not.toMatch(
      /\bAuditWriter\b|\bOutboxWriter\b|\.record\s*\(|\.enqueue\s*\(|\.emit\s*\(/,
    );
    expect(src).not.toMatch(/sale_completed|orders\.sale|eventType/);
  });

  it('performs no external I/O: no network, queue, cache, timer, clock, randomness', () => {
    expect(code).not.toMatch(/\bfetch\s*\(|\baxios\b|\bundici\b|\bhttp\b|\bhttps\b/);
    expect(code).not.toMatch(/\bRedis\b|\bBullMQ\b|\bQueue\b|\bsetTimeout\b|\bsetInterval\b/);
    expect(code).not.toMatch(
      /\bDate\b|\bClock\b|Date\.now|new Date|Math\.random|randomUUID|process\.env/,
    );
  });

  it('its import set is exactly the frozen collaborators (Checkpoint D adds the three 3b.6 ones) + context / data / errors / pure plan + sale-authority', () => {
    expect(specifiersOf(SERVICE).sort()).toEqual(
      [
        '@flower/db',
        '@nestjs/common',
        '../../common/context/index.js',
        '../../common/data/index.js',
        '../../common/errors/domain-error.js',
        '../orders/tax-finalization.service.js',
        '../payments/payment-collection.repository.js',
        '../receivables/credit-override-authorization.service.js',
        '../receivables/customer-advance-application.repository.js',
        '../receivables/customer-invoice-ar.repository.js',
        '../receivables/receivable-balance.repository.js',
        './sale-authority.js',
        './sale-plan.js',
        './walk-in-sale-journal.js',
        './walk-in-sale-journal.repository.js',
      ].sort(),
    );
    expect(src).toMatch(/import type \{ ScopedTx \} from '@flower\/db';/);
  });
});

describe('C — the ANONYMOUS path: PAY_NOW only, no provider, no inventory, no credit, no advance', () => {
  const src = stripComments(read(SERVICE));
  const code = codeOnly(read(SERVICE));
  const anonSrc = stripComments(anonymousRegion());
  const anonCode = codeOnly(anonymousRegion());

  it('the anonymous plan is anonymous and advance-free (the default party); ON_CREDIT, CustomerAdvance and customer AR never appear in it', () => {
    // the default party every anonymous plan uses, declared once at module level
    expect(code).toMatch(
      /const ANONYMOUS_PARTY[^=]*=\s*\{\s*customerId\s*:\s*null\s*,\s*advances\s*:\s*\[\]\s*\}/,
    );
    // the anonymous primitive calls the plan with NO party argument — it can only ever be anonymous
    expect(anonSrc).toMatch(/this\.planPayment\(input, totals\);/);
    expect(anonCode.match(/customerId\s*:\s*null/g)).toHaveLength(1); // the pure journal builder only
    expect(anonSrc).toMatch(/paymentIntent\s*:\s*'PAY_NOW'/);
    expect(anonSrc).not.toMatch(/ON_CREDIT/);
    // the ONE permitted mention: `issued.customerReceivableId` read only to ASSERT it is null
    const withoutNullAssertion = anonSrc.replace(/issued\.customerReceivableId !== null/g, '');
    expect(withoutNullAssertion).not.toMatch(
      /customer_advance|CustomerAdvance|customer_receivable|CustomerReceivable|customer_account_entry|invoice_ar|creditOverride|CreditOverride|credit-exposure|advance|invoiceAr/i,
    );
    expect(anonSrc.match(/customerReceivableId/g)).toHaveLength(1);
    expect(anonSrc).not.toMatch(/ASSET\.CUSTOMER_RECEIVABLE|CUSTOMER_ADVANCES|UNAPPLIED_RECEIPTS/);
  });

  it('no provider call, no provider-config lookup, no inventory call', () => {
    // (the frozen CreditOverrideAuthorizationService.authorize is a permission check, not a provider call)
    expect(code.replace(/this\.creditOverride\.authorize\(/g, '')).not.toMatch(
      /payment-provider|PaymentProvider|ProviderConfig|provider-config|webhook|\.(createIntent|authorize|capture|refund|getStatus|verifyWebhook)\s*\(/i,
    );
    expect(code).not.toMatch(/inventory|\bstock\b|reservation|availability|movement/i);
  });

  it('owns no accounting formula: no tender-account mapping, no revenue / tax / discount arithmetic, no money type', () => {
    expect(src).not.toMatch(
      /tender-account-mapping|resolveReceiptAccountKeyForTender|isProviderBackedTender/,
    );
    expect(src).not.toMatch(/'ASSET\.|"ASSET\.|'REVENUE\.|"REVENUE\.|'LIABILITY\.|"LIABILITY\./);
    expect(code).not.toMatch(
      /\bMoney\b|\bmulRatio\b|\bbps\b|\bBps\b|\bQuantity\b|\bexactLineTax\b|\breconcileDocumentTax\b/,
    );
    expect(code).not.toMatch(/totalAmountMinor\s*[-*/%]|[-*/%]\s*\w*totalAmountMinor/i);
    expect(code).not.toMatch(/taxTotalAmountMinor\s*[-*/%]|[-*/%]\s*\w*taxTotalAmountMinor/i);
    expect(code).not.toMatch(/subtotalAmountMinor\s*[-*/%]|documentDiscountAmountMinor\s*[-*/%]/i);
  });

  it('no float money, no business-type branching, no anonymous cancellation / refund workaround', () => {
    expect(code).not.toMatch(/\bNumber\s*\(|\bparseFloat\b|\bparseInt\b|\.toFixed\s*\(|\bMath\./);
    expect(code).not.toMatch(/(?<![\w.])\d+\.\d+(?![\w.])/);
    expect(read(SERVICE)).not.toMatch(/businessType|business_type|BusinessType/);
    expect(code).not.toMatch(/credit_?note|refund|cancel|voided|void_?sale|\bvoid[A-Z_]/i);
  });
});

describe('C — the ANONYMOUS work happens in the frozen order, each frozen step called exactly once', () => {
  const src = stripComments(read(SERVICE));
  // the body of the anonymous primitive only (the customer path and the helpers are not part of this sequence)
  const body = stripComments(
    anonymousRegion().slice(anonymousRegion().indexOf('async completeAnonymousPayNowInTx(')),
  );

  it('order lock/gate → canonical prepare → plan validation → issuance → capture → coverage check → walk-in journal', () => {
    const steps = [
      'this.lockAndGateOrder(',
      'this.finalization.prepareFinalization(',
      'this.planPayment(',
      'this.finalization.issuePrepared(',
      'this.collection.captureSynchronousTendersInTx(',
      'loadInvoiceBalance(',
      'buildWalkInSaleJournal(',
      'this.walkInJournal.postWalkInSaleJournalInTx(',
    ];
    const positions = steps.map((s) => body.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const s of steps) expect(body.split(s).length - 1, s).toBe(1);
    // …and in the whole file, under any receiver name: the walk-in journal is reachable from the ANONYMOUS
    // primitive ONLY (exactly one call site each); the steps both parties share appear once per path
    const counts: Record<string, number> = {
      prepareFinalization: 2,
      issuePrepared: 2,
      captureSynchronousTendersInTx: 2,
      postWalkInSaleJournalInTx: 1,
      buildWalkInSaleJournal: 1,
      planSale: 1,
    };
    for (const [call, expected] of Object.entries(counts)) {
      const n = src.match(new RegExp(String.raw`(?<![\w.])(?:[\w.]*\.)?${call}\s*\(`, 'g'));
      expect(n, call).toHaveLength(expected);
    }
  });

  it('the payment request is validated BEFORE the first number is allocated (planPayment precedes issuePrepared)', () => {
    expect(body.indexOf('this.planPayment(')).toBeLessThan(
      body.indexOf('this.finalization.issuePrepared('),
    );
  });

  it('never calls the one-shot finalizeAndIssueInvoice, and never writes a payment status', () => {
    expect(src).not.toMatch(/finalizeAndIssueInvoice/);
    expect(src).not.toMatch(/SET\s+"invoicePaymentStatus"/);
    expect(src).not.toMatch(
      /computeInvoiceCoverage|recomputeInvoicePaymentStatus|assertInvoicePaymentStatusTransition/,
    );
  });
});

describe('C — the TaxFinalizationService split is behaviour-preserving and adds no formula', () => {
  const src = stripComments(read(FINALIZATION));
  it('finalizeAndIssueInvoice is exactly prepareFinalization + issuePrepared', () => {
    const m = src.match(/async finalizeAndIssueInvoice\([\s\S]*?\n {2}\}\n/);
    expect(m).not.toBeNull();
    const fn = m![0];
    expect(fn).toMatch(/const prepared = await this\.prepareFinalization\(tx, input\);/);
    expect(fn).toMatch(/return this\.issuePrepared\(tx, prepared, input\);/);
    expect(fn.match(/this\./g)).toHaveLength(2);
  });
  it('the ONE canonical computation is still called exactly once, and no tax arithmetic leaked in', () => {
    expect(codeOnly(read(FINALIZATION)).match(/computeCanonicalTotals\s*\(/g)).toHaveLength(1);
    const imports = specifiersOf(FINALIZATION);
    expect(imports).not.toContain('./tax-arithmetic.js');
    expect(imports).not.toContain('./document-discount-allocation.js');
    expect(imports).not.toContain('@flower/money');
  });
  it('prepareFinalization writes nothing and allocates no number', () => {
    const start = src.indexOf('async prepareFinalization(');
    const end = src.indexOf('async issuePrepared(');
    const prepare = src.slice(start, end);
    expect(prepare).not.toMatch(
      /\.create\(|\.update\(|\.delete\(|\.upsert\(|INSERT|UPDATE "|document_number_counter|allocateNumber|\.record\(/,
    );
  });
});

describe('C — no migration 50, no Task 3b.10, RB-1 still open', () => {
  const migrationsDir = join(ROOT, 'packages/db/prisma/migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((n) => /^\d{14}_/.test(n))
    .sort();

  it('the migration chain is exactly the frozen 49 — the sale needed no new DB mechanism', () => {
    expect(migrations).toHaveLength(49);
    expect(migrations[48]).toBe('20261010120000_phase_3b8_currency_and_release_integrity');
    expect(
      migrations.filter((n) => /3b_?9|walk_?in_?sale|atomic_?sale|complete_?sale/i.test(n)),
    ).toEqual([]);
  });

  it('no Task 3b.10 artifact: no reporting / trial-balance file and no /reports route', () => {
    // Task 3b.10 (approved after the 3b.9 merge) owns `modules/reporting/`; this 3b.9 pin keeps guarding
    // everything else — no reporting / trial-balance artifact OUTSIDE that read-only module.
    expect(
      productionFiles(SRC).filter(
        (f) =>
          !/^modules\/reporting\//.test(rel(f)) && /reporting|trial-?balance|3b-?10/i.test(rel(f)),
      ),
    ).toEqual([]);
    for (const f of productionFiles(SRC).filter((x) => x.endsWith('.controller.ts'))) {
      expect(read(f), rel(f)).not.toMatch(/@Controller\([^)]*reports?\b/i);
    }
  });

  it('RB-1 stays open: the frozen 3b.8 walk-in post-invoice restriction is intact and recorded', () => {
    const repo = read(join(SRC, 'modules/orders/order.repository.ts'));
    expect(repo).toMatch(/WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE/);
    expect(repo).toMatch(
      /a walk-in \(no customer\) invoiced order cannot be cancelled — credit note issuance requires a customer-linked order/,
    );
    expect(read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'))).toMatch(/RB-1/);
    expect(existsSync(join(SALES, 'void-sale.ts'))).toBe(false);
  });
});
