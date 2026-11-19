#!/usr/bin/env node
/**
 * Writes infra/migrate/approved-migrations.json from the migrations COMMITTED at git HEAD (name -> SHA-256 of migration.sql, LF-normalised).
 * "Approved" means committed: an uncommitted folder (a Phase 4 or MVP draft) is never in the manifest, so the runner refuses it. Committing
 * the regenerated manifest is the explicit approval act; review its diff like any other migration change.
 *   node infra/migrate/generate-approved-manifest.mjs [--check]     (--check: exit 1 if the file differs from HEAD, writes nothing)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...a) =>
  execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const base = 'packages/db/prisma/migrations';
const files = git('ls-tree', '-r', '--name-only', 'HEAD', base)
  .split('\n')
  .filter((f) => f.endsWith('/migration.sql'))
  .sort();
const migrations = {};
for (const f of files) {
  const name = f.slice(base.length + 1, -'/migration.sql'.length);
  migrations[name] = createHash('sha256')
    .update(git('show', `HEAD:${f}`).replace(/\r\n/g, '\n'))
    .digest('hex');
}
const text = `${JSON.stringify({ source: 'git HEAD', count: files.length, migrations }, null, 2)}\n`;
const target = path.join(root, 'infra/migrate/approved-migrations.json');
if (process.argv.includes('--check')) {
  let cur = '';
  try {
    cur = readFileSync(target, 'utf8');
  } catch {
    /* missing */
  }
  if (cur !== text) {
    console.error('approved-migrations.json differs from the migrations committed at HEAD');
    process.exit(1);
  }
  console.log(`ok: ${files.length} approved migrations match HEAD`);
} else {
  writeFileSync(target, text);
  console.log(`wrote ${target}: ${files.length} migrations`);
}
