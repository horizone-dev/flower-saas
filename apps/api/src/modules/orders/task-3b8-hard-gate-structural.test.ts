import 'reflect-metadata';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cancelOrderSchema } from './dto/cancel-order.dto.js';
import { createRefundSchema } from '../receivables/dto/create-refund.dto.js';
import { IMPERSONATION_READ_ALLOWLIST } from '../../common/auth/permission.guard.js';

/**
 * Task 3b.8 HARD GATE — structural proofs (no database, no HTTP). Each is a source-level fact the
 * behavioural suites cannot show: that something is ABSENT (a route, a branch on business type, an
 * inventory table, a provider contract, a manual path) or that something is the ONLY place it happens
 * (the one writer of an invoice's SETTLED status, the one numbering technique).
 *
 *   HG3b-NO-BT-BRANCH  no runtime branching on business type anywhere in the generic financial domain
 *   HG17               the deferred Task 3b.8 scope is still NOT implemented
 *   HG10               no hand-written SETTLED shortcut
 *   HG15               document numbering is the transactional counter upsert, BigInt-safe, nothing else
 *   HG3                the CreditNote reuses the frozen snapshot — it never touches live tax configuration
 *   HG14               no binary floating point in the 3b.8 money paths (CLAUDE.md rule 15)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, '..');
const repoRoot = path.resolve(here, '../../../../..');

/** strip `//` line comments and `/* *\/` block comments (executable code only) */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function walk(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((x) => e.name.endsWith(x)) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}
const read = (file: string): string => readFileSync(file, 'utf8');
const code = (file: string): string => stripComments(read(file));
const rel = (file: string): string => path.relative(repoRoot, file).replace(/\\/g, '/');

const DOMAIN_DIRS = ['orders', 'receivables', 'payments', 'settlements', 'accounting'].map((d) =>
  path.join(modules, d),
);
const DOMAIN_FILES = DOMAIN_DIRS.flatMap((d) => walk(d, ['.ts']));
const f = (dir: string, name: string): string => path.join(modules, dir, name);
const MONEY_FILES = [
  f('orders', 'credit-note.repository.ts'),
  f('orders', 'cancellation-charge.repository.ts'),
  f('orders', 'credit-note-coverage-source.ts'),
  f('receivables', 'refund.repository.ts'),
  f('receivables', 'refund-execution.repository.ts'),
  f('receivables', 'refund-attempt-reservation.repository.ts'),
  f('receivables', 'refund-attempt-state.ts'),
  f('receivables', 'provider-refund-event-inbox.repository.ts'),
  f('receivables', 'receivable-balance.ts'),
  f('receivables', 'receivable-balance.repository.ts'),
];

