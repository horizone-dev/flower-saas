#!/usr/bin/env node
/**
 * PR-slice tool for the uncommitted worktree (docs/mvp/PR-BOUNDARY-PLAN.md). READ-ONLY on the repository: it never runs a git write, never commits,
 * never stages. It exists so that, once the owner authorises branches, the split is mechanical and was proven BEFORE any commit.
 *
 *   node infra/pr-slices/pr-slices.mjs classify            every uncommitted file -> exactly one slice (exit 1 if any is unclassified)
 *   node infra/pr-slices/pr-slices.mjs materialize <dir> <0|1a|1|8|9>   copy ONE slice onto a CLEAN checkout of origin/main in <dir> (a scratch worktree),
 *                                                          with the two hand-splits below; then run the repo gate there
 *
 * The two hand-splits (proved necessary, 2026-11-18):
 *  - `org.module.ts`: the final file also imports DevicesModule + CashRegisterModule (Phase 4). PR 1a ships a minimal module that registers only
 *    the F-3 receipt-identity route; the full file rides with PR 4.
 *  - `packages/api-client/src/index.ts`: the inventory-read methods/types ride with the Inventory hold (they import `Inventory*` types that exist
 *    only in the S-1-held shared-types change); PR 1 ships the file with those hunks removed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** first match wins — order matters (hold before the generic package/app rules) */
