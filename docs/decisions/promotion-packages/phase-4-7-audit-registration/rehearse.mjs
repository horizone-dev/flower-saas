// Audit-registration REHEARSAL runner. Builds an ISOLATED copy of the tree (apps/api/zz-audit-sim — inside apps/api so `vitest` and the workspace packages resolve), applies the bundle to
// the COPY ONLY, runs the verification there, and deletes the copy. The real tree is never written (except the throw-away copy directory, removed at the end).
//
//   node rehearse.mjs prepare                 build the copy with ONLY the registry patch applied and KEEP it (used to author pin-amendments.patch)
//   node rehearse.mjs registered              copy + registry patch + pin amendments + rehearsal test; run; delete
//   node rehearse.mjs registered+promoted     the same, with the D → Z1 → E1 promotion package ALSO applied in the copy (compatibility proof)
//   node rehearse.mjs registered+hardened     the same, with the audit_log immutability draft (DRAFT-AL1) applied to the test database
//   node rehearse.mjs registered+promoted+hardened   all of it: promotion package + AL1 candidate migration + stacked pin amendments + hardened database
//   node rehearse.mjs registered+promoted+hardened+isolated   THE WHOLE STACK, in activation order: D/Z1/E1 migrations + pins -> AL1 candidate + pins -> SE1 (security_event isolation) candidate + pins
//   node rehearse.mjs manifest                (re)write BUNDLE.json (hashes of every artefact)
//
// AUDIT_EVIDENCE_OUT=<file> collects the measured evidence facts the rehearsal emits.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../..');
const BUNDLE = 'docs/decisions/promotion-packages/phase-4-7-audit-registration';
const PROMO = 'docs/decisions/promotion-packages/phase-4-d-z1-e1';
const SIM_REL = 'apps/api/zz-audit-sim';
const SIM = path.join(ROOT, SIM_REL);
const lf = (s) => s.replace(/\r\n/g, '\n');
const sha = (s) => createHash('sha256').update(lf(s)).digest('hex');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const SKIP = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'generated',
  'zz-audit-sim',
  'zz-promo-sim',
  '.git',
  'coverage',
]);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 1 << 28,
    ...opts,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function buildCopy() {
  rmSync(SIM, { recursive: true, force: true });
  mkdirSync(SIM, { recursive: true });
  // ANY `zz-*` scratch directory (a rehearsal / simulation copy, a compat runner, a probe) and any temp project directory is skipped BY PATTERN, never by an enumerated name: an enumerated list lets a newly named
  // scratch directory be swallowed into the copy it is itself being created for (a self-recursive copy that never terminates)
  const keep = (base) =>
    !SKIP.has(base) &&
    !base.startsWith('zz-') &&
    !base.startsWith('.promo-') &&
    !base.startsWith('.e1-rehearsal-') &&
    !base.startsWith('.al1-') &&
    !base.startsWith('.se1-');
  // a manual filtered walk: `cpSync` refuses to copy a directory into its own subtree (the copy lives under apps/api)
  const copyTree = (src, dst) => {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (!keep(e.name)) continue;
      if (e.isDirectory()) copyTree(path.join(src, e.name), path.join(dst, e.name));
      else if (e.isFile()) copyFileSync(path.join(src, e.name), path.join(dst, e.name));
    }
  };
  for (const d of ['apps', 'packages', 'docs', 'infra', '.github', 'tooling']) {
    if (existsSync(path.join(ROOT, d))) copyTree(path.join(ROOT, d), path.join(SIM, d));
  }
  for (const f of readdirSync(ROOT, { withFileTypes: true }))
    if (f.isFile()) copyFileSync(path.join(ROOT, f.name), path.join(SIM, f.name));
}
function apply(patchRel) {
  const r = sh('git', ['apply', `--directory=${SIM_REL}`, patchRel]);
  if (r.status !== 0) throw new Error(`patch ${patchRel} did not apply to the copy:\n${r.out}`);
  console.log(`applied (copy only): ${patchRel}`);
}
function applyPromotion() {
  for (const d of readdirSync(path.join(ROOT, PROMO, 'migrations'))) {
    mkdirSync(path.join(SIM, 'packages/db/prisma/migrations', d), { recursive: true });
    cpSync(
      path.join(ROOT, PROMO, 'migrations', d, 'migration.sql'),
      path.join(SIM, 'packages/db/prisma/migrations', d, 'migration.sql'),
    );
  }
  const schema = path.join(SIM, 'packages/db/prisma/schema.prisma');
  writeFileSync(
    schema,
    `${lf(readFileSync(schema, 'utf8'))}\n${lf(read(`${PROMO}/schema-additions.prisma`))}`,
  );
  apply(`${PROMO}/pin-amendments.patch`);
}

