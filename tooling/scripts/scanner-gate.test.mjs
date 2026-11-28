#!/usr/bin/env node
/**
 * Self-test for the CI security scanners' independence and for the final results gate.
 * Dependency-free (node:test only). Run: `node --test tooling/scripts/scanner-gate.test.mjs`.
 *
 * Two halves:
 *  1. scanner-gate.mjs itself: a scanner whose result is anything but exactly "success"
 *     (failed, skipped, cancelled, empty, missing, mis-cased) fails the gate, and so does a
 *     scan whose INPUTS are vacuous (the pinned OSV action exits 0 on "no package sources",
 *     Trivy exits 0 on an empty directory) even though every step reported success.
 *  2. The `security` job in .github/workflows/ci.yml: every scanner step runs whatever an
 *     earlier scanner did (so Trivy runs when OSV fails), none can hide a failure
 *     (no continue-on-error), the gate sees all of them, and the scanner versions,
 *     severities and the Trivy filesystem REPORT-ONLY policy are pinned so they cannot change
 *     silently.
 *
 * Overrides for mutation testing: SCANNER_GATE_SUT (the gate script), CI_WORKFLOW_SUT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GATE = process.env.SCANNER_GATE_SUT ?? path.join(HERE, 'scanner-gate.mjs');
const WORKFLOW = process.env.CI_WORKFLOW_SUT ?? path.join(ROOT, '.github', 'workflows', 'ci.yml');

// The six results the gate must see. `id` is the workflow step id, the gate reads SCAN_<ID>.
const SCANNERS = [
  { id: 'osv', label: 'OSV' },
  { id: 'gitleaks_selftest', label: 'Gitleaks self-test' },
  { id: 'gitleaks_scan', label: 'Gitleaks scan' },
  { id: 'trivy_config', label: 'Trivy config' },
  { id: 'trivy_fs', label: 'Trivy filesystem' },
  { id: 'scanner_selftest', label: 'scanner self-test' },
];
const envName = (id) => `SCAN_${id.toUpperCase()}`;

// ───────────────────────────── 1. the gate ─────────────────────────────

const VALID_LOCK = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '',
  'packages:',
  '',
  '  left-pad@1.3.0:',
  '    resolution: {integrity: sha512-x}',
  '',
  'snapshots:',
  '',
  '  left-pad@1.3.0: {}',
  '',
].join('\n');

/** A disposable workspace the gate is run in. `lock` / `dockerfile` may be null (absent). */
function workspace({ lock = VALID_LOCK, dockerfile = 'FROM node:24\n', dockerDir = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'scanner-gate-'));
  if (lock !== null) writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock);
  if (dockerDir) mkdirSync(path.join(dir, 'infra', 'docker'), { recursive: true });
  if (dockerDir && dockerfile !== null) {
    writeFileSync(path.join(dir, 'infra', 'docker', 'app.Dockerfile'), dockerfile);
  }
  return dir;
}

function cleanup(dir) {
  // only ever remove a directory this file created
  if (path.dirname(dir) === tmpdir() && path.basename(dir).startsWith('scanner-gate-')) {
    rmSync(dir, { recursive: true, force: true });
  }
}

const allSuccess = () => Object.fromEntries(SCANNERS.map((s) => [envName(s.id), 'success']));

function gate(env, wsOptions, extraEnv = {}) {
  const dir = workspace(wsOptions);
  try {
    const r = spawnSync(process.execPath, [GATE], {
      cwd: dir,
      env: { PATH: process.env.PATH, ...env, ...extraEnv },
      encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, dir };
  } finally {
    cleanup(dir);
  }
}

test('gate: every scanner succeeded and the inputs are real -> exit 0 and an OK verdict', () => {
  const r = gate(allSuccess());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /scanner-gate: OK/);
  for (const s of SCANNERS) assert.ok(r.out.includes(s.id), `${s.id} is listed in the verdict`);
  assert.doesNotMatch(r.out, /FAIL/);
});

