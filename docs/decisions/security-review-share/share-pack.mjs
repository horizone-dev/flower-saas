#!/usr/bin/env node
// SHARE PACK — the exact files handed to (a) the authorized database operator and (b) the independent security reviewer, with a sha256 for each, and a verifier for the recipient.
//
//   node share-pack.mjs generate                     (maintainer, in the repo) write SHARE-MANIFEST.json next to this script
//   node share-pack.mjs verify <folder> [operator|reviewer]   (recipient) check the files in <folder> against the manifest (default: operator)
//   node share-pack.mjs hashes                       print the sha256 of this script and of SHARE-MANIFEST.json — the owner sends THESE through a SEPARATE channel so the recipient can trust the verifier
//
// OFFLINE: reads files, writes only SHARE-MANIFEST.json (generate), no network, no process, no environment variable. Hashes are over LF-normalised text, so a checkout with CRLF verifies the same.
// A file is looked up at <folder>/<repo-relative path>, and failing that at <folder>/<file name> (a flat copy).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const MANIFEST = path.join(HERE, 'SHARE-MANIFEST.json');
const PKGS = 'docs/decisions/promotion-packages';
const lf = (s) => s.replace(/\r\n/g, '\n');
const sha = (file) =>
  createHash('sha256')
    .update(lf(readFileSync(file, 'utf8')))
    .digest('hex');

const walk = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => walk(`${rel}/${e.name}`));
};

/** the files the OPERATOR needs: the script, its report tool, their README and the staging-only runbook */
const OPERATOR = [
  `${PKGS}/phase-4-security-preflight/PREFLIGHT.sql`,
  `${PKGS}/phase-4-security-preflight/preflight-report.mjs`,
  `${PKGS}/phase-4-security-preflight/README.md`,
  'docs/decisions/STAGING-PREFLIGHT-RUNBOOK.md',
];
/** everything the REVIEWER reads / reproduces from, in addition to the operator files */
const REVIEWER_EXTRA = [
  'docs/decisions/AL1-SE1-INDEPENDENT-REVIEW-HANDOFF.md',
  'docs/decisions/SECURITY-OPERATOR-AND-REVIEWER-HANDOFF.md',
  'docs/decisions/D-ORDER-OWNER-DECISION.md',
  'docs/decisions/proposed-migrations/DRAFT-AL1-audit-log-immutability.sql',
  'docs/decisions/proposed-migrations/DRAFT-SE1-security-event-isolation.sql',
  'docs/decisions/proposed-migrations/patches/T1-accounting-period-race-handler.patch',
  ...walk(`${PKGS}/phase-4-audit-log-immutability`),
  ...walk(`${PKGS}/phase-4-security-event-isolation`),
  // the stacked dependency (the pin patches stack after it) — not the whole package
  `${PKGS}/phase-4-d-z1-e1/PACKAGE.json`,
  `${PKGS}/phase-4-d-z1-e1/README.md`,
  `${PKGS}/phase-4-d-z1-e1/pin-amendments.patch`,
  `${PKGS}/phase-4-7-audit-registration/rehearse.mjs`,
  // the real-PostgreSQL proofs and the structural pins
  'packages/db/test/phase4-audit-log-hardening.integration.test.ts',
  'packages/db/test/phase4-security-event-isolation.integration.test.ts',
  'packages/db/test/phase4-security-preflight.integration.test.ts',
  'packages/db/test/phase4-security-preflight-operator.integration.test.ts',
  'packages/db/test/phase4-activation-order.integration.test.ts',
  'apps/api/src/verification/audit-log-hardening-package.structural.test.ts',
  'apps/api/src/verification/security-event-isolation-package.structural.test.ts',
  'apps/api/src/verification/security-preflight.structural.test.ts',
  'apps/api/src/verification/preflight-report.test.ts',
  'apps/api/src/verification/phase4-inventory-migration-ordering.structural.test.ts',
  // READ-ONLY REFERENCES for D-ORDER: the Inventory order manifest and checker are LOCKED by S-1 — included so the reviewer can see the conflict, never to be edited
  'docs/decisions/proposed-migrations/inventory-activation-manifest.json',
  'apps/api/src/modules/stock/reads/inventory-migration-manifest.ts',
  'apps/api/src/modules/stock/reads/inventory-migration-manifest.test.ts',
];

const unique = (xs) => [...new Set(xs)].sort();

function generate() {
  const operator = unique(OPERATOR);
  const reviewer = unique([...OPERATOR, ...REVIEWER_EXTRA]);
  const missing = reviewer.filter((f) => !existsSync(path.join(ROOT, f)));
  if (missing.length > 0) {
    console.error(`cannot generate — files missing:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  const files = Object.fromEntries(reviewer.map((f) => [f, sha(path.join(ROOT, f))]));
  const manifest = {
    note: 'sha256 over LF-normalised text. Verify with: node share-pack.mjs verify <folder> operator|reviewer. This manifest and share-pack.mjs are not listed in it: the owner sends their hashes (node share-pack.mjs hashes) through a separate channel.',
    packs: { operator, reviewer },
    files,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `SHARE-MANIFEST.json written: operator ${operator.length} files, reviewer ${reviewer.length} files`,
  );
}

function verify(folder, pack) {
  if (!folder || !existsSync(folder)) {
    console.error('usage: node share-pack.mjs verify <folder> [operator|reviewer]');
    process.exit(2);
  }
  if (!existsSync(MANIFEST)) {
    console.error('SHARE-MANIFEST.json is not next to this script');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const list = manifest.packs[pack];
  if (!list) {
    console.error(`unknown pack "${pack}" (operator | reviewer)`);
    process.exit(2);
  }
  let bad = 0;
  for (const rel of list) {
    const candidates = [path.join(folder, rel), path.join(folder, path.basename(rel))];
    const found = candidates.find((c) => existsSync(c) && statSync(c).isFile());
    if (!found) {
      console.log(`MISSING   ${rel}`);
      bad++;
      continue;
    }
    const actual = sha(found);
    if (actual === manifest.files[rel]) console.log(`OK        ${rel}`);
    else {
      console.log(
        `MISMATCH  ${rel}  (expected ${manifest.files[rel].slice(0, 12)}…, found ${actual.slice(0, 12)}…)`,
      );
      bad++;
    }
  }
  console.log(
    bad === 0
      ? `\nALL FILES VERIFIED (${list.length}, ${pack} pack)`
      : `\n${bad} PROBLEM(S) — do not use these files`,
  );
  console.log(
    'Now compare the sha256 of share-pack.mjs and SHARE-MANIFEST.json (node share-pack.mjs hashes) with the values the owner sent you through a separate channel.',
  );
  process.exit(bad === 0 ? 0 : 1);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'generate') generate();
else if (cmd === 'verify') verify(a, b ?? 'operator');
else if (cmd === 'hashes') {
  console.log(`share-pack.mjs        ${sha(fileURLToPath(import.meta.url))}`);
  console.log(`SHARE-MANIFEST.json   ${existsSync(MANIFEST) ? sha(MANIFEST) : '(not generated)'}`);
} else {
  console.error(
    'usage: node share-pack.mjs generate | verify <folder> [operator|reviewer] | hashes',
  );
  process.exit(2);
}
