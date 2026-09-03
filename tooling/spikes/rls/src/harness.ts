import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

export const SPIKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The three connection targets the spike must prove isolation on. */
export interface Endpoint {
  readonly label: 'direct' | 'pgbouncer-transaction' | 'pgbouncer-session';
  /** superuser URL (for setup/seed) */
  readonly adminUrl: string;
  /** app-role URL (spike_app, NOSUPERUSER NOBYPASSRLS) — what the "app" uses */
  readonly appUrl: string;
}

const HOST = process.env['SPIKE_HOST'] ?? 'localhost';

export const ENDPOINTS: Endpoint[] = [
  {
    label: 'direct',
    adminUrl: `postgresql://postgres:postgres@${HOST}:55532/spike`,
    appUrl: `postgresql://spike_app:spike_app@${HOST}:55532/spike`,
  },
  {
    label: 'pgbouncer-transaction',
    adminUrl: `postgresql://postgres:postgres@${HOST}:55533/spike`,
    appUrl: `postgresql://spike_app:spike_app@${HOST}:55533/spike?pgbouncer=true`,
  },
  {
    label: 'pgbouncer-session',
    adminUrl: `postgresql://postgres:postgres@${HOST}:55534/spike`,
    appUrl: `postgresql://spike_app:spike_app@${HOST}:55534/spike?pgbouncer=true`,
  },
];

export function composeUp(): void {
  execFileSync('docker', ['compose', 'up', '-d', '--wait'], { cwd: SPIKE_DIR, stdio: 'inherit' });
}

export function composeDown(): void {
  try {
    execFileSync('docker', ['compose', 'down', '-v'], { cwd: SPIKE_DIR, stdio: 'inherit' });
  } catch {
    /* best effort */
  }
}

/** Fresh schema every run: migrate deploy on the direct connection, then apply RLS + seed. */
export interface SpikeSeed {
  tenantA: string;
  tenantB: string;
  countA: number;
  countB: number;
}

export async function resetAndSeed(directAdminUrl: string): Promise<SpikeSeed> {
  // 1. drop everything so `migrate deploy` starts clean
  const admin = new pg.Client({ connectionString: directAdminUrl });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.query('GRANT ALL ON SCHEMA public TO postgres;');
  await admin.end();

  // 2. prisma migrate deploy
  execFileSync(
    'node',
    [path.join(SPIKE_DIR, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: SPIKE_DIR, env: { ...process.env, DATABASE_URL: directAdminUrl }, stdio: 'inherit' },
  );

  // 3. RLS policies + app role
  const admin2 = new pg.Client({ connectionString: directAdminUrl });
  await admin2.connect();
  await admin2.query(readFileSync(path.join(SPIKE_DIR, 'sql', 'rls.sql'), 'utf8'));

  // 4. seed two tenants with rows (as superuser; RLS is FORCE so we bypass with a
  //    session GUC set to each tenant while inserting)
  const a = (
    await admin2.query<{ id: string }>(
      "INSERT INTO spike_tenant(name) VALUES('Tenant A') RETURNING id",
    )
  ).rows[0]!.id;
  const b = (
    await admin2.query<{ id: string }>(
      "INSERT INTO spike_tenant(name) VALUES('Tenant B') RETURNING id",
    )
  ).rows[0]!.id;

  const countA = 5;
  const countB = 3;
  await admin2.query("SELECT set_config('app.tenant_id', $1, false)", [a]);
  for (let i = 0; i < countA; i++) {
    await admin2.query('INSERT INTO spike_row(tenant_id, secret) VALUES($1, $2)', [
      a,
      `A-secret-${i}`,
    ]);
  }
  await admin2.query("SELECT set_config('app.tenant_id', $1, false)", [b]);
  for (let i = 0; i < countB; i++) {
    await admin2.query('INSERT INTO spike_row(tenant_id, secret) VALUES($1, $2)', [
      b,
      `B-secret-${i}`,
    ]);
  }
  await admin2.query("SELECT set_config('app.tenant_id', '', false)");
  await admin2.end();

  return { tenantA: a, tenantB: b, countA, countB };
}

/** Rough wrapper-overhead measurement for the ADR. */
export async function measureLatency(
  fn: () => Promise<unknown>,
  iterations = 50,
): Promise<{ p50: number; p95: number; mean: number }> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((x, y) => x - y);
  const p = (q: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
  return {
    p50: round2(p(0.5)),
    p95: round2(p(0.95)),
    mean: round2(samples.reduce((s, v) => s + v, 0) / samples.length),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