export const RULES = [
  ['hold: inventory (S-1)', /^apps\/api\/src\/modules\/stock\//],
  ['hold: inventory (S-1)', /^apps\/(owner-web|pos-pwa)\/src\/inventory\//],
  ['hold: inventory (S-1)', /^packages\/api-client\/src\/inventory-reads\.test\.ts$/],
  ['hold: inventory (S-1)', /^packages\/shared-types\/src\//],
  // 16 of the 34 S-1 manifest files are documents; they stay out of PR 0 (found 2026-11-18 while preparing the PRs)
  [
    'hold: inventory (S-1)',
    /^docs\/decisions\/proposed-migrations\/(DRAFT-(H|I|K|L|M|P|Q|QR|R)-|inventory-activation-manifest|inventory-reads\.module)/,
  ],
  [
    'hold: inventory (S-1)',
    /^docs\/mvp\/INVENTORY-(API-ACTIVATION-PACKAGE|APPROVAL-CHECKLIST|PERFORMANCE-CLOSURE)\.md$/,
  ],
  ['0 docs & decision packages', /^(docs\/|\.prettierignore$|\.gitleaks\.toml$)/],
  ['8 CI workflows', /^\.github\//],
  [
    '9 staging IaC + migration runner + operator bootstrap',
    /^infra\/(staging|migrate|pr-slices)\//,
  ],
  ['9 staging IaC + migration runner + operator bootstrap', /^apps\/api\/src\/tooling\//],
  ['3 Phase 4 database foundation', /^packages\/(db|permissions)\//],
  ['3 Phase 4 database foundation', /^apps\/api\/src\/modules\/platform\/system-roles\.ts$/],
  ['1 UI: api-client + POS + Owner Web + Customer Web', /^packages\/api-client\//],
  [
    '1 UI: api-client + POS + Owner Web + Customer Web',
    /^apps\/(customer-web|owner-web|pos-pwa)\//,
  ],
  [
    '1 UI: api-client + POS + Owner Web + Customer Web',
    /^(pnpm-lock\.yaml|turbo\.json|\.gitignore|infra\/docker\/web\.Dockerfile)$/,
  ],
  [
    '1a F-3 receipt identity + 3 real-API suites',
    /^apps\/api\/src\/modules\/org\/(receipt-identity|org\.module)/,
  ],
  [
    '1a F-3 receipt identity + 3 real-API suites',
    /^apps\/api\/src\/modules\/(sales\/pos-credit-advance|receivables\/(pos-customer-collection|owner-credit-management))/,
  ],
  ['2 staff onboarding service (inert)', /^apps\/api\/src\/modules\/access\//],
  [
    '4 device / session security',
    /^apps\/api\/src\/(modules\/(device-proof|devices|device-session|identity)|common\/(integrity|audit)|config\/env\.ts|main\.ts)/,
  ],
  [
    '5 cash register + expenses (inert routes)',
    /^apps\/api\/src\/modules\/(cash-register|expenses)\//,
  ],
  [
    '7 frozen Phase 3 pin amendments (owner approval)',
    /^apps\/api\/src\/modules\/(sales|orders|reporting)\/task-3b[^/]*structural\.test\.ts$/,
  ],
  ['6 verification pins (ride with the code they pin)', /^apps\/api\/src\/verification\//],
  [
    '6 verification pins (ride with the code they pin)',
    /^apps\/api\/src\/probes\/cross-tenant\.probe\.test\.ts$/,
  ], // hunk-split: F-3 -> 1a, devices -> 4, register -> 5
];

export function uncommitted() {
  const out = execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ st: l.slice(0, 2).trim(), path: l.slice(3).replace(/^"|"$/g, '') }));
}

export function classify(files = uncommitted()) {
  const slices = new Map();
  const unclassified = [];
  for (const f of files) {
    const r = RULES.find(([, re]) => re.test(f.path));
    if (!r) unclassified.push(f);
    else (slices.get(r[0]) ?? slices.set(r[0], []).get(r[0])).push(f);
  }
  return { slices, unclassified };
}

// ── api-client hand-split ────────────────────────────────────────────────────────────────────────────────────────────────────
export function stripInventoryFromApiClient(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s+type Inventory\w+,$/.test(l)) {
      i += 1;
      continue;
    }
    if (l === 'export type {' && /Inventory/.test(lines[i + 1] ?? '')) {
      while (!lines[i].startsWith("} from '@flower/shared-types';")) i += 1;
      i += 1;
      if (lines[i] === '') i += 1;
      continue;
    }
    if (l.startsWith('/** paging options of every inventory list read')) {
      while (lines[i] !== '}') i += 1;
      i += 1;
      if (lines[i] === '') i += 1;
      continue;
    }
    if (l.startsWith('  // ── inventory reads')) {
      while (!lines[i].startsWith('  // ── sessions')) i += 1;
      continue;
    }
    out.push(l);
    i += 1;
  }
  return out.join('\n');
}

/** ci.yml hand-split: the `schema-drift` job runs packages/db/test/schema-drift*.test.ts (PR 3 only) — it rides with PR 3, not PR 8. */
export function stripSchemaDriftJob(text) {
  const a = text.indexOf('  # ── Gate 1d: schema-drift verification');
  const b = text.indexOf('  # ── Gate 2: supply-chain');
  if (a < 0 || b < a) throw new Error('ci.yml schema-drift block not found');
  return text.slice(0, a) + text.slice(b);
}

/**
 * cross-tenant.probe.test.ts hand-split: PR 1a adds a route, and the probe suite fails the build for any route that is not probed. 1a therefore
 * ships the file with ONLY the F-3 hunks; the Phase 4 hunk (`/v1/devices`, `/v1/cash-register`) rides with PRs 4 / 5. (Found by CI on PR 43.)
 */
export function onlyF3FromProbe(text) {
  const a = '      // Phase 4 B5.3 — registered devices.';
  const endMark = "      '/v1/cash-register',\n";
  const i = text.indexOf(a);
  const j = text.indexOf(endMark, i);
  if (i < 0 || j < 0) throw new Error('cross-tenant probe Phase 4 hunk not found');
  return text.slice(0, i) + text.slice(j + endMark.length);
}

export const MINIMAL_ORG_MODULE = `import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { OrgRepository } from './org.repository.js';
import { OrgService } from './org.service.js';
import { OrgController } from './org.controller.js';
import { ReceiptIdentityRepository } from './receipt-identity.repository.js';
import { ReceiptIdentityController } from './receipt-identity.controller.js';

/**
 * \`org\` module (ARCHITECTURE §3): companies / trade licenses / branches / branch settings / POS terminals. PR 1a registers only the F-3
 * receipt-identity route here (the frozen \`app.module.ts\` is byte-locked); the Phase 4 module imports are added by the PRs that ship those modules.
 */
@Module({
  imports: [PlatformModule],
  providers: [OrgRepository, OrgService, ReceiptIdentityRepository],
  controllers: [OrgController, ReceiptIdentityController],
  exports: [OrgRepository],
})
export class OrgModule {}
`;

function materialize(dest, which) {
  if (!dest || !['0', '1a', '1', '8', '9'].includes(which ?? ''))
    throw new Error('usage: materialize <dir> <0|1a|1|8|9>');
  const { slices } = classify();
  const put = (rel, content) => {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
  };
  const copy = (rel) => put(rel, fs.readFileSync(path.join(root, rel)));
  const names = {
    0: ['0 docs & decision packages'],
    '1a': ['1a F-3 receipt identity + 3 real-API suites'],
    1: ['1 UI: api-client + POS + Owner Web + Customer Web'],
    8: ['8 CI workflows'],
    9: ['9 staging IaC + migration runner + operator bootstrap'],
  }[which];
  let n = 0;
  for (const name of names) {
    for (const f of slices.get(name) ?? []) {
      if (f.path === 'apps/api/src/modules/org/org.module.ts') put(f.path, MINIMAL_ORG_MODULE);
      else if (f.path === '.github/workflows/ci.yml')
        put(f.path, stripSchemaDriftJob(fs.readFileSync(path.join(root, f.path), 'utf8')));
      else if (f.path === 'packages/api-client/src/index.ts')
        put(f.path, stripInventoryFromApiClient(fs.readFileSync(path.join(root, f.path), 'utf8')));
      else copy(f.path);
      n += 1;
    }
  }
  if (which === '1a') {
    put(
      'apps/api/src/probes/cross-tenant.probe.test.ts',
      onlyF3FromProbe(
        fs.readFileSync(path.join(root, 'apps/api/src/probes/cross-tenant.probe.test.ts'), 'utf8'),
      ),
    );
    n += 1;
    copy('apps/api/src/verification/load-sale-world.ts'); // the test helper the three suites use (ships with the first slice that needs it)
    n += 1;
  }
  console.log(`materialized slice ${which}: ${n} files into ${dest}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'classify') {
  const { slices, unclassified } = classify();
  let total = 0;
  for (const [k, v] of [...slices].sort()) {
    total += v.length;
    console.log(
      `${k.padEnd(56)} ${String(v.length).padStart(4)} files (${v.filter((x) => x.st === 'M').length} modified)`,
    );
  }
  console.log(
    `${'TOTAL classified'.padEnd(56)} ${String(total).padStart(4)}   unclassified: ${unclassified.length}`,
  );
  for (const f of unclassified) console.log('  UNCLASSIFIED', f.st, f.path);
  process.exit(unclassified.length === 0 ? 0 : 1);
} else if (cmd === 'materialize') {
  materialize(args[0], args[1]);
} else if (cmd !== undefined) {
  console.error('usage: pr-slices.mjs classify | materialize <dir> <0|1a|1|8|9>');
  process.exit(2);
}
