import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 3.8 — build-blocking static / review proof for the three narrow
 * cross-branch integrity read helpers (scope freeze rev.5 §3.4 / Correction F).
 *
 * There is deliberately NO generic `withTenantWideBranchIntegrity(tx, fn)`
 * callback. These assertions guarantee the helpers stay narrow, read-only, and
 * tenant-isolated, and that no controller can reach them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const helperFile = path.join(here, 'branch-price-integrity.repo.ts');
const src = readFileSync(helperFile, 'utf8');

/** strip line + block comments so we only assert against executable code */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const exec = code(src);

describe('branch-price-integrity.repo — narrow read helpers (task 3.8, Correction F)', () => {
  it('exports EXACTLY the three named helper functions — no generic callback', () => {
    const exported = [...exec.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map(
      (m) => m[1],
    );
    expect(exported.sort()).toEqual(
      [
        'findTenantWideBlockedCompanyPriceUoms',
        'countTenantWideBranchPriceUomDependencies',
        'countTenantWideBranchPriceVariantDependencies',
      ].sort(),
    );
    // no `withTenantWideBranchIntegrity` / any callback-accepting widening API
    expect(exec).not.toMatch(/withTenantWideBranchIntegrity/);
  });

  it('no helper accepts a callback / arbitrary-SQL parameter', () => {
    // no parameter typed as a function, no `Prisma.sql` / raw string passthrough
    expect(exec).not.toMatch(/:\s*\([^)]*\)\s*=>/); // an arrow-function param type
    expect(exec).not.toMatch(/fn\s*:/);
    expect(exec).not.toMatch(/callback/i);
    expect(exec).not.toMatch(/Prisma\.sql|Prisma\.raw|\$queryRawUnsafe|\$executeRawUnsafe/);
  });

  it('the dependency statements are SELECT-only — no INSERT / UPDATE / DELETE / MERGE / COPY', () => {
    // the ONLY writes permitted are the GUC save/restore via set_config(...).
    // Strip those, then assert the remaining SQL is SELECT-only.
    const sqlBlocks = [...exec.matchAll(/\$(?:queryRaw|executeRaw)`([\s\S]*?)`/g)].map(
      (m) => m[1]!,
    );
    expect(sqlBlocks.length).toBeGreaterThan(0);
    for (const block of sqlBlocks) {
      const isGucStmt = /set_config\('app\.branch_id'/.test(block) || /current_setting/.test(block);
      if (isGucStmt) continue;
      expect(block.trim()).toMatch(/^SELECT\b/i);
      expect(block).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|COPY|TRUNCATE)\b/i);
    }
  });

  it('neutralizes ONLY app.branch_id — never app.tenant_id, never a role change, never BYPASSRLS', () => {
    expect(exec).toMatch(/set_config\('app\.branch_id',\s*''/); // sets it to ''
    expect(exec).toMatch(/set_config\('app\.branch_id',\s*\$\{prev\}/); // restores it
    expect(exec).not.toMatch(/set_config\('app\.tenant_id'/);
    expect(exec).not.toMatch(
      /SET\s+(LOCAL\s+)?ROLE|BYPASSRLS|runPlatform|runDispatcher|flower_platform/i,
    );
    // every dependency SELECT also carries an explicit tenant predicate
    const depSelects = [...exec.matchAll(/\$queryRaw<[^>]*>`([\s\S]*?)`/g)]
      .map((m) => m[1]!)
      .filter((b) => /FROM "branch_variant_uom_price"/.test(b));
    expect(depSelects.length).toBe(3);
    for (const b of depSelects) expect(b).toMatch(/"tenantId"\s*=\s*\$\{tenantId\}/);
  });

  it('restores app.branch_id in a `finally` (a throw still restores)', () => {
    // exactly three helpers, each with a try/finally that restores the GUC.
    expect([...exec.matchAll(/\bfinally\s*\{/g)]).toHaveLength(3);
    expect([...exec.matchAll(/set_config\('app\.branch_id',\s*\$\{prev\}/g)]).toHaveLength(3);
    // and the restore is textually AFTER a `finally {` in every helper
    for (const body of [
      ...exec.matchAll(/export\s+async\s+function\s+[A-Za-z0-9_]+[\s\S]*?\n\}/g),
    ].map((m) => m[0])) {
      if (!/branch_variant_uom_price/.test(body)) continue;
      const finallyIdx = body.indexOf('finally {');
      const restoreIdx = body.indexOf("set_config('app.branch_id', ${prev}");
      expect(finallyIdx).toBeGreaterThan(-1);
      expect(restoreIdx).toBeGreaterThan(finallyIdx);
    }
  });

  it('is NOT imported by any controller; only these three helpers write app.branch_id in apps/api', () => {
    const dir = here;
    const controllers = readdirSync(dir).filter((f) => f.endsWith('.controller.ts'));
    expect(controllers.length).toBeGreaterThan(0);
    for (const c of controllers) {
      const s = readFileSync(path.join(dir, c), 'utf8');
      expect(s, `${c} must not import branch-price-integrity.repo`).not.toMatch(
        /branch-price-integrity\.repo/,
      );
    }
    // no OTHER file in the catalog module writes the branch GUC (executable code)
    for (const f of readdirSync(dir).filter(
      (x) => x.endsWith('.ts') && !x.endsWith('.test.ts') && x !== 'branch-price-integrity.repo.ts',
    )) {
      const s = code(readFileSync(path.join(dir, f), 'utf8'));
      expect(s, `${f} must not call set_config('app.branch_id', …)`).not.toMatch(
        /set_config\(\s*'app\.branch_id'/,
      );
    }
  });

  it('the three call-sites invoke the helper as a STANDALONE await — never inside a Promise.all', () => {
    for (const [file, helper] of [
      ['company-pricing.repository.ts', 'findTenantWideBlockedCompanyPriceUoms'],
      ['uom.repository.ts', 'countTenantWideBranchPriceUomDependencies'],
      ['variant.repository.ts', 'countTenantWideBranchPriceVariantDependencies'],
    ] as const) {
      const s = code(readFileSync(path.join(here, file), 'utf8'));
      // the helper is called with a bare `await helper(` and never appears inside
      // a `Promise.all([ ... helper( ... ])`
      expect(s).toMatch(new RegExp(`await\\s+${helper}\\(`));
      const promiseAllBlocks = [...s.matchAll(/Promise\.all\(\[([\s\S]*?)\]\)/g)].map((m) => m[1]!);
      for (const b of promiseAllBlocks) {
        expect(b, `${file}: ${helper} must not be inside a Promise.all`).not.toMatch(
          new RegExp(helper),
        );
      }
    }
  });
});
