// REGENERATES pin-amendments.patch of this package (node make-pin-amendments.mjs, after the SE1 DB test has written PACKAGE.json with UPDATE_SE1_PACKAGE=1). Authors docs/decisions/promotion-packages/phase-4-security-event-isolation/pin-amendments.patch — STACKED after the D/Z1/E1 promotion pin patch and the AL1 pin patch.
// No full-tree copy: a MINI tree holds only the files those two patches touch (taken from the real tree), the two patches are applied to it in order (= the pre-image the SE1 patch must apply to),
// the SE1 edits are made on a second copy of those files, and the SE1 patch is the unified diff between the two. The real tree is only read.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PKGS = 'docs/decisions/promotion-packages';
const DZE = `${PKGS}/phase-4-d-z1-e1/pin-amendments.patch`;
const AL1P = `${PKGS}/phase-4-audit-log-immutability/pin-amendments.patch`;
const SE1PKG = `${PKGS}/phase-4-security-event-isolation`;
const OUT = `${ROOT}/${SE1PKG}/pin-amendments.patch`;
const lf = (s) => s.replace(/\r\n/g, '\n');
const manifest = JSON.parse(readFileSync(`${ROOT}/${SE1PKG}/PACKAGE.json`, 'utf8'));
const AL1 = JSON.parse(
  readFileSync(`${ROOT}/${PKGS}/phase-4-audit-log-immutability/PACKAGE.json`, 'utf8'),
);
const AL_NAME = AL1.candidate.name;
const SE_NAME = manifest.candidate.name;
const SE_SHA = manifest.candidate.sha256;
if (!SE_SHA)
  throw new Error(
    'manifest has no candidate sha256 — run the SE1 DB test with UPDATE_SE1_PACKAGE=1 first',
  );