const mode = process.argv[2];
if (mode === 'manifest') {
  const files = {
    registry: `${BUNDLE}/registry.patch`,
    pinAmendments: `${BUNDLE}/pin-amendments.patch`,
    rehearsalTest: `${BUNDLE}/rehearsal/expense-audit.registered.rehearsal.integration.test.ts.txt`,
    requiredProvider: `${BUNDLE}/rehearsal/audit-required.provider.ts.txt`,
    securityEvidence: `${BUNDLE}/SECURITY-REVIEW-EVIDENCE.md`,
    runner: `${BUNDLE}/rehearse.mjs`,
  };
  const entries = Object.fromEntries(
    Object.entries(files).map(([k, p]) => [
      k,
      { file: p.slice(BUNDLE.length + 1), sha256: sha(read(p)) },
    ]),
  );
  const manifest = {
    bundle: 'phase-4-7-audit-registration',
    status: 'PREPARED_NOT_APPLIED',
    note: 'An UNAPPLIED approval bundle. The live registry (common/audit/actions.ts) and every production service are unchanged; the registered + REQUIRED state exists only inside the rehearsal copy.',
    liveRegistryPatchSource: {
      file: 'docs/decisions/proposed-migrations/patches/E1-audit-actions-registry.patch',
      sha256: sha(
        read('docs/decisions/proposed-migrations/patches/E1-audit-actions-registry.patch'),
      ),
    },
    artefacts: entries,
    proposedActions: [
      'expense_record.created',
      'expense_record.submitted',
      'expense_record.approved',
      'expense_record.rejected',
      'expense_record.paid',
      'expense_category.created',
      'expense_category.active_changed',
      'other_income.draft_created',
    ],
    activation: {
      liveRegistry: false,
      requiredPolicyBound: false,
      routes: false,
      permissionGrants: false,
      glPosting: false,
      cashMovement: false,
    },
    approvals: [
      ['SECURITY', 'AUDIT-ACTION-NAMES', 'the eight action names'],
      [
        'SECURITY',
        'AUDIT-PAYLOAD-ALLOWLIST',
        'the audit payload allow-list (keys, value bounds, what is deliberately excluded)',
      ],
      [
        'SECURITY',
        'AUDIT-SECURITY-FLAG',
        'security:false for all eight (they do not enter the security_event view)',
      ],
      [
        'SECURITY',
        'AUDIT-COVERAGE',
        'PLATFORM-AUDIT-EVENTS: which events activation must audit beyond the eight successes (refused attempts, reads)',
      ],
      [
        'SECURITY',
        'AUDIT-REQUIRED-ACTIVATION',
        'binding the REQUIRED audit policy (DI provider) — only after the registration',
      ],
      [
        'SECURITY',
        'AUDIT-LOG-IMMUTABILITY',
        'closing the audit_log append-only gap (frozen schema: app role can UPDATE / DELETE audit rows) before relying on these rows as evidence',
      ],
    ].map(([owner, id, what]) => ({ id, owner, what, recorded: false })),
  };
  writeFileSync(path.join(ROOT, BUNDLE, 'BUNDLE.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('BUNDLE.json written');
  process.exit(0);
}

// `+hardened` (any variant): ALSO apply the audit_log immutability draft (DRAFT-AL1) to the disposable database of the tests (AUDIT_LOG_HARDENED=1); with `+promoted` the AL1 candidate migration and
// its stacked pin amendments are applied to the copy as well. The AL1 package lives in docs/decisions/promotion-packages/phase-4-audit-log-immutability.
const AL1 = 'docs/decisions/promotion-packages/phase-4-audit-log-immutability';
const AL1_CANDIDATE = '20261205120300_phase_4_audit_log_immutability';
// `+isolated`: ALSO apply the SE1 (security_event isolation) candidate migration and its pin amendments, STACKED after AL1's — so it is only valid as `registered+promoted+hardened+isolated`.
const SE1 = 'docs/decisions/promotion-packages/phase-4-security-event-isolation';
const SE1_CANDIDATE = '20261205120400_phase_4_security_event_isolation';
let rest = mode ?? '';
const isolated = rest.endsWith('+isolated');
if (isolated) rest = rest.slice(0, -'+isolated'.length);
const hardened = rest.endsWith('+hardened');
const base = hardened ? rest.slice(0, -'+hardened'.length) : rest;
if (
  !['prepare', 'registered', 'registered+promoted'].includes(base ?? '') ||
  (isolated && !(hardened && base === 'registered+promoted'))
) {
  console.error(
    'usage: node rehearse.mjs prepare | registered | registered+promoted | registered+hardened | registered+promoted+hardened | registered+promoted+hardened+isolated | manifest',
  );
  process.exit(2);
}

buildCopy();
apply(`${BUNDLE}/registry.patch`);
if (base === 'prepare') {
  console.log(`copy kept at ${SIM_REL} (registry patch applied). Delete it when done.`);
  process.exit(0);
}
if (base === 'registered+promoted') applyPromotion();
if (hardened && base === 'registered+promoted') {
  mkdirSync(path.join(SIM, 'packages/db/prisma/migrations', AL1_CANDIDATE), { recursive: true });
  copyFileSync(
    path.join(ROOT, AL1, 'migrations', AL1_CANDIDATE, 'migration.sql'),
    path.join(SIM, 'packages/db/prisma/migrations', AL1_CANDIDATE, 'migration.sql'),
  );
  apply(`${AL1}/pin-amendments.patch`);
}
if (isolated) {
  mkdirSync(path.join(SIM, 'packages/db/prisma/migrations', SE1_CANDIDATE), { recursive: true });
  copyFileSync(
    path.join(ROOT, SE1, 'migrations', SE1_CANDIDATE, 'migration.sql'),
    path.join(SIM, 'packages/db/prisma/migrations', SE1_CANDIDATE, 'migration.sql'),
  );
  apply(`${SE1}/pin-amendments.patch`);
}
apply(`${BUNDLE}/pin-amendments.patch`);
mkdirSync(path.join(SIM, 'apps/api/src/modules/expenses'), { recursive: true });
writeFileSync(
  path.join(
    SIM,
    'apps/api/src/modules/expenses/expense-audit.registered.rehearsal.integration.test.ts',
  ),
  read(`${BUNDLE}/rehearsal/expense-audit.registered.rehearsal.integration.test.ts.txt`),
);
// the rehearsal test is SCAFFOLDING that exists only in the copy: register it in the copy's exact-file-list pin (the reviewed pin amendments are in pin-amendments.patch, not here)
const listPin = path.join(SIM, 'apps/api/src/verification/expense-income-model.structural.test.ts');
const listed = "      'expense-audit.integration.test.ts',\n";
const pinText = lf(readFileSync(listPin, 'utf8'));
if (!pinText.includes(listed)) throw new Error('exact-file-list pin anchor not found in the copy');
writeFileSync(
  listPin,
  pinText.replace(
    listed,
    `${listed}      'expense-audit.registered.rehearsal.integration.test.ts',\n`,
  ),
);

const walk = (d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.structural\.test\.ts$/.test(e.name) || /structural.*\.test\.ts$/.test(e.name))
      out.push(p);
  }
  return out;
};
const rel = (p) => path.relative(path.join(ROOT, 'apps/api'), p).replace(/\\/g, '/');
const structural = walk(path.join(SIM, 'apps/api/src'))
  .map(rel)
  // the package's own pins are RETIRED at promotion (listed in its PACKAGE.json); the promoted variant therefore does not run them
  // this bundle's own pins describe the UNAPPLIED state (the live registry holds none of the eight): they are retired at application and cannot run in the copy where the patch IS applied
  .filter((f) => !/audit-registration-bundle\.structural/.test(f))
  .filter((f) => base === 'registered' || !/promotion-package\.structural/.test(f))
  // the AL1 package's pins (newest live migration = the one before the D / Z1 / E1 promotion) describe the UNPROMOTED tree: they cannot hold in ANY copy where that promotion is applied,
  // hardened or not (they are retired at promotion). Found by running `registered+promoted`, which the first AL1 checkpoint had not re-run after adding the pin.
  .filter(
    (f) => !(base === 'registered+promoted' && /audit-log-hardening-package\.structural/.test(f)),
  )
  // the SE1 package's pins (newest live migration, unauthorised candidate) describe the UNPROMOTED tree: with the D / Z1 / E1 promotion in the copy they no longer do
  .filter(
    (f) =>
      !(base === 'registered+promoted' && /security-event-isolation-package\.structural/.test(f)),
  )
  // the Phase 4 × Inventory ordering test states the CONFLICT under the CURRENT names against the UNPROMOTED real migrations folder (it proves the locked checker flags step H once the stack is promoted):
  // with the stack promoted in the copy that premise no longer holds, so it is retired there like the package pins above
  .filter(
    (f) =>
      !(
        base === 'registered+promoted' && /phase4-inventory-migration-ordering\.structural/.test(f)
      ),
  )
  // the share-pack test counts the files that name the CURRENT migrations (the D-ORDER rename scope) in the UNPROMOTED tree; the promoted copy's pin patches add those names to more files
  .filter((f) => !(base === 'registered+promoted' && /security-review-share\.structural/.test(f)));
