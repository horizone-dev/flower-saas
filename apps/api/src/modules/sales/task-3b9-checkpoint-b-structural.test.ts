import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 3b.9 Checkpoint B — structural pins.
 *
 * Checkpoint B adds exactly ONE production file: the caller-transaction posting
 * adapter `modules/sales/walk-in-sale-journal.repository.ts`. These tests read the
 * real source (comments stripped) so they cannot be satisfied by wording. The
 * Checkpoint A pins (`task-3b9-checkpoint-a-structural.test.ts`) keep running
 * unchanged — the pure modules stay DB-free, no float money, one revenue
 * convention, no business-type branching, no anonymous cancellation workaround.
 *
 * Pins marked `[CHECKPOINT-B SCOPE]` describe what B legitimately does NOT yet
 * contain (module wiring, HTTP, orchestration): the checkpoint that adds that
 * surface replaces the pin in the same change.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..'); // apps/api/src
const SALES = join(SRC, 'modules/sales');
const read = (abs: string): string => readFileSync(abs, 'utf8');

const REPO = join(SALES, 'walk-in-sale-journal.repository.ts');
const PURE_JOURNAL = join(SALES, 'walk-in-sale-journal.ts');
const PURE_PLAN = join(SALES, 'sale-plan.ts');

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

function importClosure(entry: string): Set<string> {
  const files = new Set<string>();
  const visit = (abs: string): void => {
    if (files.has(abs)) return;
    files.add(abs);
    for (const spec of specifiersOf(abs)) {
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(abs), spec).replace(/\.js$/, '.ts');
      if (!existsSync(target)) throw new Error(`unresolved import ${spec} from ${abs}`);
      visit(target);
    }
  };
  visit(entry);
  return files;
}

