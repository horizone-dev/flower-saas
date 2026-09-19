import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Task 3b.2 Checkpoint C — structural/source-level proofs that need no
 * database. Complements the DB-backed proofs in
 * `packages/db/test/customer-schema.integration.test.ts` and the
 * repository/service-level proofs in `customer.repository.integration.test.ts`
 * / `customer.controller.integration.test.ts`.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Strip `/* ... *\/` block and `// ...` line comments — this codebase's own
 *  doc comments legitimately name the very terms these tests scan FOR
 *  ("never calls PostingEngine", "no unarchive route") to explain their
 *  absence, which would otherwise false-positive a naive substring/regex
 *  scan (the exact pitfall task 3b.2 checkpoint B's own self-review caught
 *  and fixed the same way). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function readAllTsSource(): string {
  const files = readdirSync(moduleDir, { recursive: true, encoding: 'utf8' });
  return files
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => readFileSync(path.join(moduleDir, f), 'utf8'))
    .join('\n');
}

describe('Task 3b.2 hard-gate matrix — structural proofs', () => {
  const controllerSourceRaw = readFileSync(path.join(moduleDir, 'customer.controller.ts'), 'utf8');
  const repositorySource = readFileSync(path.join(moduleDir, 'customer.repository.ts'), 'utf8');
  const controllerSource = stripComments(controllerSourceRaw);
  const allSource = stripComments(readAllTsSource());

  it('no permission beyond the frozen set is ever referenced, and credit:override has zero execution surface in this module', () => {
    const keys = new Set([...allSource.matchAll(/'customers:[a-z:]+'/g)].map((m) => m[0]));
    // this module's own HTTP surface only ever checks 3 of the 4 frozen keys —
    // customers:credit:override is registered elsewhere (checkpoint A's
    // permission migration / system-roles.ts) but deliberately has ZERO
    // reference here (task 3b.2 §0.K — registered, never executed).
    expect([...keys].sort()).toEqual(
      ["'customers:view'", "'customers:manage'", "'customers:credit:manage'"].sort(),
    );
    expect(allSource).not.toMatch(/customers:credit:override/);
    expect(allSource).not.toMatch(/customers:tenant|customers:view:all|tenant-wide-customer/);
  });

  it('no generic optional-company-bypass method exists (no includeAllCompanies/skipCompanyFilter-shaped parameter)', () => {
    expect(allSource).not.toMatch(/includeAllCompanies|skipCompanyFilter|allCompanies\s*[?:]/i);
  });

  it('every raw SQL read from "customer" c joins through customer_company_account within the same statement', () => {
    // split the source on each `FROM "customer" c` occurrence and check the
    // next ~400 chars (the rest of that one SQL statement) contains the join —
    // every company-scoped read method uses this exact shape.
    const parts = repositorySource.split('FROM "customer" c');
    expect(parts.length).toBeGreaterThan(1); // at least one such SELECT exists
    for (let i = 1; i < parts.length; i++) {
      const nextStatement = parts[i]!.slice(0, 400);
      expect(nextStatement).toMatch(/INNER JOIN "customer_company_account"/);
    }
  });

  it('the controller/service layers do not import @flower/db except the sanctioned type-only ScopedTx (ADR-0004)', () => {
    for (const file of ['customer.service.ts', 'customer.controller.ts']) {
      const src = readFileSync(path.join(moduleDir, file), 'utf8');
      expect(src, `${file} must not import @flower/db`).not.toMatch(/from ['"]@flower\/db['"]/);
    }
    // the repository's only @flower/db import is the documented type-only ScopedTx
    const dbImports = [...repositorySource.matchAll(/import[^;]*from ['"]@flower\/db['"];/g)];
    expect(dbImports).toHaveLength(1);
    expect(dbImports[0]![0]).toMatch(/^import type/);
  });

  it('no caller-controlled currency exponent exists in the credit-config DTO (the row TYPE legitimately carries the field as server-computed OUTPUT, which is not the same thing)', () => {
    const dtoSource = stripComments(
      readFileSync(path.join(moduleDir, 'dto/configure-credit.dto.ts'), 'utf8'),
    );
    expect(dtoSource).not.toMatch(/[Ee]xponent/);
  });

  it('no credit-override execution endpoint, no hard-delete endpoint, no unarchive endpoint', () => {
    const routeCalls = [
      ...controllerSource.matchAll(/@(Get|Post|Patch|Put|Delete)\(([^)]*)\)/g),
    ].map((m) => `${m[1]!.toUpperCase()} ${m[2]?.replace(/['"]/g, '') ?? ''}`.trim());
    expect(routeCalls.some((r) => r.startsWith('DELETE'))).toBe(false);
    expect(controllerSource).not.toMatch(/override|unarchive|reactivate|\/restore/i);
  });

  it('no Customer PII outbox/realtime event anywhere in the module', () => {
    expect(allSource).not.toMatch(/OutboxWriter|outbox\.enqueue|realtime/i);
  });

  it('no PostingEngine reference and no AR/Advance projection field anywhere in the module', () => {
    expect(allSource).not.toMatch(/PostingEngine|postJournal/);
    expect(allSource).not.toMatch(/currentOutstanding|availableCredit|advanceBalance/);
  });

  it('no `Number()` coercion of a credit-limit money value — BigInt end to end', () => {
    expect(repositorySource).not.toMatch(/Number\(\s*(creditLimitMinor|input\.creditLimitMinor)/);
  });

  it('no reopen capability anywhere in the module', () => {
    expect(allSource).not.toMatch(/reopen/i);
  });

  it('no Opening Balance field/capability exists anywhere — explicitly deferred to task 3b.6 (owner Checkpoint D §22)', () => {
    expect(allSource).not.toMatch(/openingBalance/i);
  });

  it("the tenant-wide route requires companyScope === 'ALL' via a repository-level check, not a route param", () => {
    expect(repositorySource).toMatch(/requireTenantWideScope/);
    expect(repositorySource).toMatch(/companyScope\s*!==\s*'ALL'/);
  });
});