describe('HG3b-NO-BT-BRANCH — the generic financial domain never branches on Business Type', () => {
  it('scans a meaningful set of production files (and every 3b.8 file is in it)', () => {
    expect(DOMAIN_FILES.length).toBeGreaterThan(80);
    for (const m of MONEY_FILES) expect(DOMAIN_FILES, rel(m)).toContain(m);
    expect(DOMAIN_FILES).toContain(f('payments', 'payment-target-lock.repository.ts'));
  });

  it('no file of orders / receivables / payments / settlements / accounting references businessType, a preset key or a vertical (florist / salon / restaurant / grocery / bakery / nursery / perfume) in EXECUTABLE code', () => {
    const offenders: string[] = [];
    for (const file of DOMAIN_FILES) {
      const src = code(file);
      if (/business[_-]?type/i.test(src)) offenders.push(`${rel(file)} (businessType)`);
      if (/['"](FLOWER_FLORIST|BAKERY_CAKE|PERFUME_ATTAR|PLANT_NURSERY)['"]/.test(src)) {
        offenders.push(`${rel(file)} (preset key)`);
      }
      const vertical = src.match(
        /\b(florist|salon|restaurant|grocery|bakery|nursery|perfume|attar)\b/i,
      );
      if (vertical) offenders.push(`${rel(file)} (${vertical[0]})`);
    }
    expect(offenders).toEqual([]);
  });

  it('…and not even in a comment of the 3b.8 files themselves (nothing business-type-shaped hides there either)', () => {
    for (const file of MONEY_FILES) {
      expect(read(file), rel(file)).not.toMatch(
        /business[_-]?type|florist|salon|restaurant|grocery/i,
      );
    }
  });
});

describe('HG17 — the deferred Task 3b.8 scope is still NOT implemented', () => {
  it('partial / line-level cancellation: the cancel body is strict — it can name no line, quantity, item, partial flag or override', () => {
    const ok = { reason: 'x' };
    expect(cancelOrderSchema.safeParse(ok).success).toBe(true);
    for (const extra of [
      { lines: [{ orderLineId: '00000000-0000-7000-8000-000000000001', quantity: '1' }] },
      { orderLineIds: ['00000000-0000-7000-8000-000000000001'] },
      { items: [] },
      { quantity: '1' },
      { partial: true },
      { override: true },
      { waiveCharge: true },
      { customerId: '00000000-0000-7000-8000-000000000001' },
      { invoiceId: '00000000-0000-7000-8000-000000000001' },
    ]) {
      expect(cancelOrderSchema.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
    const charge = { requestedAmountMinor: '100', reasonCode: 'CUSTOMER_REQUEST' };
    expect(cancelOrderSchema.safeParse({ ...ok, cancellationCharge: charge }).success).toBe(true);
    for (const extra of [
      { override: true },
      { policyKey: 'STANDARD' },
      { taxCategoryKey: 'STD' },
      { rateBps: 500 },
      { priceTaxMode: 'TAX_INCLUSIVE' },
      { currencyCode: 'AED' },
    ]) {
      expect(
        cancelOrderSchema.safeParse({ ...ok, cancellationCharge: { ...charge, ...extra } }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('split refund-vs-credit resolution: the refund body is strict — one advance, one method, one amount; no split, resolution, credit amount or scope identifier', () => {
    const ok = { requestedAmountMinor: '100', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' };
    expect(createRefundSchema.safeParse(ok).success).toBe(true);
    for (const extra of [
      { split: [{ method: 'CASH', amountMinor: '50' }] },
      { creditAmountMinor: '50' },
      { resolution: 'REFUND_AND_CREDIT' },
      { sourcePaymentId: '00000000-0000-7000-8000-000000000001' },
      { customerCompanyAccountId: '00000000-0000-7000-8000-000000000001' },
      { branchId: '00000000-0000-7000-8000-000000000001' },
      { tenantId: '00000000-0000-7000-8000-000000000001' },
    ]) {
      expect(createRefundSchema.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('standalone / manual CreditNote issuance: the only caller of issueCreditNoteForFullCancellation is the post-invoice CANCELLATION path', () => {
    const callers = DOMAIN_FILES.filter((file) =>
      /issueCreditNoteForFullCancellation/.test(code(file)),
    )
      .map((file) => path.basename(file))
      .sort();
    expect(callers).toEqual(['credit-note.repository.ts', 'order.repository.ts']);
    const injectors = DOMAIN_FILES.filter((file) => /\bCreditNoteRepository\b/.test(code(file)))
      .map((file) => path.basename(file))
      .sort();
    expect(injectors).toEqual([
      'credit-note.repository.ts',
      'order.module.ts',
      'order.repository.ts',
    ]);
  });

  it('cancellation-charge policy engine / override workflow: nothing of the kind exists in code or schema', () => {
    const schema = read(path.join(repoRoot, 'packages/db/prisma/schema.prisma'));
    expect(schema).not.toMatch(/model\s+\w*(Charge|Cancellation)\w*Polic/i);
    expect(schema).not.toMatch(/cancellation_charge_polic/i);
    for (const file of [
      ...DOMAIN_FILES,
      path.join(repoRoot, 'packages/permissions/src/index.ts'),
    ]) {
      expect(code(file), rel(file)).not.toMatch(
        /cancellation[_-]?charge[_-]?(policy|override)|chargeOverride|waiveCharge|ChargePolicy/i,
      );
    }
  });

  it('settled-invoice cancellation: a SETTLED invoice stays in the blocked set, and the cancellation path writes no settlement fact', () => {
    const orderRepo = code(f('orders', 'order.repository.ts'));
    const blocked = orderRepo.match(
      /INVOICE_CANCELLATION_BLOCKED_STATUSES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(blocked, 'the blocked-status set').not.toBeNull();
    expect(blocked![1]).toMatch(/'SETTLED'/);
    for (const file of [
      f('orders', 'credit-note.repository.ts'),
      f('orders', 'cancellation-charge.repository.ts'),
      f('orders', 'order.repository.ts'),
      f('receivables', 'refund-execution.repository.ts'),
      f('receivables', 'refund-attempt-reservation.repository.ts'),
    ]) {
      expect(code(file), rel(file)).not.toMatch(
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?settlement_(application|batch|line)"?/i,
      );
      expect(code(file), rel(file)).not.toMatch(/settlementApplication\.(create|update|delete)/);
    }
  });

  it('OTHER_MANUAL refund accounting mapping: the local refund maps CASH and BANK_TRANSFER to a GL account — and ONLY those two', () => {
    const src = code(f('receivables', 'refund-execution.repository.ts'));
    const map = src.match(
      /LOCAL_REFUND_CASH_OR_BANK_ACCOUNT[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/,
    );
    expect(map, 'the account map').not.toBeNull();
    expect([...map![1]!.matchAll(/(\w+):\s*'/g)].map((m) => m[1])).toEqual([
      'CASH',
      'BANK_TRANSFER',
    ]);
    expect(src).toMatch(/CASH:\s*'ASSET\.CASH_ON_HAND'/);
    expect(src).toMatch(/BANK_TRANSFER:\s*'ASSET\.BANK'/);
  });

  it('real provider refund execution / PaymentProvider.refund + getStatus contracts: no refund code touches a provider port, a network client or a provider SDK — and the port still leaves both methods as opaque `unknown`', () => {
    for (const file of DOMAIN_FILES.filter((x) => /refund/i.test(path.basename(x)))) {
      // IMPORTS and CALLS only — the 501 message legitimately NAMES `PaymentProvider.refund/getStatus` as the
      // missing capability, which is text, not a dependency.
      expect(code(file), rel(file)).not.toMatch(
        /from '[^']*(payment-provider|payment-adapter)[^']*'|\bPaymentProvider(Port|Registry|Adapter|Factory)\b|\.refund\(|\.getStatus\(|fetch\(|axios|undici|node:https?|from 'https?'|stripe|tap\.company/i,
      );
    }
    const port = read(f('payments', 'payment-provider.port.ts'));
    expect(port).toMatch(/\brefund\(request: unknown\): Promise<unknown>;/);
    expect(port).toMatch(/\bgetStatus\(request: unknown\): Promise<unknown>;/);
    // no concrete request/response contract was introduced for them
    expect(port).not.toMatch(/PaymentProvider(Refund|GetStatus|Status)(Request|Result|Response)/);
  });

  it('inventory / stock reversal: the schema has no inventory, stock or movement table and no 3b.8 code references one', () => {
    const schema = read(path.join(repoRoot, 'packages/db/prisma/schema.prisma'));
    const models = [...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]!);
    expect(models.filter((m) => /inventory|stock|movement|bom|recipe/i.test(m))).toEqual([]);
    for (const file of DOMAIN_FILES) {
      expect(code(file), rel(file)).not.toMatch(/inventory|stock_|\bstock\b|\bbom\b/i);
    }
  });

  it('realtime / outbox stays the approved CASE B deferral: no 3b.8 cancellation / credit-note / charge / refund file emits an outbox event or a realtime message', () => {
    for (const file of MONEY_FILES) {
      expect(code(file), rel(file)).not.toMatch(/outbox|OutboxWriter|realtime/i);
    }
    expect(code(f('orders', 'order.repository.ts'))).not.toMatch(/OutboxWriter|outbox\.enqueue/);
  });

  it('frontend / client: no web app, POS app or shared client carries a credit-note / refund / cancellation-charge artifact', () => {
    const roots = [
      'apps/customer-web/src',
      'apps/owner-web/src',
      'apps/pos-pwa/src',
      'apps/super-admin-web/src',
      'packages/api-client/src',
      'packages/shared-types/src',
      'packages/ui/src',
    ].map((r) => path.join(repoRoot, r));
    const files = roots.flatMap((r) => walk(r, ['.ts', '.tsx']));
    expect(files.length).toBeGreaterThan(5); // the scan is not vacuous
    for (const file of files) {
      expect(code(file), rel(file)).not.toMatch(/credit[_-]?note|refund|cancellation[_-]?charge/i);
    }
  });

  it('the support-impersonation allowlist is exactly the two read keys — it can never reach a cancel / refund / credit-note authority', () => {
    expect([...IMPERSONATION_READ_ALLOWLIST].sort()).toEqual(['audit:view', 'users:view']);
  });
});

describe('HG10 — SETTLED is derived, never hand-written', () => {
  it('exactly ONE production file assigns an invoice the SETTLED status: the settlement projection (which derives it from provenance)', () => {
    const writers = walk(path.join(modules, '..'), ['.ts'])
      .filter((file) =>
        /(invoicePaymentStatus"?\s*[:=]\s*'SETTLED')|(invoice\.update[\s\S]{0,200}'SETTLED')/.test(
          code(file),
        ),
      )
      .map((file) => rel(file))
      .sort();
    expect(writers).toEqual([
      'apps/api/src/modules/settlements/invoice-settlement-projection.repository.ts',
    ]);
  });

  it('the cancellation / refund / credit-note code never sets any invoice status to SETTLED (it may only set CANCELLED / PARTIALLY_REFUNDED / REFUNDED)', () => {
    for (const file of MONEY_FILES) {
      expect(code(file), rel(file)).not.toMatch(/'SETTLED'/);
    }
  });
});

describe('HG15 — document numbering is the transactional counter upsert, BigInt-safe, and nothing else', () => {
  const NUMBERED: [string, string][] = [
    ['orders/credit-note.repository.ts', 'CREDIT_NOTE'],
    ['orders/cancellation-charge.repository.ts', 'CANCELLATION_CHARGE'],
  ];
  for (const [file, docType] of NUMBERED) {
    it(`${docType}: allocated by an ON CONFLICT upsert of document_number_counter (company + document-type scoped), formatted from a BigInt — no MAX()+1, no SEQUENCE, no Number() ceiling`, () => {
      const src = code(path.join(modules, file));
      expect(src).toMatch(
        /INSERT INTO "document_number_counter" \("tenantId", "companyId", "documentType", "nextNumber"\)/,
      );
      expect(src).toContain(`'${docType}'`);
      expect(src).toMatch(/ON CONFLICT \("tenantId", "companyId", "documentType"\)/);
      expect(src).toMatch(/"nextNumber" = "document_number_counter"\."nextNumber" \+ 1/);
      expect(src).toMatch(/RETURNING "nextNumber" - 1 AS allocated/);
      expect(src).toMatch(/\{ allocated: bigint \}/);
      expect(src).toMatch(/n\.toString\(\)\.padStart\(6, '0'\)/);
      expect(src).not.toMatch(
        /MAX\s*\(|nextval\s*\(|CREATE\s+SEQUENCE|(^|[^A-Za-z])Number\(|parseInt|parseFloat/,
      );
    });
  }

  it('no migration of the 3b.8 chain defines a PostgreSQL SEQUENCE (a sequence would not roll back with the transaction)', () => {
    const migrations = path.join(repoRoot, 'packages/db/prisma/migrations');
    for (const dir of readdirSync(migrations).filter((n) => /^2026100[5-8]/.test(n))) {
      const sql = readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8').replace(
        /--.*$/gm,
        '',
      );
      expect(sql, dir).not.toMatch(/CREATE\s+SEQUENCE|nextval\s*\(|\bSERIAL\b/i);
    }
  });
});

describe('HG3 — a CreditNote reuses the frozen snapshot; it never consults live tax configuration', () => {
  it('credit-note.repository.ts references no tax / localization resolution at all', () => {
    const src = code(f('orders', 'credit-note.repository.ts'));
    expect(src).not.toMatch(
      /TaxResolutionService|LocalizationService|resolveTaxRate|resolveRegimeOn|tax_rate|country_tax_config|tax_category|taxCategoryKey|from '\.\.\/(localization|catalog)/,
    );
    // …it derives every line from the order line's own frozen columns
    expect(src).toMatch(/lineTaxAmountMinor/);
    expect(src).toMatch(/allocateDocumentDiscount/);
  });

  it('revenue is booked NET of tax (total − tax), the exact mirror of the invoice AR posting — never the gross subtotal', () => {
    const cn = code(f('orders', 'credit-note.repository.ts'));
    expect(cn).toMatch(/const revenueAmountMinor = totalAmountMinor - taxTotalAmountMinor;/);
    const ar = code(f('receivables', 'customer-invoice-ar.repository.ts'));
    expect(ar).toMatch(
      /const revenueAmountMinor = input\.totalAmountMinor - input\.taxTotalAmountMinor;/,
    );
  });
});

describe('HG14 — no binary floating point in the 3b.8 money paths (CLAUDE.md rule 15)', () => {
  it('the money files use no parseFloat / Math rounding / toFixed / Number() — the single decimal formatting call is the exact Prisma.Decimal one', () => {
    for (const file of MONEY_FILES) {
      // the ONE allowed use: `Decimal#toFixed` of an order-line quantity (exact decimal arithmetic)
      const src = code(file).replace('l.quantity.toFixed(4)', 'l.quantity.DECIMAL_TO_FIXED(4)');
      expect(src, rel(file)).not.toMatch(
        /parseFloat|Math\.(round|floor|ceil|trunc|random)|\.toFixed\(|\.toPrecision\(|(^|[^A-Za-z])Number\(|\bparseInt\(/,
      );
    }
  });
});
