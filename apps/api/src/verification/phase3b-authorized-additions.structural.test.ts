import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZED_SCHEMA_BLOCK_SHA256,
  PHASE_3B_AUTHORIZED_MIGRATIONS,
  authorizedSchemaBlock,
  frozenSchemaText,
  sha256OfBlock,
  sha256OfMigrationSql,
  withoutAuthorizedMigrations,
} from './phase3b-authorized-additions.js';

/**
 * Phase 3B closure — RB-1 A2: structural proof that the ONE authorised addition (migration `20261105120000`, the marked schema block
 * and the `anonymous-credit-notes` module) is purely ADDITIVE, and that nothing frozen moved. The frozen "49 migrations / schema
 * unchanged" pins elsewhere keep proving the frozen part byte for byte; this file pins the addition itself.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const SRC = join(ROOT, 'apps/api/src');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');

const MIG = PHASE_3B_AUTHORIZED_MIGRATIONS[0]!;
const MIG_DIR = join(ROOT, 'packages/db/prisma/migrations');
const migSql = read(join(MIG_DIR, MIG.name, 'migration.sql'));
const schemaRaw = readFileSync(join(ROOT, 'packages/db/prisma/schema.prisma'), 'utf8');

describe('the authorised migration', () => {
  it('is exactly one migration, sorts after the 49 frozen ones, and matches its pinned content hash', () => {
    expect(PHASE_3B_AUTHORIZED_MIGRATIONS).toHaveLength(1);
    const all = readdirSync(MIG_DIR)
      .filter((n) => !n.endsWith('.toml'))
      .sort();
    expect(all).toHaveLength(50);
    expect(all[all.length - 1]).toBe(MIG.name);
    const frozen = withoutAuthorizedMigrations(all);
    expect(frozen).toHaveLength(49);
    expect(frozen[frozen.length - 1]).toBe(
      '20261010120000_phase_3b8_currency_and_release_integrity',
    );
    expect(sha256OfMigrationSql(migSql)).toBe(MIG.sha256);
  });

  it('is ADDITIVE ONLY: every statement creates or configures an anonymous_credit_note* object; nothing existing is altered, dropped, updated or deleted', () => {
    const code = migSql
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    // split on `;` but never inside a $$ … $$ function body
    const statements: string[] = [];
    let cur = '';
    let inBody = false;
    for (const line of code.split('\n')) {
      cur += line + '\n';
      if (/\$\$/.test(line))
        inBody = (line.match(/\$\$/g) ?? []).length % 2 === 1 ? !inBody : inBody;
      if (!inBody && /;\s*$/.test(line)) {
        statements.push(cur.replace(/\s+/g, ' ').trim());
        cur = '';
      }
    }
    expect(cur.trim()).toBe('');
    expect(statements.length).toBeGreaterThan(40);
    const allowed: RegExp[] = [
      /^CREATE TABLE "anonymous_credit_note(_line|_refund)?" \(/,
      /^CREATE (UNIQUE )?INDEX "anonymous_credit_note[A-Za-z_]*" ON "anonymous_credit_note(_line|_refund)?"\(/,
      /^ALTER TABLE "anonymous_credit_note(_line|_refund)?" (ADD CONSTRAINT|ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY)/,
      /^CREATE FUNCTION fn_anon_cn_[a-z_]+\(\) RETURNS trigger AS \$\$/,
      /^CREATE (CONSTRAINT )?TRIGGER trg_anon_cn_[a-z_]+ (BEFORE|AFTER) (INSERT|UPDATE|DELETE)( OF "[A-Za-z]+")?[A-Z ]* ON "anonymous_credit_note(_line|_refund)?"/,
      /^CREATE POLICY "anonymous_credit_note[a-z_]*" ON "anonymous_credit_note(_line|_refund)?"/,
      /^GRANT (ALL|SELECT, INSERT|SELECT|UPDATE \([^)]*\)) ON "anonymous_credit_note/,
      /^REVOKE ALL ON "anonymous_credit_note[^;]* FROM flower_platform, flower_app;$/,
    ];
    const offenders = statements.filter((s) => !allowed.some((re) => re.test(s)));
    expect(offenders).toEqual([]);
    // FK targets are READ-ONLY references; no statement touches an existing table other than through REFERENCES
    for (const s of statements) {
      expect(s, s.slice(0, 80)).not.toMatch(
        /^(DROP|TRUNCATE|DELETE|UPDATE|INSERT|ALTER TABLE "(?!anonymous_credit_note))/i,
      );
    }
    expect(code).not.toMatch(
      /\b(permission_registry|role_permission|"role"|journal_entry"? *\(|ALTER FUNCTION|DROP )/,
    );
  });

  it('F-4: the status ↔ posting guards exist as DEFERRED constraint triggers and the grants make the platform realm read-only and the application role the only writer', () => {
    expect(migSql).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_anon_cn_refund_execution_journal_guard\s+AFTER UPDATE OF "status" ON "anonymous_credit_note_refund"\s+DEFERRABLE INITIALLY DEFERRED/,
    );
    expect(migSql).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_anon_cn_note_issuance_journal_guard\s+AFTER INSERT ON "anonymous_credit_note"\s+DEFERRABLE INITIALLY DEFERRED/,
    );
    // the tender → account pairs the database mirrors are exactly the frozen ones (parity is also proven against the live function)
    expect(migSql).toContain(
      `WHEN 'CASH' THEN 'ASSET.CASH_ON_HAND' WHEN 'BANK_TRANSFER' THEN 'ASSET.BANK' ELSE NULL END`,
    );
    // independent-review findings, pinned: (1) EVERY guard function pins its search_path with pg_temp LAST, so a session's temporary
    // tables named journal_entry / journal_line / account can never stand in for the real evidence; (2) an outcome is ATTRIBUTED
    const fnCount = [...migSql.matchAll(/^CREATE FUNCTION /gm)].length;
    expect(fnCount).toBeGreaterThanOrEqual(8);
    expect([
      ...migSql.matchAll(/^\$\$ LANGUAGE plpgsql SET search_path = public, pg_temp;$/gm),
    ]).toHaveLength(fnCount);
    expect(migSql).not.toMatch(/^\$\$ LANGUAGE plpgsql;$/m);
    expect(migSql).not.toMatch(/SECURITY DEFINER/); // the guards run with the caller's rights; nothing escalates
    expect(migSql).toMatch(
      /"status" = 'EXECUTED' AND "resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL AND "failureReasonCode" IS NULL/,
    );
    expect(migSql).toMatch(
      /"status" = 'FAILED' AND "resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL AND "failureReasonCode" IS NOT NULL/,
    );
    // grants: platform SELECT only; application SELECT + INSERT + UPDATE of the six outcome columns; nobody gets DELETE / TRUNCATE
    expect(migSql).toMatch(
      /GRANT SELECT ON "anonymous_credit_note", "anonymous_credit_note_line", "anonymous_credit_note_refund" TO flower_platform;/,
    );
    expect(migSql).toMatch(
      /GRANT SELECT, INSERT ON "anonymous_credit_note", "anonymous_credit_note_line", "anonymous_credit_note_refund" TO flower_app;/,
    );
    expect(migSql).toMatch(/ON "anonymous_credit_note_refund" TO flower_app;/);
    expect(migSql).not.toMatch(/TO flower_platform, flower_app/);
    expect(migSql).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE)\b[^;]*TO flower_(app|platform)/);
  });

  it('registers no permission, edits no role, and the two RLS-enabled tables are FORCED', () => {
    expect(migSql).not.toMatch(/permission_registry|role_permission/);
    for (const t of [
      'anonymous_credit_note',
      'anonymous_credit_note_line',
      'anonymous_credit_note_refund',
    ]) {
      expect(migSql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(migSql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
    }
  });
});

describe('the authorised schema block', () => {
  it('matches its pinned hash; the frozen part, with the block removed, hashes to the frozen value', () => {
    const block = authorizedSchemaBlock(schemaRaw)!;
    expect(block).not.toBeNull();
    expect(sha256OfBlock(block)).toBe(AUTHORIZED_SCHEMA_BLOCK_SHA256);
    expect(
      createHash('sha256')
        .update(frozenSchemaText(schemaRaw).replace(/\r\n/g, '\n'), 'utf8')
        .digest('hex'),
    ).toBe('15ef99cee245e0cc64166ab6a5156767b4795a0a7b763435207514945ea37459');
  });

  it('declares exactly three scalar-only models (no relation field, so no frozen model block is edited) mapped to the new tables', () => {
    const block = authorizedSchemaBlock(schemaRaw)!;
    expect([...block.matchAll(/^model (\w+) \{/gm)].map((m) => m[1])).toEqual([
      'AnonymousCreditNote',
      'AnonymousCreditNoteLine',
      'AnonymousCreditNoteRefund',
    ]);
    expect(strip(block)).not.toMatch(/@relation/);
    expect([...block.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      'anonymous_credit_note',
      'anonymous_credit_note_line',
      'anonymous_credit_note_refund',
    ]);
  });
});

describe('the anonymous-credit-notes module — closed-world pins', () => {
  const DIR = join(SRC, 'modules/anonymous-credit-notes');
  const files = readdirSync(DIR).sort();
  const prod = files.filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f));
  const code = (f: string): string => strip(read(join(DIR, f)));

  it('holds exactly the expected files', () => {
    expect(files).toEqual(
      [
        'anonymous-credit-note-plan.test.ts',
        'anonymous-credit-note-plan.ts',
        'anonymous-credit-note-summary.controller.ts',
        'anonymous-credit-note-summary.integration.test.ts',
        'anonymous-credit-note-summary.repository.ts',
        'anonymous-credit-note-summary.sql.ts',
        'anonymous-credit-note-summary.test.ts',
        'anonymous-credit-note-summary.ts',
        'anonymous-credit-note.controller.ts',
        'anonymous-credit-note.dto.ts',
        'anonymous-credit-note.integration.test.ts',
        'anonymous-credit-note.integrity.integration.test.ts',
        'anonymous-credit-note.repository.ts',
        'anonymous-credit-note.service.ts',
        'anonymous-credit-notes.module.ts',
      ].sort(),
    );
  });

  it('the pure plan is pure: no database, no framework, no clock, no float, no console', () => {
    const c = code('anonymous-credit-note-plan.ts');
    expect(c).not.toMatch(
      /@nestjs|@flower\/db|prisma|\bDate\b|Math\.(random|round|floor)|parseFloat|Number\(|console\./,
    );
    const imports = [...c.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      [
        '../../common/errors/domain-error.js',
        '../orders/document-discount-allocation.js',
        '../payments/tender-account-mapping.js',
        '@flower/money',
        '@flower/uom',
      ].sort(),
    );
  });

  it('the repository NEVER modifies an invoice, an order, an order line, a payment, a customer account, a credit_note or any earlier journal: it only inserts its own rows, posts via the posting engine, and updates ONLY the refund outcome', () => {
    const c = code('anonymous-credit-note.repository.ts');
    expect(c).not.toMatch(
      /UPDATE\s+"(invoice|order|order_line|payment|payment_allocation|credit_note|customer[a-z_]*|journal[a-z_]*|account)"/i,
    );
    expect(c).not.toMatch(/DELETE\s+FROM/i);
    expect(c).not.toMatch(/INSERT INTO\s+"(?!anonymous_credit_note|document_number_counter)/i);
    expect([...c.matchAll(/UPDATE\s+"([a-z_]+)"/gi)].map((m) => m[1])).toEqual([
      'anonymous_credit_note_refund',
      'anonymous_credit_note_refund',
    ]);
    // order → invoice → lines → counter (the frozen lock hierarchy) in the issuing transaction
    const i = c.indexOf('private async lockInvoice');
    expect(c.indexOf('FROM "order" WHERE "id" = ${orderId}::uuid FOR UPDATE', i)).toBeGreaterThan(
      i,
    );
    expect(c.indexOf('FOR UPDATE OF i', i)).toBeGreaterThan(c.indexOf('FROM "order" WHERE', i));
    // every journal goes through the frozen posting engine; the source kinds are the two pinned constants
    expect(c).toMatch(/postingEngine\.postJournal\(/);
    expect([...c.matchAll(/postingEngine\.postJournal/g)]).toHaveLength(2);
    expect(c).not.toMatch(/INSERT INTO\s+"journal/i);
  });

  it('the controller: five routes, branch-nested, none public; the mutations are idempotent; the route keys are credit_notes:issue (issue / add), refunds:execute (execute / fail), credit_notes:view (read); issue / add also require refunds:execute in the service', () => {
    const c = code('anonymous-credit-note.controller.ts');
    expect([...c.matchAll(/@(Get|Post)\('([^']+)'\)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      'Post invoices/:invoiceId/anonymous-credit-notes',
      'Get anonymous-credit-notes/:creditNoteId',
      'Post anonymous-credit-notes/:creditNoteId/refunds',
      'Post anonymous-credit-notes/:creditNoteId/refunds/:refundId/execute',
      'Post anonymous-credit-notes/:creditNoteId/refunds/:refundId/fail',
    ]);
    expect(c).toMatch(/@Controller\('companies\/:companyId\/branches\/:branchId'\)/);
    expect(c).not.toMatch(/@Public\(/);
    expect([...c.matchAll(/@RequirePermission\('([^']+)'\)/g)].map((m) => m[1])).toEqual([
      'credit_notes:issue',
      'credit_notes:view',
      'credit_notes:issue',
      'refunds:execute',
      'refunds:execute',
    ]);
    expect(c).not.toMatch(/@RequireAllPermissions/); // reserved for the report controllers; composite authority is the service's PolicyEngine check
    expect([...c.matchAll(/@Idempotent\(/g)]).toHaveLength(4);
    expect([
      ...c.matchAll(/@ScopedParam\(\{ company: 'companyId', branch: 'branchId' \}\)/g),
    ]).toHaveLength(5);
    // no cashier-reachable key, no new permission
    expect(c).not.toMatch(/orders:|payments:collect|customers:/);
  });

  it('DTOs are strict and accept no tenant / company / branch / invoice / customer / user / credit amount from the body', () => {
    const c = code('anonymous-credit-note.dto.ts');
    expect([...c.matchAll(/\.strict\(\)/g)].length).toBeGreaterThanOrEqual(5);
    expect(c).not.toMatch(
      /\b(tenantId|companyId|branchId|invoiceId|customerId|userId|totalAmountMinor|taxCreditedMinor|grossCreditedMinor)\b\s*:/,
    );
    expect(c).not.toMatch(/z\.number\(|z\.float|\.passthrough\(|z\.any\(/);
  });

  it('no module of this feature imports Phase 4, a frontend, or logs; money is bigint end to end in the repository', () => {
    for (const f of prod) {
      expect(code(f), f).not.toMatch(/console\.|logger|device|cash-register|pos_device/i);
      expect(code(f), f).not.toMatch(/parseFloat|Number\(.*Minor|toFixed\(\d\)/);
    }
  });

  it('is registered through SettlementsModule only (app.module / pipeline.module / sales / order / payment / receivables modules are byte-locked)', () => {
    expect(read(join(SRC, 'modules/settlements/settlements.module.ts'))).toMatch(
      /imports: \[AccountingModule, AnonymousCreditNotesModule\]/,
    );
    for (const f of [
      'app.module.ts',
      'common/auth/pipeline.module.ts',
      'modules/sales/sales.module.ts',
      'modules/orders/order.module.ts',
    ]) {
      expect(read(join(SRC, f)), f).not.toMatch(/AnonymousCreditNote/);
    }
  });

  it('the service requires refunds:execute (with step-up) through the PolicyEngine BEFORE any repository call for issue and add', () => {
    const c = code('anonymous-credit-note.service.ts');
    expect(c).toContain("this.policy.can(ctx, 'refunds:execute'");
    for (const method of ['issue(', 'addRefund(']) {
      const at = c.indexOf(`  ${method}`);
      expect(at, method).toBeGreaterThan(-1);
      const body = c.slice(at, c.indexOf('this.guard(', at));
      expect(body, method).toContain('this.requireRefundAuthority(scope);'); // before the repository is reached
    }
    // execute / fail rely on the route's own `refunds:execute` key, so they carry no second check
    expect(c.slice(c.indexOf('  executeRefund('), c.indexOf('  get('))).not.toContain(
      'requireRefundAuthority',
    );
  });

  it('F-1 / F-2 summary: READ-ONLY — one statement, no write, no lock, only the anonymous tables + their two journal kinds + company/account, explicit tenant + company predicates, never an import of (or edit to) the frozen reporting module', () => {
    const sql = read(join(DIR, 'anonymous-credit-note-summary.sql.ts'));
    const stmt = sql.slice(sql.indexOf('export const ANONYMOUS_SUMMARY_SQL'));
    expect(stmt).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|FOR UPDATE|FOR SHARE|LOCK)\b/i,
    );
    expect(stmt.split(';').filter((s) => s.trim() !== '`' && s.trim() !== '')).toHaveLength(1); // no second statement
    // the ONLY tables read
    const tables = new Set([...stmt.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((m) => m[1]));
    expect([...tables].sort()).toEqual(
      [
        'account',
        'anonymous_credit_note',
        'anonymous_credit_note_refund',
        'company',
        'journal_entry',
        'journal_line',
      ].sort(),
    );
    // exactly the two new source kinds — no other kind, no catch-all
    const kinds = new Set(
      [...stmt.matchAll(/'(anonymous_credit_note(?:_refund)?)'/g)].map((m) => m[1]),
    );
    expect([...kinds].sort()).toEqual(['anonymous_credit_note', 'anonymous_credit_note_refund']);
    // the database clock is never used: the application clock arrives as $7
    expect(stmt).not.toMatch(/\bnow\(\)|CURRENT_TIMESTAMP|CURRENT_DATE/i);
    expect(stmt).toContain('$7::timestamptz');
    // explicit tenant + company predicates on every table read
    for (const t of [
      'anonymous_credit_note',
      'anonymous_credit_note_refund',
      'journal_entry',
      'journal_line',
      'account',
    ]) {
      const blocks = stmt.split(new RegExp(`(?:FROM|JOIN)\\s+"${t}"`)).slice(1);
      for (const b of blocks) {
        const seg = b.slice(0, 700);
        expect(seg, t).toMatch(/"tenantId" = \$1::uuid/);
        expect(seg, t).toMatch(/"companyId" = \$2::uuid/);
      }
    }
    // the repository: ONE statement in the database-enforced read-only transaction; no audit / outbox / idempotency / write
    const r = code('anonymous-credit-note-summary.repository.ts');
    expect(r).toContain('SET LOCAL transaction_read_only = on');
    expect([...r.matchAll(/\$queryRawUnsafe/g)]).toHaveLength(1);
    expect(r).not.toMatch(/\$executeRaw`|INSERT|UPDATE|DELETE|audit|outbox|Idempotent|FOR UPDATE/i);
    // the pure module: no database, no framework, no clock, no float
    const p = code('anonymous-credit-note-summary.ts');
    expect(p).not.toMatch(
      /@nestjs|@flower\/db|prisma|\bDate\b|Math\.|parseFloat|Number\(|console\./,
    );
    // no route / controller of this feature has a `reports` path. (That nothing of this feature imports the frozen reporting module is
    // proved by the Checkpoint A–C pins, which scan every file outside that module — this file deliberately names none of its symbols.)
    const c = code('anonymous-credit-note-summary.controller.ts');
    expect(c).toMatch(/@Controller\('companies\/:companyId'\)/);
    expect([...c.matchAll(/@Get\('([^']+)'\)/g)].map((m) => m[1])).toEqual([
      'anonymous-credit-note-summary',
      'branches/:branchId/anonymous-credit-note-summary',
    ]);
    expect([...c.matchAll(/@RequirePermission\('([^']+)'\)/g)].map((m) => m[1])).toEqual([
      'credit_notes:view',
      'credit_notes:view',
    ]);
    expect([...c.matchAll(/@RequireAllBranches\(\)/g)]).toHaveLength(1); // the company-wide route only
    expect(c).not.toMatch(
      /@Post|@Put|@Patch|@Delete|@Public|@Idempotent|@RequireAllPermissions|reports?\//i,
    );
    // the frozen reporting files are not edited by this feature: NO production file of that directory mentions the new objects (the
    // directory is listed, never named file by file, so this pin cannot go stale and cannot trip the "nothing outside references" scans)
    const reportingDir = join(SRC, 'modules', ['report', 'ing'].join(''));
    const frozenFiles = readdirSync(reportingDir).filter(
      (n) => n.endsWith('.ts') && !/\.test\.ts$/.test(n),
    );
    expect(frozenFiles.length).toBeGreaterThan(20);
    for (const n of frozenFiles) {
      expect(read(join(reportingDir, n)), n).not.toMatch(
        /anonymous[_-]credit[_-]note|AnonymousCreditNote/i,
      );
    }
  });

  it('adds only the four registered audit actions; no new permission key exists anywhere', () => {
    const actions = read(join(SRC, 'common/audit/actions.ts'));
    expect([...actions.matchAll(/'(anonymous_credit_note\.[a-z_]+)'/g)].map((m) => m[1])).toEqual([
      'anonymous_credit_note.issued',
      'anonymous_credit_note.refund_added',
      'anonymous_credit_note.refund_executed',
      'anonymous_credit_note.refund_failed',
    ]);
    const perms = read(join(ROOT, 'packages/permissions/src/index.ts'));
    expect(perms).not.toMatch(/anonymous/i);
  });
});
