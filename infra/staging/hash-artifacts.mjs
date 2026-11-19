#!/usr/bin/env node
/**
 * Prints the SHA-256 of every release artefact so an approval names EXACTLY what was reviewed:  node infra/staging/hash-artifacts.mjs
 * A file hash is the SHA-256 of its LF-normalised bytes. A set hash is the SHA-256 of the sorted lines `<path> <file-hash>` of its files, so
 * any added, removed or edited file changes it. Disposable smoke artefacts (.env*, .smoke*) are never included.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fileHash = (p) =>
  createHash('sha256')
    .update(readFileSync(p).toString('utf8').replace(/\r\n/g, '\n'))
    .digest('hex');
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

function walk(p, out = []) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const n of readdirSync(p)) {
      if (/^\.(env|smoke)|node_modules|\.next$/.test(n)) continue;
      walk(path.join(p, n), out);
    }
  } else out.push(p);
  return out;
}

function setHash(paths) {
  const files = paths.flatMap((x) => walk(path.join(root, x))).sort();
  const lines = files.map((f) => `${rel(f)} ${fileHash(f)}`);
  return { n: files.length, hash: createHash('sha256').update(lines.join('\n')).digest('hex') };
}

const P = 'docs/decisions/proposed-migrations/patches';
const ARTEFACTS = [
  ['R-1 secrets "disabled" provider (patch)', [`${P}/R1-secrets-disabled-provider.patch`]],
  ['R-1 vault test (disposable-copy proof)', [`${P}/R1-disabled-vault.integration.test.ts.txt`]],
  [
    'F-1 cashier/sales catalog:view — role + S0b bundle (patch)',
    [`${P}/F1-cashier-sales-catalog-view-BUNDLE.patch`],
  ],
  [
    'F-1 data migration (SQL, not in the migrations folder)',
    ['docs/decisions/proposed-migrations/DRAFT-F1-cashier-sales-catalog-view.sql'],
  ],
  [
    'F-3 receipt identity route (in the worktree)',
    [
      'apps/api/src/modules/org/receipt-identity.controller.ts',
      'apps/api/src/modules/org/receipt-identity.repository.ts',
    ],
  ],
  ['F-6 server VAT protection (patch, 11 files)', [`${P}/F6-vat-server-amendment-FULL.patch`]],
  [
    'F-7 staff onboarding (inert service/repo/scope)',
    [
      'apps/api/src/modules/access/staff-onboarding.service.ts',
      'apps/api/src/modules/access/staff-onboarding.repository.ts',
      'apps/api/src/modules/access/staff-scope.ts',
    ],
  ],
  [
    'F-7 route A draft (operator)',
    ['docs/decisions/proposed-migrations/DRAFT-F7-staff-invite.controller.ts.txt'],
  ],
  ['M-1 MFA enrol guard (patch + test)', [`${P}/M1-mfa-enrol-guard.patch`]],
  ['Migration runner + approved manifest', ['infra/migrate']],
  ['Staging Compose, Caddy, preflight, checks, smoke', ['infra/staging']],
  [
    'CI workflows (2 new)',
    ['.github/workflows/mvp-browser-journey.yml', '.github/workflows/mvp-release-checks.yml'],
  ],
  ['Platform-operator bootstrap CLI', ['apps/api/src/tooling']],
  [
    'Owner Web authenticator screen + sign-out revocation',
    [
      'apps/owner-web/src/app/(app)/security',
      'apps/owner-web/src/lib/mfa.ts',
      'apps/owner-web/src/lib/end-session.ts',
      'apps/owner-web/src/app/login',
    ],
  ],
  [
    'Deployment fixes (turbo env, web Dockerfile, lockfile)',
    ['turbo.json', 'infra/docker/web.Dockerfile', 'pnpm-lock.yaml'],
  ],
];
for (const [name, paths] of ARTEFACTS) {
  const missing = paths.filter((x) => !existsSync(path.join(root, x)));
  if (missing.length) {
    console.log(`${name}\n    MISSING: ${missing.join(', ')}`);
    continue;
  }
  const { n, hash } = setHash(paths);
  console.log(`${name}\n    ${hash}  (${n} file${n === 1 ? '' : 's'})`);
}