const targeted = [
  `${SIM_REL}/apps/api/src/modules/expenses/expense-audit.registered.rehearsal.integration.test.ts`,
  `${SIM_REL}/apps/api/src/modules/expenses/expense-audit.integration.test.ts`,
  `${SIM_REL}/apps/api/src/modules/expenses/expense-audit.test.ts`,
  `${SIM_REL}/apps/api/src/common/audit/actions.test.ts`,
].map((f) => f.replace(/^apps\/api\//, ''));
console.log(
  `running ${targeted.length} targeted + ${structural.length} structural files in the copy (${mode})…`,
);
const env = {
  ...process.env,
  ...(hardened ? { AUDIT_LOG_HARDENED: '1' } : {}),
  ...(process.env.AUDIT_EVIDENCE_OUT ? { AUDIT_EVIDENCE_OUT: process.env.AUDIT_EVIDENCE_OUT } : {}),
};
const run = sh('npx', ['vitest', 'run', ...targeted, ...structural], {
  cwd: path.join(ROOT, 'apps/api'),
  env,
});
const lines = run.out
  .split('\n')
  .filter((l) => /Test Files|Tests |×| FAIL |AssertionError/.test(l));
console.log(lines.join('\n') || run.out.slice(-2000));
if (!process.env.KEEP) rmSync(SIM, { recursive: true, force: true });
process.exit(run.status === 0 ? 0 : 1);
