// COMPATIBILITY runner: runs EXISTING platform integration tests (unchanged, from the real tree) against databases that are HARDENED with DRAFT-AL1 right after their real migrations.
//
// How: a throw-away directory `apps/api/zz-al1-compat/` holds a vitest config + a setup file that wraps `migrateTestDb` (from @flower/testing) so that, after the REAL `prisma migrate deploy`, the AL1 draft SQL
// is applied to the same disposable database. Nothing in the real tree is edited; the directory is deleted at the end. Every application is LOGGED, and the run is only credible if the number of hardened
// databases is >= the number of test files (each file starts its own stack) — the script prints both so a test that bypasses `migrateTestDb` cannot hide.
//
//   node compat.mjs            run the default set of audit-relevant integration tests (authentication / platform, accounting, financial, devices, cash register, expenses)
//   node compat.mjs <file>...  run the given test files (paths relative to apps/api)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../..');
const API = path.join(ROOT, 'apps/api');
const DIR = path.join(API, 'zz-al1-compat');
const SQL = path.join(
  ROOT,
  'docs/decisions/proposed-migrations/DRAFT-AL1-audit-log-immutability.sql',
);
const LOG = path.join(DIR, 'applied.log');

const DEFAULT_SET = [
  'src/modules/platform/audit-foundation.integration.test.ts',
  'src/modules/platform/platform.integration.test.ts',
  'src/modules/platform/provisioning.integration.test.ts',
  'src/modules/platform/catalog-capability.integration.test.ts',
  'src/modules/access/access.integration.test.ts',
  'src/modules/access/staff-onboarding.integration.test.ts',
  'src/modules/org/org.integration.test.ts',
  'src/modules/accounting/posting-engine.integration.test.ts',
  'src/modules/accounting/accounting-period.integration.test.ts',
  'src/modules/accounting/accounting.controller.integration.test.ts',
  'src/modules/payments/payment-audit-outbox.integration.test.ts',
  'src/modules/payments/payment-collection.repository.integration.test.ts',
  'src/modules/orders/invoice-issuance.repository.integration.test.ts',
  'src/modules/orders/order.controller.integration.test.ts',
  'src/modules/receivables/opening-balance.integration.test.ts',
  'src/modules/cash-register/cash-register.integration.test.ts',
  'src/modules/cash-register/cash-in-out.integration.test.ts',
  'src/modules/devices/devices.integration.test.ts',
  'src/modules/catalog/catalog-core.integration.test.ts',
  'src/modules/customers/customer.controller.integration.test.ts',
  'src/modules/expenses/expense-service.integration.test.ts',
  'src/modules/expenses/expense-promotion-rehearsal.integration.test.ts',
  'src/modules/expenses/expense-audit.integration.test.ts',
];
const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SET;

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
writeFileSync(
  path.join(DIR, 'apply-sql.cjs'),
  `const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const c = new Client({ connectionString: process.argv[2] });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(fs.readFileSync(process.argv[3], 'utf8'));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
`,
);
writeFileSync(
  path.join(DIR, 'setup.ts'),
  `import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { vi } from 'vitest';

vi.mock('@flower/testing', async (importOriginal) => {
  const real = await importOriginal<typeof import('@flower/testing')>();
  return {
    ...real,
    migrateTestDb: (url: string): void => {
      real.migrateTestDb(url);
      // COMPAT_SKIP_AL1=1: a CONTROL — the same runner, config and shim, but the hardening is NOT applied (to tell what AL1 changes from what the runner changes)
      if (!process.env['COMPAT_SKIP_AL1'])
        execFileSync('node', [process.env['AL1_APPLY_SCRIPT']!, url, process.env['AL1_SQL']!], { stdio: 'pipe' });
      appendFileSync(process.env['AL1_COMPAT_LOG']!, new URL(url).pathname + '\\n');
    },
  };
});
`,
);
writeFileSync(
  path.join(DIR, 'vitest.config.ts'),
  `import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: ${JSON.stringify(API.replace(/\\/g, '/'))},
  test: {
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    setupFiles: [${JSON.stringify(path.join(DIR, 'setup.ts').replace(/\\/g, '/'))}],
  },
});
`,
);
writeFileSync(LOG, '');
// COMPAT_WITH_SE1=1: ALSO apply DRAFT-SE1 (security_event isolation) after AL1 on the same disposable databases
let sqlToApply = SQL;
if (process.env.COMPAT_WITH_SE1) {
  const SE1 = path.join(
    ROOT,
    'docs/decisions/proposed-migrations/DRAFT-SE1-security-event-isolation.sql',
  );
  sqlToApply = path.join(DIR, 'combined.sql');
  writeFileSync(sqlToApply, `${readFileSync(SQL, 'utf8')}\n${readFileSync(SE1, 'utf8')}\n`);
}

console.log(
  `running ${files.length} existing test files against HARDENED databases (AL1 applied after the real migrations)…`,
);
const r = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    '--config',
    path.join(DIR, 'vitest.config.ts'),
    ...files,
    // COMPAT_FILTER=<name>: only the tests whose name matches (a focused reproduction)
    ...(process.env.COMPAT_FILTER ? ['-t', process.env.COMPAT_FILTER] : []),
  ],
  {
    cwd: API,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 1 << 28,
    env: {
      ...process.env,
      AL1_APPLY_SCRIPT: path.join(DIR, 'apply-sql.cjs'),
      AL1_SQL: sqlToApply,
      AL1_COMPAT_LOG: LOG,
    },
  },
);
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
// COMPAT_OUT=<file>: keep the FULL vitest output (the summary below is filtered)
if (process.env.COMPAT_OUT) writeFileSync(process.env.COMPAT_OUT, out);
const applied = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length;
console.log(
  out
    .split('\n')
    .filter((l) => /Test Files|Tests |×| FAIL |AssertionError|Error:/.test(l))
    .join('\n'),
);
console.log(`hardened databases created: ${applied} for ${files.length} test files`);
rmSync(DIR, { recursive: true, force: true });
process.exit(r.status === 0 && applied >= files.length ? 0 : 1);