// Anything that is not exactly "success" must fail, and the reason must name the scanner.
const BAD_OUTCOMES = [
  ['failure', /failed/],
  ['skipped', /did not run/],
  ['cancelled', /cancelled/],
  ['', /no result/],
  [undefined, /no result/],
  ['Success', /unrecognised/],
  ['success ', /unrecognised/],
  [' success', /unrecognised/],
  ['success\n', /unrecognised/],
  ['neutral', /unrecognised/],
  ['true', /unrecognised/],
];

for (const s of SCANNERS) {
  for (const [value, reason] of BAD_OUTCOMES) {
    test(`gate: ${s.id} outcome ${JSON.stringify(value)} fails closed (exit 1, never OK)`, () => {
      const env = allSuccess();
      if (value === undefined) delete env[envName(s.id)];
      else env[envName(s.id)] = value;
      const r = gate(env);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /scanner-gate: FAIL/);
      assert.doesNotMatch(r.out, /scanner-gate: OK/);
      assert.match(
        r.out,
        new RegExp(`scanner-gate: FAIL: ${s.id}: `),
        `a FAIL line names ${s.id}\n${r.out}`,
      );
      assert.match(r.out, reason, r.out);
    });
  }
}

test('gate: several scanners failing at once are ALL named, not just the first', () => {
  const env = allSuccess();
  env[envName('osv')] = 'failure';
  env[envName('trivy_config')] = 'skipped';
  env[envName('gitleaks_scan')] = '';
  const r = gate(env);
  assert.equal(r.code, 1, r.out);
  // the status table lists every scanner, so only a FAIL line proves a failure was reported
  for (const id of ['osv', 'trivy_config', 'gitleaks_scan']) {
    assert.match(
      r.out,
      new RegExp(`scanner-gate: FAIL: ${id}: `),
      `${id} must have its own FAIL line\n${r.out}`,
    );
  }
  // the three that succeeded are not blamed
  for (const id of ['trivy_fs', 'gitleaks_selftest', 'scanner_selftest']) {
    assert.doesNotMatch(r.out, new RegExp(`FAIL[^\\n]*\\b${id}\\b`), r.out);
  }
  assert.match(r.out, /3 problem\(s\)/, r.out);
});

test('gate: OSV failing does not stop the gate from judging Trivy (each result is read on its own)', () => {
  const env = allSuccess();
  env[envName('osv')] = 'failure';
  const r = gate(env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /trivy_config[^\n]*success/, r.out);
  assert.match(r.out, /trivy_fs[^\n]*success/, r.out);
});

// Vacuous inputs: every step says "success", the gate must still refuse.
const VACUOUS = [
  ['pnpm-lock.yaml is missing', { lock: null }, /pnpm-lock\.yaml/],
  ['pnpm-lock.yaml is 0 bytes', { lock: '' }, /pnpm-lock\.yaml/],
  [
    'pnpm-lock.yaml has no lockfileVersion header',
    { lock: 'packages:\n  a@1:\n' },
    /lockfileVersion/,
  ],
  [
    'pnpm-lock.yaml has a header but no package entries',
    { lock: "lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n" },
    /package entries/,
  ],
  ['infra/docker is missing', { dockerDir: false }, /infra\/docker/],
  ['infra/docker has no Dockerfile', { dockerfile: null }, /Dockerfile/],
  ['the only Dockerfile is empty', { dockerfile: '' }, /Dockerfile/],
];

for (const [name, ws, reason] of VACUOUS) {
  test(`gate: every scanner reports success but ${name} -> exit 1 (an empty scan is not a pass)`, () => {
    const r = gate(allSuccess(), ws);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /scanner-gate: FAIL/);
    assert.doesNotMatch(r.out, /scanner-gate: OK/);
    assert.match(r.out, reason, r.out);
  });
}

