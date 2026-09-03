import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPrismaClient } from '../src/client.js';
import { SCHEMA_BASELINE_KEY } from '../src/index.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 0.5 verification: a fresh Postgres 17 -> `prisma migrate deploy` -> the
 * expected baseline. Uses the real schema engine against a real database
 * (Testcontainers). Not mocked, not skipped.
 */
describe('packages/db — baseline migration', () => {
  let container: StartedPostgreSqlContainer;
  let url: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    url = container.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('applies the baseline migration to an empty database', () => {
    const out = execFileSync(
      'node',
      [path.join(pkgDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    expect(out).toMatch(/migration.*applied|already in sync|1 migration/i);
  }, 60_000);

  it('records exactly one applied migration in _prisma_migrations', async () => {
    const prisma = createPrismaClient({ connectionString: url });
    try {
      const rows = await prisma.$queryRawUnsafe<
        { migration_name: string; finished_at: Date | null }[]
      >('SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.migration_name).toMatch(/_baseline$/);
      expect(rows[0]?.finished_at).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);

  it('creates the app_meta table and nothing domain-shaped', async () => {
    const prisma = createPrismaClient({ connectionString: url });
    try {
      const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      const names = tables.map((t) => t.tablename);
      expect(names).toContain('app_meta');
      expect(names).toContain('_prisma_migrations');
      // Phase 0 baseline is intentionally domain-free.
      expect(names.filter((n) => !['app_meta', '_prisma_migrations'].includes(n))).toEqual([]);
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);

  it('the generated client round-trips a write (app_meta upsert)', async () => {
    const prisma = createPrismaClient({ connectionString: url });
    try {
      await prisma.appMeta.upsert({
        where: { key: SCHEMA_BASELINE_KEY },
        create: { key: SCHEMA_BASELINE_KEY, value: 'v0.4' },
        update: { value: 'v0.4' },
      });
      const row = await prisma.appMeta.findUnique({ where: { key: SCHEMA_BASELINE_KEY } });
      expect(row?.value).toBe('v0.4');
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);
});
