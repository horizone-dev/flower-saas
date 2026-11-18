#!/usr/bin/env node
/**
 * One-shot, run AFTER the migrations: gives the two application roles a login password. The migrations create flower_app / flower_platform as
 * NOLOGIN (so no migration carries a secret); in production the API connects AS those roles (DATABASE_URL = flower_app, PLATFORM_DATABASE_URL
 * = flower_platform), which makes the per-transaction `SET LOCAL ROLE` a no-op and keeps flower_app unable to bypass RLS.
 * Fails CLOSED: refuses without both passwords, with a short or identical password, or if a role does not exist. Passwords come from files
 * (Docker secrets: APP_DB_PASSWORD_FILE / PLATFORM_DB_PASSWORD_FILE) or, for a one-off, the environment; they are never printed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const pg = createRequire(
  path.join(
    process.env.DB_PACKAGE_DIR ?? path.join(process.env.REPO_ROOT ?? process.cwd(), 'packages/db'),
    'package.json',
  ),
)('pg');
const refuse = (reason) => {
  console.error(JSON.stringify({ ok: false, refused: reason }));
  process.exit(2);
};
const secret = (name) => {
  const file = process.env[`${name}_FILE`];
  const v = file ? readFileSync(file, 'utf8').trim() : process.env[name];
  return v ?? '';
};
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) refuse('MIGRATION_DATABASE_URL is required');
const app = secret('APP_DB_PASSWORD');
const platform = secret('PLATFORM_DB_PASSWORD');
if (app.length < 24 || platform.length < 24)
  refuse('APP_DB_PASSWORD and PLATFORM_DB_PASSWORD are required, at least 24 characters each');
if (app === platform) refuse('the application and platform database passwords must differ');

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  if (!(await c.query("SELECT to_regclass('public._prisma_migrations') AS t")).rows[0].t)
    refuse('this database has no migrations applied — run the migration runner first');
  for (const [role, pw] of [
    ['flower_app', app],
    ['flower_platform', platform],
  ]) {
    const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
    if (!exists) refuse(`role ${role} does not exist — run the migrations first`);
    // %I quotes the identifier, %L the password literal (no injection); the statement text is never logged
    const sql = (
      await c.query("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS s", [
        role,
        pw,
      ])
    ).rows[0].s;
    await c.query(sql);
  }
  const r = (
    await c.query(
      `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('flower_app','flower_platform') ORDER BY rolname`,
    )
  ).rows;
  console.log(JSON.stringify({ ok: true, roles: r }));
} finally {
  await c.end();
}