const filesOf = (p) =>
  [...lf(readFileSync(`${ROOT}/${p}`, 'utf8')).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
const touched = [...new Set([...filesOf(DZE), ...filesOf(AL1P)])];
const work = mkdtempSync(path.join(tmpdir(), 'se1pins-'));
const base = path.join(work, 'base');
const sim = path.join(work, 'sim');
for (const f of touched) {
  for (const d of [base]) {
    mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    copyFileSync(`${ROOT}/${f}`, path.join(d, f));
  }
}
const apply = (dir, patch) => {
  const r = spawnSync('git', ['apply', '--whitespace=nowarn', `${ROOT}/${patch}`], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`apply ${patch} failed: ${r.stderr}`);
};
apply(base, DZE);
apply(base, AL1P);
// sim = base + the SE1 edits
const copyDir = (s, d) => {
  mkdirSync(d, { recursive: true });
  for (const e of readdirSync(s, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(s, e.name), path.join(d, e.name));
    else copyFileSync(path.join(s, e.name), path.join(d, e.name));
  }
};
copyDir(base, sim);
let edits = 0;
const edit = (rel, fn) => {
  const p = path.join(sim, rel);
  const t = lf(readFileSync(p, 'utf8'));
  const out = fn(t);
  if (out === t) throw new Error(`NO CHANGE in ${rel}`);
  writeFileSync(p, out);
  edits++;
};
// 1) frozen-baseline.ts: authorise the SE1 migration (name + reviewed content hash); NO model (no schema change)
edit('apps/api/src/verification/frozen-baseline.ts', (t) => {
  const anchor = `      name: '${AL_NAME}',`;
  const i = t.indexOf(anchor);
  if (i < 0) throw new Error('AL1 entry not found');
  const end = t.indexOf('    }),\n', i) + '    }),\n'.length;
  return (
    t.slice(0, end) +
    '    // Phase 4 SECURITY_EVENT ISOLATION (package phase-4-security-event-isolation, approvals recorded in its PACKAGE.json): security_invoker + the platform-only ACL on the security_event view. NO schema change, NO model.\n' +
    `    Object.freeze({\n      name: '${SE_NAME}',\n      sha256: '${SE_SHA}',\n    }),\n` +
    t.slice(end)
  );
});
// 2) every expected LIST whose last entry is the AL1 migration also lists the SE1 one: the authorised-migrations list AND the cash-register "migrations after B5.3" list (the full-stack rehearsal
//    caught the second one when only the first was handled)
const V = 'apps/api/src/verification/';
const listEnd = `      '${AL_NAME}',\n    ]);`;
const listFiles = [];
for (const f of readdirSync(path.join(sim, V)).filter((x) => /\.structural\.test\.ts$/.test(x))) {
  const p = path.join(sim, V, f);
  const t = lf(readFileSync(p, 'utf8'));
  if (!t.includes(listEnd)) continue;
  const out = t
    .split(listEnd)
    .join(`      '${AL_NAME}',\n      '${SE_NAME}',\n    ]);`)
    .replace(
      ') and the AL1 audit_log hardening — none names',
      '), the AL1 audit_log hardening and the SE1 security_event isolation — none names',
    );
  writeFileSync(p, out);
  listFiles.push(f);
  edits++;
}
if (
  !listFiles.includes('frozen-baseline.structural.test.ts') ||
  !listFiles.includes('cash-register.structural.test.ts')
)
  throw new Error(`expected the authorised list and the cash-register list; edited: ${listFiles}`);
// 3) every pin that names the newest migration now names the SE1 one
let pins = 0;
for (const f of readdirSync(path.join(sim, V)).filter((x) => /\.structural\.test\.ts$/.test(x))) {
  const p = path.join(sim, V, f);
  const t = lf(readFileSync(p, 'utf8'));
  const out = t
    .split(`expect(dirs.sort().at(-1)).toBe('${AL_NAME}');`)
    .join(`expect(dirs.sort().at(-1)).toBe('${SE_NAME}');`)
    .split(`expect(newest).toBe('${AL_NAME}');`)
    .join(`expect(newest).toBe('${SE_NAME}');`);
  if (out !== t) {
    writeFileSync(p, out);
    pins++;
  }
}
// the pins moved must be exactly the ones AL1 moved (the same files)
const al1Pins = [
  ...lf(readFileSync(`${ROOT}/${AL1P}`, 'utf8')).matchAll(
    /^\+\+\+ b\/(apps\/api\/src\/verification\/[^\n]+structural\.test\.ts)$/gm,
  ),
].map((m) => m[1]);
console.log(
  'files AL1 amended:',
  al1Pins.length,
  '| SE1 moves newest-migration pins in',
  pins,
  'files',
);
// 4) the diff (unified, a/ b/ labels relative to the repo root) of exactly the changed files
const changed = [];
const walkDiff = (rel) => {
  const a = path.join(base, rel),
    b = path.join(sim, rel);
  const ta = lf(readFileSync(a, 'utf8')),
    tb = lf(readFileSync(b, 'utf8'));
  if (ta !== tb) changed.push(rel);
};
for (const f of touched) walkDiff(f);
// CROSS-CHECK: SE1 stacks on AL1 and must move exactly the verification files AL1 moved — a file AL1 amended that SE1 did not (or the reverse) is a missed pin
const al1Verification = new Set(
  filesOf(AL1P).filter((f) => f.startsWith('apps/api/src/verification/')),
);
const se1Verification = new Set(changed);
for (const f of al1Verification)
  if (!se1Verification.has(f))
    throw new Error(`AL1 amended ${f} but SE1 did not: a pin was missed`);
for (const f of se1Verification)
  if (!al1Verification.has(f))
    throw new Error(`SE1 amended ${f} which AL1 did not: unexpected, review it`);
let patch = '';
const lfDir = path.join(work, 'lf');
for (const rel of changed.sort()) {
  // BOTH sides are diffed as LF text: the working tree may hold CRLF files while an edited copy is written as LF, which would otherwise turn a one-line change into a whole-file rewrite
  const a = path.join(lfDir, 'a', rel);
  const b = path.join(lfDir, 'b', rel);
  mkdirSync(path.dirname(a), { recursive: true });
  mkdirSync(path.dirname(b), { recursive: true });
  writeFileSync(a, lf(readFileSync(path.join(base, rel), 'utf8')));
  writeFileSync(b, lf(readFileSync(path.join(sim, rel), 'utf8')));
  const r = spawnSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, a, b], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (r.status !== 1) throw new Error(`diff ${rel} status ${r.status}`);
  patch += r.stdout;
}
const header =
  `# SE1 PIN AMENDMENTS — STACKED after the D / Z1 / E1 promotion pin patch (phase-4-d-z1-e1/pin-amendments.patch) AND the AL1 pin patch (phase-4-audit-log-immutability/pin-amendments.patch). UNAPPLIED.\n` +
  `# Authorises the SE1 candidate migration ${SE_NAME} (sha256 ${SE_SHA}) in frozen-baseline.ts and moves every "newest migration" pin to it. NO schema change, NO model, NO frozen contract edited.\n` +
  `# Apply order at promotion: D/Z1/E1 migrations + patch -> AL1 candidate + patch -> THIS candidate + patch. Regenerate with the SE1 package script if the draft changes.\n`;
writeFileSync(OUT, header + patch);
rmSync(work, { recursive: true, force: true });
console.log(`patch written: ${changed.length} files, ${edits} edit operations ->`, OUT);
console.log(changed.join('\n'));