test('gate: writes a per-scanner table to GITHUB_STEP_SUMMARY, FAIL included', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scanner-gate-'));
  const summary = path.join(dir, 'summary.md');
  writeFileSync(summary, '');
  try {
    const env = allSuccess();
    env[envName('trivy_fs')] = 'skipped';
    const r = gate(env, {}, { GITHUB_STEP_SUMMARY: summary });
    assert.equal(r.code, 1, r.out);
    const text = readFileSync(summary, 'utf8');
    for (const s of SCANNERS) assert.ok(text.includes(s.id), `${s.id} is in the summary`);
    assert.match(text, /trivy_fs[^\n]*skipped/);
    assert.match(text, /FAIL/);
  } finally {
    cleanup(dir);
  }
});

// ─────────────────────── 2. the workflow wiring ───────────────────────

const stripComment = (v) => v.replace(/\s+#.*$/, '').trim();
const unquote = (v) => v.replace(/^(['"])(.*)\1$/, '$2');

/** A deliberately small parser for the regular shape of the `security` job; it fails loudly if the shape changes. */
function loadSecurityJob(file) {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l === '  security:');
  assert.ok(start >= 0, 'the `security` job was not found in the workflow');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const job = lines.slice(start + 1, end);
  const stepsAt = job.findIndex((l) => l === '    steps:');
  assert.ok(stepsAt >= 0, 'the `steps:` list of the security job was not found');
  const blocks = [];
  for (const l of job.slice(stepsAt + 1)) {
    if (/^ {6}- /.test(l)) blocks.push([`        ${l.slice(8)}`]);
    else if (blocks.length) blocks[blocks.length - 1].push(l);
  }
  const steps = blocks.map((block) => {
    const props = {};
    let key = null;
    for (const l of block) {
      const m = /^ {8}([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(l);
      if (m) {
        key = m[1];
        props[key] = { inline: stripComment(m[2] ?? ''), children: [] };
      } else if (key && /^ {9,}\S/.test(l)) {
        props[key].children.push(l);
      }
    }
    const sub = (name, indent) => {
      const out = {};
      let k = null;
      for (const l of props[name]?.children ?? []) {
        const m = new RegExp(`^ {${indent}}([\\w-]+):(?:\\s+(.*))?$`).exec(l);
        if (m) {
          k = m[1];
          const inline = unquote(stripComment(m[2] ?? ''));
          out[k] = /^[|>][-+]?$/.test(inline) ? '' : inline; // a block scalar's value is its child lines
        } else if (k) {
          out[k] = `${out[k]}\n${l.trim()}`.trim();
        }
      }
      return out;
    };
    const ifRaw = props.if?.inline;
    return {
      name: unquote(props.name?.inline ?? ''),
      id: props.id?.inline,
      uses: props.uses?.inline ?? '',
      run: [props.run?.inline ?? '', ...(props.run?.children ?? []).map((c) => c.trim())]
        .filter((x) => x && !/^[|>][-+]?$/.test(x))
        .join('\n'),
      ifExpr: ifRaw === undefined ? undefined : ifRaw.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim(),
      props,
      with: sub('with', 10),
      env: sub('env', 10),
    };
  });
  return { steps, text: job.join('\n') };
}

const { steps: STEPS, text: JOB_TEXT } = loadSecurityJob(WORKFLOW);

const MATCHERS = {
  osv: (s) => /osv-scanner-action/.test(s.uses),
  gitleaks_selftest: (s) => /gitleaks-scan\.test\.sh/.test(s.run),
  gitleaks_scan: (s) => /gitleaks-scan\.sh/.test(s.run),
  trivy_config: (s) => /trivy-action/.test(s.uses) && s.with['scan-type'] === 'config',
  trivy_fs: (s) => /trivy-action/.test(s.uses) && s.with['scan-type'] === 'fs',
  scanner_selftest: (s) => /scanner-gate\.test\.mjs/.test(s.run),
};
const isGate = (s) => /scanner-gate\.mjs/.test(s.run);
const isScannerLike = (s) =>
  /osv-scanner-action|trivy-action/.test(s.uses) ||
  /gitleaks-scan(\.test)?\.sh|scanner-gate\.test\.mjs/.test(s.run);
const byId = (id) => {
  const hits = STEPS.filter(MATCHERS[id]);
  assert.equal(
    hits.length,
    1,
    `exactly one security step must be the ${id} step, found ${hits.length}`,
  );
  return hits[0];
};

// GitHub's documented step-status rules; an unknown expression is a test failure, never a guess.
function decide(expr, st) {
  switch (expr === undefined ? 'success()' : expr) {
    case 'success()':
      return !st.failed && !st.cancelled;
    case '!cancelled()':
      return !st.cancelled;
    case 'always()':
      return true;
    case 'failure()':
      return st.failed && !st.cancelled;
    case 'cancelled()':
      return st.cancelled;
    default:
      throw new Error(`unsupported condition "${expr}": extend the model deliberately`);
  }
}

/** Run the job's steps in order; step `failAt` fails if it runs; `cancelFrom` cancels the run from that step on. */
function simulate(steps, { failAt = null, cancelFrom = null } = {}) {
  const st = { failed: false, cancelled: false };
  const ran = steps.map((s, i) => {
    if (cancelFrom !== null && i >= cancelFrom) st.cancelled = true;
    const runs = decide(s.ifExpr, st);
    if (runs && i === failAt) st.failed = true;
    return runs;
  });
  return { ran, result: st.cancelled ? 'cancelled' : st.failed ? 'failure' : 'success' };
}

test('workflow: the parser really found the security job (guards against a vacuous pass)', () => {
  assert.ok(STEPS.length >= 11, `expected at least 11 steps, parsed ${STEPS.length}`);
  assert.ok(
    STEPS.some((s) => /actions\/checkout/.test(s.uses)),
    'checkout step not parsed',
  );
  assert.ok(
    STEPS.some((s) => /pnpm install/.test(s.run)),
    'install step not parsed',
  );
});

test('model: a step with no `if` is skipped after an earlier failure (the defect this guards against)', () => {
  assert.equal(decide(undefined, { failed: true, cancelled: false }), false);
  assert.equal(decide('success()', { failed: true, cancelled: false }), false);
  assert.equal(decide('!cancelled()', { failed: true, cancelled: false }), true);
});

test('model: an unsupported condition is rejected rather than guessed', () => {
  assert.throws(() =>
    decide("steps.osv.outcome == 'success'", { failed: false, cancelled: false }),
  );
});

for (const s of SCANNERS) {
  test(`workflow: ${s.id} is exactly one step with id "${s.id}"`, () => {
    assert.equal(byId(s.id).id, s.id);
  });

  test(`workflow: ${s.id} runs whatever an earlier step did (condition is !cancelled() or always())`, () => {
    const step = byId(s.id);
    assert.ok(
      step.ifExpr === '!cancelled()' || step.ifExpr === 'always()',
      `${s.id} has condition ${JSON.stringify(step.ifExpr)}; the default skips it after any earlier failure`,
    );
  });
}

test('workflow: no scanner-like step exists outside the six that the gate reads', () => {
  const known = new Set(SCANNERS.map((s) => byId(s.id)));
  const strays = STEPS.filter((s) => isScannerLike(s) && !known.has(s)).map((s) => s.name);
  assert.deepEqual(
    strays,
    [],
    'a scanner step the gate does not read would be able to fail silently',
  );
});

test('workflow: nothing in the security job can hide a failure (no continue-on-error anywhere)', () => {
  assert.doesNotMatch(JOB_TEXT, /continue-on-error/);
});

test('workflow: no scanner condition depends on another step or job result', () => {
  for (const s of SCANNERS) {
    assert.doesNotMatch(byId(s.id).ifExpr ?? '', /steps\.|needs\.|success\(\)|failure\(\)/, s.id);
  }
});

test('workflow: the gate is the LAST step, always runs, and receives every result exactly', () => {
  const gates = STEPS.filter(isGate);
  assert.equal(gates.length, 1, 'exactly one step must run scanner-gate.mjs');
  const g = gates[0];
  assert.equal(STEPS.at(-1), g, 'the gate must be the last step (it judges everything before it)');
  assert.ok(g.ifExpr === '!cancelled()' || g.ifExpr === 'always()', `gate condition ${g.ifExpr}`);
  assert.deepEqual(
    Object.keys(g.env).sort(),
    SCANNERS.map((s) => envName(s.id)).sort(),
    'the gate step must pass exactly the six results',
  );
  for (const s of SCANNERS) {
    assert.equal(g.env[envName(s.id)], `\${{ steps.${s.id}.outcome }}`, `${envName(s.id)} wiring`);
  }
});

test('workflow: the scanner self-test runs before the gate', () => {
  assert.ok(STEPS.indexOf(byId('scanner_selftest')) < STEPS.indexOf(STEPS.find(isGate)));
});

test('model: Trivy (both scans) and the gate run when OSV fails; the job is red, never green', () => {
  const osvAt = STEPS.indexOf(byId('osv'));
  const { ran, result } = simulate(STEPS, { failAt: osvAt });
  for (const id of ['trivy_config', 'trivy_fs', 'gitleaks_selftest', 'gitleaks_scan']) {
    assert.equal(ran[STEPS.indexOf(byId(id))], true, `${id} must run after OSV fails`);
  }
  assert.equal(ran[STEPS.indexOf(STEPS.find(isGate))], true, 'the gate must run after OSV fails');
  assert.equal(result, 'failure');
});

test('model: any single failing step (setup, install, SBOM, any scanner) leaves every other scanner and the gate running', () => {
  const gateAt = STEPS.indexOf(STEPS.find(isGate));
  const mustRun = [...SCANNERS.map((s) => STEPS.indexOf(byId(s.id))), gateAt];
  STEPS.forEach((step, failAt) => {
    const { ran, result } = simulate(STEPS, { failAt });
    for (const at of mustRun) {
      if (at === failAt) continue;
      assert.equal(ran[at], true, `"${STEPS[at].name}" must still run when "${step.name}" fails`);
    }
    assert.equal(result, 'failure', `a failure in "${step.name}" must make the job red`);
  });
});

test('model: a cancelled run is never reported as success', () => {
  const { result } = simulate(STEPS, { cancelFrom: STEPS.indexOf(byId('osv')) });
  assert.equal(result, 'cancelled');
});

// Scanner versions, configuration and thresholds are pinned so they cannot move silently.
test('pins: OSV action version and arguments are unchanged', () => {
  const s = byId('osv');
  assert.equal(s.uses, 'google/osv-scanner-action/osv-scanner-action@v2.5.1');
  assert.deepEqual(
    s.with['scan-args']
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    ['--lockfile=pnpm-lock.yaml', '--recursive'],
  );
});

test('pins: Trivy config scan keeps its version, target, severity threshold and BLOCKING exit code', () => {
  const s = byId('trivy_config');
  assert.equal(s.uses, 'aquasecurity/trivy-action@v0.36.0');
  assert.deepEqual(s.with, {
    'scan-type': 'config',
    'scan-ref': 'infra/docker',
    severity: 'HIGH,CRITICAL',
    'exit-code': '1',
  });
});

test('pins: Trivy filesystem scan keeps its version, severity and its REPORT-ONLY policy', () => {
  const s = byId('trivy_fs');
  assert.equal(s.uses, 'aquasecurity/trivy-action@v0.36.0');
  assert.deepEqual(
    s.with,
    {
      'scan-type': 'fs',
      'scan-ref': '.',
      severity: 'HIGH,CRITICAL',
      'ignore-unfixed': 'true',
      'exit-code': '0',
    },
    'the Trivy filesystem policy is report-only (exit-code 0) by an owner decision; changing it is a deliberate decision, update this test with it',
  );
});

test('pins: the Gitleaks steps still call the explicit-range gate and its self-test', () => {
  assert.match(byId('gitleaks_scan').run, /^bash tooling\/scripts\/gitleaks-scan\.sh$/m);
  assert.match(byId('gitleaks_selftest').run, /^bash tooling\/scripts\/gitleaks-scan\.test\.sh$/m);
});