describe('B — the adapter is the only Checkpoint-B production file (closed-world; C adds exactly the orchestrator)', () => {
  it("modules/sales holds exactly the fifteen expected production files (the A/B/C/D core + Checkpoint E's public surface — see task-3b9-checkpoint-e-structural.test.ts for what each may contain)", () => {
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

  it('[CHECKPOINT-B SCOPE, advanced by E] the HTTP surface is exactly SalesController + SalesModule, the only ORCHESTRATOR is still the internal Checkpoint-C service, and the adapter is named only by it and by the module that provides it', () => {
    const sales = walk(SALES);
    const base = (f: string): string => f.replace(/\\/g, '/').split('/').pop()!;
    expect(
      sales
        .filter((f) => /\.controller\.ts$|\.module\.ts$/.test(f))
        .map(base)
        .sort(),
    ).toEqual(['sales.controller.ts', 'sales.module.ts']);
    expect(sales.filter((f) => /orchestrat|sale\.service|sale-?flow/i.test(f)).map(base)).toEqual([
      'atomic-walk-in-sale.service.ts',
    ]);
    // the adapter is provided by SalesModule and consumed ONLY by the orchestrator
    const mentions = productionFiles(SRC).filter((f) =>
      /WalkInSaleJournalRepository/.test(stripComments(read(f))),
    );
    expect(mentions.map(rel).sort()).toEqual([
      'modules/sales/atomic-walk-in-sale.service.ts',
      'modules/sales/sales.module.ts',
      'modules/sales/walk-in-sale-journal.repository.ts',
    ]);
  });

  it('[CHECKPOINT-B SCOPE] no HTTP decorator in the adapter and no totals / complete-sale route on the order controller', () => {
    expect(codeOnly(read(REPO))).not.toMatch(
      /@(Controller|Get|Post|Put|Patch|Delete|RequirePermission|Public|UseGuards)\b/,
    );
    expect(read(join(SRC, 'modules/orders/order.controller.ts'))).not.toMatch(
      /complete-sale|\/totals|'totals'/,
    );
  });
});

describe('B — a caller-transaction primitive: it never owns the transaction', () => {
  const code = codeOnly(read(REPO));

  it('takes the caller `tx: ScopedTx` and opens / commits / rolls back nothing', () => {
    expect(code).toMatch(/postWalkInSaleJournalInTx\s*\(\s*tx\s*:\s*ScopedTx\s*,/);
    expect(code).not.toMatch(/\$transaction|\brunScoped\b|\bScopedRepository\b|\bDbService\b/);
    expect(code).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b|\.begin\s*\(/i);
    expect(stripComments(read(REPO))).not.toMatch(
      /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b/i,
    );
  });

  it('performs no external I/O and no side channel: no network, queue, cache, timer, clock, randomness, audit, outbox, realtime', () => {
    expect(code).not.toMatch(/\bfetch\s*\(|\baxios\b|\bundici\b|\bhttp\b|\bhttps\b/);
    expect(code).not.toMatch(/\bRedis\b|\bBullMQ\b|\bQueue\b|\bsetTimeout\b|\bsetInterval\b/);
    expect(code).not.toMatch(/\bDate\b|\bClock\b|Date\.now|new Date|Math\.random|randomUUID/);
    expect(code).not.toMatch(/\bAuditWriter\b|\bOutboxWriter\b|\baudit\b|\boutbox\b|\bemit\s*\(/);
    expect(code).not.toMatch(/process\.env/);
  });

  it('its import set is exactly the engine, the company config, the pure plan, money, errors, Nest and the ScopedTx type', () => {
    expect(specifiersOf(REPO).sort()).toEqual(
      [
        '@flower/db',
        '@flower/money',
        '@nestjs/common',
        '../../common/errors/domain-error.js',
        '../accounting/company-financial-config.repository.js',
        '../accounting/posting-engine.service.js',
        './walk-in-sale-journal.js',
      ].sort(),
    );
    // `@flower/db` is a TYPE import only (no runtime Prisma in the adapter)
    expect(stripComments(read(REPO))).toMatch(/import type \{ ScopedTx \} from '@flower\/db';/);
  });

  it('only SELECTs: no INSERT / UPDATE / DELETE / DDL and no $executeRaw — every write goes through the engine', () => {
    const src = stripComments(read(REPO));
    expect(src).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bALTER\b|\bDROP\b/i);
    expect(src).not.toMatch(/\$executeRaw|\.create\(|\.update\(|\.delete\(|\.upsert\(/);
    const raws = [...src.matchAll(/\$queryRaw<[^>]*>`\s*(\w+)/g)].map((m) => m[1]!.toUpperCase());
    expect(raws.length).toBeGreaterThan(0);
    expect(raws.every((w) => w === 'SELECT')).toBe(true);
  });
});

describe('B — the ONE posting engine, used once, for the one source kind', () => {
  const code = codeOnly(read(REPO));
  const src = stripComments(read(REPO));

  it('is constructed over the frozen PostingEngineService and calls postJournal exactly once', () => {
    expect(code).toMatch(/private readonly postingEngine\s*:\s*PostingEngineService/);
    expect(code.match(/\.postJournal\s*\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/new PostingEngineService|extends PostingEngineService/);
  });

  it('writes no journal row itself: no journal_entry / journal_line / account SQL, no second journal writer', () => {
    expect(src).not.toMatch(/journal_entry|journal_line|"journalEntry"|"journalLine"/);
    expect(src).not.toMatch(/reverseJournal|postReversal|sealJournal/);
  });

  it('the source kind is the Checkpoint-A constant and the source id is the invoice id — no other sourceKind literal exists', () => {
    expect(code).toMatch(/plan\.sourceKind/);
    expect(code).toMatch(/plan\.sourceId/);
    expect(src).not.toMatch(/'walk_in_sale'|"walk_in_sale"/);
    // and no other production file (outside the pure builder that defines it) names the literal
    const naming = productionFiles(SRC).filter((f) => /walk_in_sale/.test(stripComments(read(f))));
    expect(naming.map(rel)).toEqual(['modules/sales/walk-in-sale-journal.ts']);
  });

  it('the posting date is the trusted invoice date — never a clock, never a request value', () => {
    expect(code).toMatch(/accountingDate\s*:\s*invoice\.invoiceDate/);
  });

  it('scope comes from the trusted invoice row in EXACT tenant / company / branch scope', () => {
    expect(src).toMatch(/i\."tenantId" = \$\{input\.tenantId\}/);
    expect(src).toMatch(/i\."companyId" = \$\{input\.companyId\}/);
    expect(src).toMatch(/i\."branchId" = \$\{input\.branchId\}/);
    expect(code).toMatch(/branchId\s*:\s*invoice\.branchId/);
    expect(code).toMatch(/invoice\.posTerminalId/);
  });

  it('a zero-value sale is rejected BEFORE the engine, and there is no zero-value accounting path', () => {
    const zero = src.indexOf('SALE_ZERO_TOTAL_NOT_SUPPORTED');
    const post = src.indexOf('.postJournal(');
    expect(zero).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(zero);
    for (const abs of productionFiles(SALES)) {
      expect(codeOnly(read(abs)), rel(abs)).not.toMatch(
        /complimentary|zero_?value|freeSale|free_sale|compSale|zeroTotalJournal|zero_?total_?journal/i,
      );
    }
  });

  it('the customer-linked gate and the plan-consistency gate also run BEFORE the engine', () => {
    const post = src.indexOf('.postJournal(');
    for (const marker of [
      'WALK_IN_JOURNAL_CUSTOMER_LINKED',
      'WALK_IN_JOURNAL_ORDER_KIND_UNSUPPORTED',
      'WALK_IN_JOURNAL_PLAN_INVALID',
      'WALK_IN_JOURNAL_PLAN_MISMATCH',
      'WALK_IN_JOURNAL_CURRENCY_MISMATCH',
    ]) {
      const at = src.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      expect(at, marker).toBeLessThan(post);
    }
  });
});

describe('B — it owns no accounting formula and no provider / inventory / receivables / advance behaviour', () => {
  const src = stripComments(read(REPO));
  const code = codeOnly(read(REPO));

  it('no tender-account mapping, no revenue / tax formula, no money arithmetic type', () => {
    expect(src).not.toMatch(/tender-account-mapping|resolveReceiptAccountKeyForTender/);
    expect(src).not.toMatch(/\.\/tender\.js|isProviderBackedTender|isTenderMethod/);
    expect(src).not.toMatch(/'ASSET\.|"ASSET\.|'REVENUE\.|"REVENUE\.|'LIABILITY\.|"LIABILITY\./);
    expect(code).not.toMatch(
      /\bMoney\b|\bmulRatio\b|\bbps\b|\bBps\b|\bQuantity\b|\bexactLineTax\b/,
    );
    // no revenue = total − tax, and no arithmetic on the invoice's total / tax figures
    expect(code).not.toMatch(/totalAmountMinor\s*[-*/%]|[-*/%]\s*\w*totalAmountMinor/i);
    expect(code).not.toMatch(/taxTotalAmountMinor\s*[-*/%]|[-*/%]\s*\w*taxTotalAmountMinor/i);
  });

  it('only the exported Checkpoint-A constants decide which accounts a plan may carry', () => {
    expect(src).toMatch(/DEBIT_ACCOUNT_ORDER/);
    expect(src).toMatch(/REVENUE_ACCOUNT_KEY/);
    expect(src).toMatch(/TAX_PAYABLE_ACCOUNT_KEY/);
  });

  it('no provider call, no inventory call, no CustomerAdvance mutation, no customer AR / receivable posting', () => {
    expect(code).not.toMatch(
      /payment-provider|PaymentProvider|provider|webhook|\.(createIntent|authorize|capture|refund|getStatus|verifyWebhook)\s*\(/i,
    );
    expect(code).not.toMatch(/inventory|\bstock\b|reservation|availability|movement/i);
    expect(src).not.toMatch(
      /customer_advance|CustomerAdvance|customer_receivable|CustomerReceivable|customer_account_entry|CustomerAccountEntry|invoice_ar|invoiceAr/i,
    );
    expect(src).not.toMatch(/ASSET\.CUSTOMER_RECEIVABLE|CUSTOMER_ADVANCES|UNAPPLIED_RECEIPTS/);
  });

  it('no float money, no business-type branching, no permission, no anonymous cancellation workaround', () => {
    expect(code).not.toMatch(/\bNumber\s*\(|\bparseFloat\b|\bparseInt\b|\.toFixed\s*\(|\bMath\./);
    expect(code).not.toMatch(/(?<![\w.])\d+\.\d+(?![\w.])/);
    expect(src).not.toMatch(/businessType|business_type|BusinessType/);
    expect(src).not.toMatch(/@flower\/permissions|RequirePermission|'[a-z_]+:[a-z_]+'/);
    expect(code).not.toMatch(/credit_?note|refund|cancel|voided|void_?sale|\bvoid[A-Z_]/i);
  });
});

describe('B — the Checkpoint A pure modules stay pure and do not depend on the adapter', () => {
  for (const abs of [PURE_JOURNAL, PURE_PLAN]) {
    it(`${rel(abs)} does not import (even transitively) the adapter, the engine, the DB or Nest`, () => {
      const closure = [...importClosure(abs)].map(rel);
      expect(
        closure.filter((f) => /accounting\/|\.repository\.|\.service\.|\.module\./.test(f)),
      ).toEqual([]);
      const bare = specifiersOf(abs).filter((s) => !s.startsWith('.'));
      expect(bare.filter((b) => /@flower\/db|prisma|nestjs/.test(b))).toEqual([]);
    });
  }
});

describe('B — no migration 50, no Task 3b.10', () => {
  const migrationsDir = join(ROOT, 'packages/db/prisma/migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((n) => /^\d{14}_/.test(n))
    .sort();

  it('[CHECKPOINT-B SCOPE] the migration chain is exactly the frozen 49 — idempotency came from the existing source-key uniqueness, not a new mechanism', () => {
    expect(migrations).toHaveLength(49);
    expect(migrations[48]).toBe('20261010120000_phase_3b8_currency_and_release_integrity');
    expect(
      migrations.filter((n) => /3b_?9|walk_?in_?sale|atomic_?sale|complete_?sale/i.test(n)),
    ).toEqual([]);
  });

  it('the idempotency the adapter relies on is the existing unique (tenant, company, sourceKind, sourceId) index', () => {
    const accounting = read(
      join(migrationsDir, '20260915120000_accounting_coa_posting_periods/migration.sql'),
    );
    expect(accounting).toMatch(
      /CREATE UNIQUE INDEX "journal_entry_tenantId_companyId_sourceKind_sourceId_key" ON "journal_entry"\("tenantId", "companyId", "sourceKind", "sourceId"\)/,
    );
  });

  it('no Task 3b.10 artifact: no reporting / trial-balance file and no /reports route', () => {
    expect(
      productionFiles(SRC).filter((f) => /reporting|trial-?balance|3b-?10/i.test(rel(f))),
    ).toEqual([]);
  });
});
