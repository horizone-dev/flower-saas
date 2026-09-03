import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Apply `@flower/db`'s migrations (`prisma migrate deploy`) to a throwaway
 * database — for integration tests that need the real schema + RLS + roles.
 */
export function migrateTestDb(databaseUrl: string): void {
  const dbPkgDir = path.dirname(require.resolve('@flower/db/package.json'));
  const prismaBin = require.resolve('prisma/build/index.js');
  execFileSync('node', [prismaBin, 'migrate', 'deploy'], {
    cwd: dbPkgDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
