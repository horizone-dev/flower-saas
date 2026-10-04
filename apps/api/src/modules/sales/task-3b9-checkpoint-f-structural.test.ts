import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 3b.9 Checkpoint F — structural pins of the FINAL integrated tree.
 *
 * Checkpoints A–E have their own pin suites. These pins are the whole-task, pre-PR ones: the
 * migration chain is untouched (frozen Task 3b.8 hashes), the whole Task 3b.9 file set is
 * hygienic (no `.only` / `.skip` / TODO / debug output), the PUBLIC surface carries no PII or
 * secret vocabulary, the owner-frozen Checkpoint-E rulings are pinned as rulings, and the
 * documentation matches the implementation (no stale statement about the credit-limit basis,
 * the HTTP status or the recovery field name).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..'); // apps/api/src
const SALES = join(SRC, 'modules/sales');
const read = (abs: string): string => readFileSync(abs, 'utf8');
const sha = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const rel = (abs: string): string => relative(ROOT, abs).replace(/\\/g, '/');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
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

/** every file Task 3b.9 owns inside apps/api (the sales module + its Checkpoint-A order files) */
const ORDER_FILES = [
  'modules/orders/canonical-totals.ts',
  'modules/orders/canonical-totals.test.ts',
  'modules/orders/order-invoice-summary.ts',
  'modules/orders/order-invoice-summary.test.ts',
].map((p) => join(SRC, p));
const TASK_FILES = [...walk(SALES).filter((f) => f.endsWith('.ts')), ...ORDER_FILES];
const TASK_PRODUCTION = TASK_FILES.filter((f) => !isTest(f));
/** the pre-existing files Task 3b.9 touched (additively) */
const TOUCHED = [
  'apps/api/src/app.module.ts',
  'apps/api/src/modules/orders/order.controller.ts',
  'apps/api/src/modules/orders/order.module.ts',
  'apps/api/src/modules/orders/order.repository.ts',
  'apps/api/src/modules/orders/order.service.ts',
  'apps/api/src/modules/orders/tax-finalization.service.ts',
  'apps/api/src/modules/orders/invoice-issuance.repository.ts',
  'apps/api/src/modules/payments/payment.module.ts',
  'apps/api/src/modules/receivables/receivables.module.ts',
  'apps/realtime/src/auth/topics.test.ts',
  'apps/worker/src/outbox/envelope.test.ts',
].map((p) => join(ROOT, p));

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — the migration chain is untouched: exactly the frozen 49, Task 3b.8 hashes intact', () => {
  const dir = join(ROOT, 'packages/db/prisma/migrations');
  const migrations = (): string[] =>
    readdirSync(dir)
      .filter((n) => !n.endsWith('.toml'))
      .sort();

  it('exactly 49 migrations, the last six are the frozen Task 3b.8 set, and there is no migration 50', () => {
    const all = migrations();
    expect(all).toHaveLength(49);
    expect(all.slice(-6)).toEqual([
      '20261005120000_phase_3b8_credit_refund_core',
      '20261006120000_phase_3b8_cancellation_charge_permission',
      '20261007120000_phase_3b8_integration_closure',
      '20261008120000_phase_3b8_credit_note_advance_release_provenance',
      '20261009120000_phase_3b8_refund_scope_integrity',
      '20261010120000_phase_3b8_currency_and_release_integrity',
    ]);
    expect(all.some((n) => n > '20261010120000_phase_3b8_currency_and_release_integrity')).toBe(
      false,
    );
  });

  const FROZEN: Record<string, string> = {
    '20261005120000_phase_3b8_credit_refund_core':
      'f708a91c26886cd81da87c1b38a4c7680f701aa67f264af8bdb69c1d63fc319b',
    '20261006120000_phase_3b8_cancellation_charge_permission':
      'c3c6da7efb324a49730f8b91bb70d86df8282abf95eedf975cdd51fe00d9dceb',
    '20261007120000_phase_3b8_integration_closure':
      'f633235761bbb8065362000075c44e6fbb11ad342ca459cba7a7fc7d81134516',
    '20261008120000_phase_3b8_credit_note_advance_release_provenance':
      '36e843ca4aa45e2ce3c7668e3faa3aeeb5f7ba4d3b743fb907306c6525db618f',
    '20261009120000_phase_3b8_refund_scope_integrity':
      '2ec98886a91bdc29d1baaab0917edeb2b527f2766f07020e9c9d21d1253794e1',
    '20261010120000_phase_3b8_currency_and_release_integrity':
      'c43a21aeb7a7adff5632bbed53cc06df87a383d1d4225c69ce22b67e5f19ab70',
  };
  for (const [name, hash] of Object.entries(FROZEN)) {
    it(`migration ${name} is byte-identical to its frozen hash`, () => {
      expect(sha(read(join(dir, name, 'migration.sql')))).toBe(hash);
    });
  }

  it('the Prisma schema and the migration lock are unchanged — Task 3b.9 introduces no schema drift', () => {
    expect(sha(read(join(ROOT, 'packages/db/prisma/schema.prisma')))).toBe(
      '15ef99cee245e0cc64166ab6a5156767b4795a0a7b763435207514945ea37459',
    );
    expect(sha(read(join(dir, 'migration_lock.toml')))).toBe(
      '99836963713b4f5b269ad49af0ed3d7b0b2e336115c2f92dc9ac683d139d0900',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — test and source hygiene of every Task 3b.9 file', () => {
  const everything = [...TASK_FILES, ...TOUCHED];

  it('no focused / skipped / todo test and no debugger statement anywhere in the task (a required-test skip is a blocker)', () => {
    const CALL = /^\s*(?:it|test|describe|suite)\.(?:only|skip|todo|fails|concurrent\.skip)\b/m;
    const X = /^\s*(?:fit|fdescribe|xit|xdescribe|xtest)\(/m;
    const DEBUGGER = /^\s*debugger\b/m;
    for (const abs of everything) {
      const text = read(abs);
      expect(CALL.test(text), rel(abs)).toBe(false);
      expect(X.test(text), rel(abs)).toBe(false);
      expect(DEBUGGER.test(text), rel(abs)).toBe(false);
    }
  });

  it('no TODO / FIXME / HACK marker was introduced by the task', () => {
    // (not `XXX`: that is the ISO 4217 "no currency" code the sale-plan tests use on purpose)
    const MARK = new RegExp(['TO', 'DO|FIX', 'ME|HA', 'CK'].join(''));
    for (const abs of TASK_FILES) {
      if (/task-3b9-checkpoint-[a-z]-structural\.test\.ts$/.test(abs)) continue; // pin files name the forbidden words
      expect(MARK.test(read(abs)), rel(abs)).toBe(false);
    }
  });

  it('no debug console output in any production file of the task (and none in the additive edits)', () => {
    for (const abs of [...TASK_PRODUCTION, ...TOUCHED.filter((f) => !isTest(f))]) {
      expect(stripComments(read(abs)), rel(abs)).not.toMatch(/\bconsole\s*\./);
    }
  });

  it('no generated credential, token, key or hard-coded secret in the task files (test fixtures use random ids only)', () => {
    const SECRET =
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk_(?:live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./;
    for (const abs of everything) {
      expect(SECRET.test(read(abs)), rel(abs)).toBe(false);
    }
  });

  it('no scratch / temporary / mutation artifact was left in the repository', () => {
    const files = walk(SALES).map((f) => f.replace(/\\/g, '/').split('/').pop()!);
    for (const f of files) {
      expect(f, f).not.toMatch(
        /\.(bak|orig|tmp|rej|swp|out|log)$|~$|\.mutant|\.scratch|mutate-|pin-sensitivity/i,
      );
    }
    for (const dir of [SALES, join(SRC, 'modules/orders')]) {
      expect(
        readdirSync(dir).some((n) => /\.(bak|orig|tmp|rej)$/.test(n)),
        rel(dir),
      ).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — the PUBLIC surface carries no PII, secret or credential vocabulary', () => {
  const PUBLIC = [
    'dto/complete-sale.dto.ts',
    'complete-sale-response.ts',
    'sale-events.ts',
    'sales.controller.ts',
    'complete-sale-authority.guard.ts',
    'complete-sale-fingerprint.provider.ts',
    'sales-application.service.ts',
    'order-totals-preview.repository.ts',
  ].map((p) => join(SALES, p));

  it('no email / phone / name / address / password / token / secret / card-number / credential field in any public DTO, response, event or route code', () => {
    const FORBIDDEN =
      /\b(email|phone|msisdn|mobile|displayName|firstName|lastName|fullName|address|password|passwd|passphrase|secret|apiKey|api_key|accessToken|refreshToken|bearer|cardNumber|pan|cvv|cvc|iban|ssn|providerCredentialId|credential(?:s)?)\b/i;
    for (const abs of PUBLIC) {
      expect(stripComments(read(abs)), rel(abs)).not.toMatch(FORBIDDEN);
    }
  });

  it('the sale event payload is exactly two identifiers; the response never carries the customer, account, journal, credit-gate or storage identifiers', () => {
    const events = stripComments(read(join(SALES, 'sale-events.ts')));
    expect(events.match(/readonly \w+:/g)).toEqual(['readonly orderId:', 'readonly invoiceId:']);
    expect(stripComments(read(join(SALES, 'complete-sale-response.ts')))).not.toMatch(
      /customerId|customerCompanyAccount|journal|creditAuthorizationMode|operationKey|claimToken|idempotency/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — scope audit: nothing outside the approved Task 3b.9 scope exists in the task files', () => {
  it('no reporting, inventory / BOM, delivery, printing, FX, provider execution, new settlement / credit-note model or businessType branching', () => {
    const OUT_OF_SCOPE =
      /\breporting\b|\binventory\b|\bBOM\b|bill_of_materials|\bdelivery\b|\bprinting\b|\bprinter\b|\bfxRate\b|exchangeRate|\bfx_rate\b|PaymentProviderRegistry|WebhookRecovery|businessType|business_type|BusinessType|SettlementBatch|settlement_application|credit_?note|\brefund\b|cancellationCharge/i;
    for (const abs of TASK_PRODUCTION) {
      expect(stripComments(read(abs)), rel(abs)).not.toMatch(OUT_OF_SCOPE);
    }
  });

  it('no float money math and no binary-float literal in the pure / sale code (money is integer minor units only)', () => {
    for (const abs of TASK_PRODUCTION) {
      const code = stripComments(read(abs)).replace(/'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, "''");
      expect(code, rel(abs)).not.toMatch(
        /\bparseFloat\b|\.toFixed\s*\(|\bMath\.(round|floor|ceil|trunc)\b/,
      );
      expect(code, rel(abs)).not.toMatch(/(?<![\w.])\d+\.\d+(?![\w.])/);
    }
  });

  it('no fifth app, no frontend, no new permission, no new workspace package: the app set and the permission registry are frozen', () => {
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
    expect(sha(read(join(ROOT, 'packages/permissions/src/index.ts')))).toBe(
      '20f66e4258f62899b67471a4f0e64fe84f8098a2dffe9a4b6575734729ed4c42',
    );
    expect(readdirSync(join(ROOT, 'packages')).sort()).toEqual([
      'api-client',
      'backend',
      'config',
      'db',
      'i18n',
      'money',
      'permissions',
      'realtime-client',
      'service-runtime',
      'shared-types',
      'testing',
      'ui',
      'uom',
    ]);
  });

  it('credit is not a Payment; PAID is not SETTLED; no manual Payment / AR / Advance write exists in the orchestrator or the facade', () => {
    for (const f of ['atomic-walk-in-sale.service.ts', 'sales-application.service.ts']) {
      const src = stripComments(read(join(SALES, f)));
      expect(src, f).not.toMatch(/'CREDIT'|method\s*:\s*'(?:CREDIT|ADVANCE|WALLET|STORE_CREDIT)'/);
      expect(src.replace(/FOR UPDATE/g, ''), f).not.toMatch(
        /\bINSERT\s+INTO\b|\bUPDATE\s+"|\bDELETE\s+FROM\b/i,
      );
      expect(src, f).not.toMatch(
        /\btx\.(payment|paymentAllocation|customerAdvance|customerReceivable|customerAccountEntry|customerCompanyAccount)\b/,
      );
    }
    const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
    expect(plan).toMatch(/PAID[^\n]*SETTLED/);
  });

  it('there is ONE financial orchestrator and ONE idempotency system (closed worlds over the whole API source)', () => {
    const production = walk(SRC)
      .filter((f) => f.endsWith('.ts') && !isTest(f))
      .map((f) => ({ f: rel(f), c: stripComments(read(f)) }));
    expect(
      production
        .filter((p) => /issuePrepared\(/.test(p.c) && /captureSynchronousTendersInTx\(/.test(p.c))
        .map((p) => p.f),
    ).toEqual(['apps/api/src/modules/sales/atomic-walk-in-sale.service.ts']);
    expect(production.filter((p) => /'orders\.complete_sale'/.test(p.c)).map((p) => p.f)).toEqual([
      'apps/api/src/modules/sales/sales.controller.ts',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — the owner-frozen Checkpoint-E rulings are PINNED as rulings', () => {
  const controller = stripComments(read(join(SALES, 'sales.controller.ts')));
  const completeRoute = controller.slice(
    controller.indexOf("@Post(':orderId/complete-sale')"),
    controller.indexOf('async completeSale('),
  );

  it('RULING — a successful complete-sale is HTTP 200 (a command on an existing order)', () => {
    expect(completeRoute).toMatch(/@HttpCode\(200\)/);
    expect(completeRoute).not.toMatch(/@HttpCode\((?!200)/);
    const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
    expect(plan).toMatch(/status \*\*200\*\*/);
    expect(plan).not.toMatch(/complete-sale[^\n]*\b201\b/);
    expect(read(join(ROOT, 'docs/decisions/DECISION-LOG.md'))).toMatch(/answers \*\*200\*\*/);
  });

  it('RULING — guard-first authorization: the conditional-authority guard reads the RAW body, so an unauthorized malformed request is 403 BEFORE the body pipe can answer 400', () => {
    expect(completeRoute).toMatch(/@UseGuards\(CompleteSaleAuthorityGuard\)/);
    expect(controller).toMatch(/@Body\(new ZodBody\(completeSaleSchema\)\) dto: CompleteSaleDto/);
    const guard = stripComments(read(join(SALES, 'complete-sale-authority.guard.ts')));
    expect(guard).toMatch(/req\.body/);
    expect(guard).not.toMatch(/completeSaleSchema|ZodBody/); // the guard never validates — pipes run after guards
    const tests = read(join(SALES, 'sales.controller.integration.test.ts'));
    expect(tests).toContain('gets 403 first (the guard fails closed)');
  });

  it('RULING — a missing / malformed If-Match follows the established repository mapping (428 PRECONDITION_REQUIRED), proven by name in the HTTP suite', () => {
    const tests = read(join(SALES, 'sales.controller.integration.test.ts'));
    expect(tests).toContain('a MISSING If-Match fails closed: 428 PRECONDITION_REQUIRED');
    expect(tests).toContain('a MALFORMED If-Match');
    expect(controller).toMatch(/requireIfMatch\(parseIfMatch\(ifMatch\)\)/);
  });

  it('RULING — the internal credit-gate mode is NEVER returned publicly', () => {
    expect(stripComments(read(join(SALES, 'complete-sale-response.ts')))).not.toMatch(
      /creditAuthorizationMode|authorizationMode/,
    );
    expect(read(join(SALES, 'sales.controller.integration.test.ts'))).toContain(
      'the response exposes NO internals',
    );
  });

  it('RULING — the Order GET recovery field is named `issuedInvoice` (and only that), consistently in code, comments and docs', () => {
    const orderController = stripComments(read(join(SRC, 'modules/orders/order.controller.ts')));
    expect(orderController).toMatch(/issuedInvoice/);
    expect(orderController).not.toMatch(/return \{[^}]*\binvoice\b\s*[:,}]/);
    expect(read(join(SRC, 'modules/orders/order-invoice-summary.ts'))).toMatch(
      /`issuedInvoice` summary/,
    );
    expect(read(join(SRC, 'modules/orders/order-invoice-summary.ts'))).not.toMatch(
      /`invoice` summary/,
    );
    const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
    expect(plan).toMatch(/`issuedInvoice`/);
    expect(read(join(ROOT, 'docs/decisions/DECISION-LOG.md'))).toMatch(
      /named \*\*`issuedInvoice`\*\*/,
    );
  });

  it('RULING — after the idempotency TTL expires the request is a NEW request: the completed order prevents a double sale and issuedInvoice is the recovery (documented and proven by name)', () => {
    const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
    expect(plan).toMatch(/after the TTL/);
    expect(plan).toMatch(/ORDER_INVALID_STATE_TRANSITION/);
    expect(plan).toMatch(/issuedInvoice/);
    expect(read(join(SALES, 'sales.controller.integration.test.ts'))).toContain(
      'TTL EXPIRY: once the stored key has expired the same request is a NEW request',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — documentation matches the implementation', () => {
  const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
  const log = read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
  const phase = read(join(ROOT, 'docs/phase-3/PHASE-3B-PLAN.md'));

  it('the four 3b.9 decision rows each exist exactly once', () => {
    for (const id of ['3b.9-ACC', '3b.9-OD', '3b.9-CE', '3b.9-PUB']) {
      expect(
        log.split('\n').filter((l) => l.startsWith(`| **${id}**`)),
        id,
      ).toHaveLength(1);
    }
    expect(read(join(ROOT, 'CLAUDE.md'))).toMatch(/3b\.9-ACC/);
  });

  it('RB-1 is explicitly OPEN in the plan, the phase plan and the decision log', () => {
    expect(plan).toMatch(/RB-1 \(OD-8\)[^\n]*anonymous issued-sale void \/ refund resolution/);
    // (the statement is a wrapped blockquote — allow the `> ` prefix on the continuation line)
    expect(plan).toMatch(
      /must be designed and completed before any production \/ MVP\s+(?:>\s*)?release/,
    );
    expect(phase).toMatch(/RB-1 — anonymous issued-sale void \/ refund resolution/);
    expect(log).toMatch(
      /3b\.9-OD[^\n]*RB-1|RB-1[^\n]*3b\.9-OD|anonymous issued-sale void \/ refund resolution/,
    );
  });

  it('no document still presents the gross invoice total as the corrected credit-limit basis (the old wording survives only in marked-historical paragraphs)', () => {
    const OBSOLETE = [
      'conservative by design',
      'gated on the full invoice total, not on the credit remainder',
      "the invoice total against the account's headroom",
      "(the customer's existing receivable outstanding + the invoice TOTAL)",
      'before any tender or advance reduces the receivable',
    ];
    for (const phrase of OBSOLETE) {
      expect(plan.includes(phrase), `plan: ${phrase}`).toBe(false);
      expect(log.includes(phrase), `log: ${phrase}`).toBe(false);
    }
    // the surviving mentions are the explicitly-historical ones
    expect(plan).toMatch(/Old behaviour \(as first delivered, reported as a finding\)/);
    expect(plan).toMatch(/RESOLVED by owner ruling OD-14/);
    expect(plan).toMatch(/not gross invoice total, for atomic customer sales/);
  });

  it('HG3b-SALE-LATENCY stays an OPEN Phase-3 final hard gate and the C figure stays a non-production observation', () => {
    expect(phase).toMatch(
      /HG3b-SALE-LATENCY[^\n]*Phase-3 FINAL hard gate[^\n]*non-production benchmark/,
    );
    expect(plan).toMatch(/HG3b-SALE-LATENCY/);
  });

  it('Checkpoints A–E are recorded done and Checkpoint F is the only open row; Task 3b.10 does not exist', () => {
    const row = (id: string): string =>
      plan.split('\n').find((l) => l.startsWith(`| ${id}   |`)) ?? '';
    for (const id of ['A', 'B', 'C', 'D', 'E']) expect(row(id), id).toMatch(/\*\*done\*\*/);
    expect(row('F')).toMatch(/not started|\*\*done\*\*|verified/);
    expect(existsSync(join(SRC, 'modules/reporting'))).toBe(false);
  });
});
