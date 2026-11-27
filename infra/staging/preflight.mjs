#!/usr/bin/env node
/**
 * Fails closed before the stack is started:  node infra/staging/preflight.mjs [path-to-env-file] [--local]
 * Refuses: a missing file, a missing/empty variable, any CHANGE_ME placeholder, secrets that are short or one repeated character, reused
 * passwords, localhost/example hostnames (unless --local), a wildcard ADMIN_CIDR, a floating or non-17 POSTGRES_IMAGE (must be
 * postgres:17.<minor>@sha256:<digest> and equal the reviewed infra/staging/postgres-image.pin; --local also accepts a plain 17.<minor> tag),
 * an env file readable by other users (POSIX), and an env file that is tracked by git. Prints only variable NAMES, never values.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PG_PINNED, PG_TAG, readPostgresPin } from './postgres-pin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const local = process.argv.includes('--local');
const file =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(here, '.env.staging');
const problems = [];
const bad = (m) => problems.push(m);

let text = '';
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.error(`refused: env file not found: ${file}`);
  process.exit(2);
}
const env = {};
for (const line of text.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const REQUIRED = [
  'POS_HOST',
  'OWNER_HOST',
  'OPS_HOST',
  'ADMIN_CIDR',
  'API_IMAGE',
  'POS_IMAGE',
  'OWNER_IMAGE',
  'MIGRATE_IMAGE',
  'POSTGRES_IMAGE',
  'MIGRATION_MODE',
  'POSTGRES_SUPERUSER_PASSWORD',
  'APP_DB_PASSWORD',
  'PLATFORM_DB_PASSWORD',
  'REDIS_PASSWORD',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'AUTH_JWT_SECRET',
  'SECRETS_PROVIDER',
];
const SECRETS = [
  'POSTGRES_SUPERUSER_PASSWORD',
  'APP_DB_PASSWORD',
  'PLATFORM_DB_PASSWORD',
  'REDIS_PASSWORD',
  'MINIO_ROOT_PASSWORD',
  'AUTH_JWT_SECRET',
];

for (const k of REQUIRED) {
  if (!env[k]) bad(`${k} is missing or empty`);
  else if (/CHANGE_ME/.test(env[k])) bad(`${k} still contains the CHANGE_ME placeholder`);
}
for (const k of SECRETS) {
  const v = env[k] ?? '';
  if (v && !/CHANGE_ME/.test(v)) {
    if (v.length < 24) bad(`${k} must be at least 24 characters`);
    if (/^(.)\1+$/.test(v)) bad(`${k} must not be one repeated character`);
    if (/[\s'"$`\\]/.test(v))
      bad(
        `${k} must not contain whitespace, quotes, $, backtick or backslash (it is embedded in connection URLs)`,
      );
  }
}
const seen = new Map();
for (const k of SECRETS) {
  const v = env[k];
  if (!v) continue;
  if (seen.has(v)) bad(`${k} reuses the value of ${seen.get(v)} — every secret must be distinct`);
  seen.set(v, k);
}
if (!local) {
  for (const k of ['POS_HOST', 'OWNER_HOST', 'OPS_HOST']) {
    const v = env[k] ?? '';
    if (/localhost|127\.0\.0\.1|\.local$|example\.(com|org|net)$/i.test(v))
      bad(`${k} must be a real public hostname (not localhost / example.*)`);
  }
  if (env['CADDYFILE'] && /Caddyfile\.local/.test(env['CADDYFILE']))
    bad('CADDYFILE must be ./Caddyfile (real ACME certificates) outside the local smoke');
}
if (new Set([env['POS_HOST'], env['OWNER_HOST'], env['OPS_HOST']]).size < 3)
  bad('POS_HOST, OWNER_HOST and OPS_HOST must be three different hostnames');
if (/^(0\.0\.0\.0\/0|::\/0)$/.test(env['ADMIN_CIDR'] ?? ''))
  bad('ADMIN_CIDR must not be the whole internet');
if (
  env['ADMIN_CIDR'] &&
  !/^[0-9a-f:.]+\/\d{1,3}$/i.test(env['ADMIN_CIDR']) &&
  !/CHANGE_ME/.test(env['ADMIN_CIDR'])
)
  bad('ADMIN_CIDR must be a CIDR such as 203.0.113.0/24');
if (!['check', 'deploy'].includes(env['MIGRATION_MODE'] ?? ''))
  bad('MIGRATION_MODE must be check or deploy');
if (!['disabled', 'kms'].includes(env['SECRETS_PROVIDER'] ?? ''))
  bad(
    'SECRETS_PROVIDER must be disabled (needs patch R-1) or kms (not wired); dev is refused in production',
  );
for (const k of ['API_IMAGE', 'POS_IMAGE', 'OWNER_IMAGE', 'MIGRATE_IMAGE']) {
  if (env[k] && /:(latest)?$/.test(env[k]))
    bad(`${k} must pin an explicit tag (not :latest / empty)`);
}
// The database and the backup job share ONE explicit PostgreSQL image. A floating tag lets a `docker compose pull` change the minor
// version silently (17.12 changed report query plans — Finding A) and lets pg_dump drift from the server it dumps.
// A real staging deployment needs the DIGEST too (a patch tag is mutable) and must equal the reviewed pin; `--local` rehearsals may use a tag.
const pgPin = readPostgresPin();
if (pgPin === null || !PG_PINNED.test(pgPin))
  bad(
    'POSTGRES_IMAGE: infra/staging/postgres-image.pin must hold exactly one reference of the form postgres:17.<minor>@sha256:<64 hex>',
  );
const pgImage = env['POSTGRES_IMAGE'];
if (pgImage && !/CHANGE_ME/.test(pgImage)) {
  if (!(PG_PINNED.test(pgImage) || (local && PG_TAG.test(pgImage))))
    bad(
      `POSTGRES_IMAGE must be postgres:17.<minor>@sha256:<64 hex>${local ? ' (or postgres:17.<minor> with --local)' : ''} — not postgres:17, :latest, a bare major, another major, a variant tag or a tag without a digest`,
    );
  else if (!local && pgPin !== null && pgImage !== pgPin)
    bad(
      'POSTGRES_IMAGE differs from the reviewed pin in infra/staging/postgres-image.pin — change the pin through a reviewed commit, not the server env file',
    );
}
if (process.platform !== 'win32') {
  try {
    if (statSync(file).mode & 0o077) bad('the env file is readable by group/others — chmod 600');
  } catch {
    /* ignore */
  }
}
try {
  const tracked = execFileSync('git', ['ls-files', '--error-unmatch', file], {
    stdio: 'pipe',
    cwd: path.dirname(file),
  }).toString();
  if (tracked)
    bad('the env file is TRACKED by git — remove it from the index; never commit secrets');
} catch {
  /* not tracked (expected) or not a git checkout */
}

if (problems.length) {
  console.error(
    `preflight FAILED (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(2);
}
console.log(
  `preflight ok: ${REQUIRED.length} variables present, ${SECRETS.length} distinct secrets, no placeholders`,
);
