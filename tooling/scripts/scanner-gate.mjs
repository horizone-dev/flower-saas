#!/usr/bin/env node
/**
 * CI `security` job, last step: the scanner results gate. It fails closed.
 *
 * Why it exists. The scanners run as independent steps (each `if: !cancelled()`), so a red
 * dependency scan no longer leaves Trivy or Gitleaks skipped. Two things could still be reported
 * as success that must not be:
 *   1. A scanner that did not run, or whose result is missing. A skipped step leaves the job
 *      green. This gate requires every scanner's step outcome to be exactly "success"; skipped,
 *      cancelled, empty, absent (step removed or id renamed) and anything else fail it.
 *   2. A scanner that ran over NOTHING. The pinned osv-scanner action (v2.5.1) rewrites osv-scanner's
 *      exit code 128 ("no package sources found") to 0, with no switch to turn that off, and Trivy
 *      exits 0 on an empty directory ("Supported files for scanner(s) not found"). So the inputs the
 *      scanners read must be real: a non-empty pnpm lockfile with package entries, and at least one
 *      non-empty Dockerfile under infra/docker.
 * Trivy filesystem findings stay REPORT-ONLY by policy (`exit-code: '0'` in ci.yml); this gate does
 * not change that. It only requires that the scan ran, succeeded and had something to scan.
 *
 * Input: one env var per scanner, `SCAN_<STEP_ID>` = `${{ steps.<id>.outcome }}`. Run from the
 * repository root. Exit 0 only if every check passes, otherwise 1. Writes a table to
 * $GITHUB_STEP_SUMMARY when set. Self-test: tooling/scripts/scanner-gate.test.mjs.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SCANNERS = [
  ['osv', 'OSV dependency scan'],
  ['gitleaks_selftest', 'Gitleaks gate self-test'],
  ['gitleaks_scan', 'Gitleaks scan (explicit commit range)'],
  ['trivy_config', 'Trivy Dockerfile misconfiguration'],
  ['trivy_fs', 'Trivy filesystem (findings are report-only by policy)'],
  ['scanner_selftest', 'scanner gate self-test'],
];

const LOCKFILE = 'pnpm-lock.yaml';
const DOCKER_DIR = path.join('infra', 'docker');

const problems = [];
const rows = [];

// 1 — every scanner's own result, read independently
for (const [id, label] of SCANNERS) {
  const value = process.env[`SCAN_${id.toUpperCase()}`];
  let verdict; // null = this scanner passed, otherwise the reason it did not
  if (value === 'success') verdict = null;
  else if (value === 'failure') verdict = 'failed (its own step log says why)';
  else if (value === 'skipped') verdict = 'did not run: a skipped scanner is not a pass';
  else if (value === 'cancelled') verdict = 'was cancelled: a cancelled scanner is not a pass';
  else if (value === undefined || value === '') {
    verdict = 'no result recorded (the step id is missing or the step was removed)';
  } else verdict = `unrecognised outcome ${JSON.stringify(value)} (only exactly "success" passes)`;
  rows.push({
    id,
    label,
    outcome: value === undefined || value === '' ? '(none)' : value,
    verdict,
  });
  if (verdict) problems.push(`${id}: ${verdict}`);
}

// 2 — the inputs the scanners read must not be vacuous
function checkLockfile() {
  if (!existsSync(LOCKFILE)) {
    return `${LOCKFILE} is missing: OSV and Trivy would scan nothing and still exit 0`;
  }
  const text = readFileSync(LOCKFILE, 'utf8');
  if (statSync(LOCKFILE).size === 0 || text.trim() === '') return `${LOCKFILE} is empty`;
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  if (!/^lockfileVersion:/.test(first)) {
    return `${LOCKFILE} does not start with a lockfileVersion header (not a pnpm lockfile)`;
  }
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^packages:\s*$/.test(l));
  let entries = 0;
  if (at >= 0) {
    for (const l of lines.slice(at + 1)) {
      if (/^\S/.test(l)) break;
      if (/^ {2}\S.*:\s*$/.test(l)) entries += 1;
    }
  }
  if (entries === 0) return `${LOCKFILE} has no package entries: nothing for OSV or Trivy to check`;
  return { entries };
}

function checkDockerfiles() {
  if (!existsSync(DOCKER_DIR)) {
    return `${DOCKER_DIR.replace(/\\/g, '/')} is missing: Trivy config would scan nothing and still exit 0`;
  }
  const found = readdirSync(DOCKER_DIR).filter(
    (f) =>
      /dockerfile/i.test(f) &&
      statSync(path.join(DOCKER_DIR, f)).isFile() &&
      statSync(path.join(DOCKER_DIR, f)).size > 0,
  );
  if (found.length === 0) {
    return `${DOCKER_DIR.replace(/\\/g, '/')} holds no non-empty Dockerfile: Trivy config would scan nothing`;
  }
  return { files: found };
}

const lock = checkLockfile();
const docker = checkDockerfiles();
const inputNotes = [];
if (typeof lock === 'string') problems.push(`input: ${lock}`);
else inputNotes.push(`${LOCKFILE}: ${lock.entries} package entries`);
if (typeof docker === 'string') problems.push(`input: ${docker}`);
else
  inputNotes.push(
    `infra/docker: ${docker.files.length} Dockerfile(s) (${docker.files.join(', ')})`,
  );

// report
const out = [];
out.push('scanner-gate: results of every scanner step in this job');
for (const r of rows) out.push(`scanner-gate:   ${r.id.padEnd(18)} ${r.outcome}`);
for (const n of inputNotes) out.push(`scanner-gate:   input ${n}`);
if (problems.length === 0) {
  out.push(
    `scanner-gate: OK: all ${SCANNERS.length} scanner steps succeeded and their inputs are non-empty`,
  );
} else {
  for (const p of problems) out.push(`scanner-gate: FAIL: ${p}`);
  out.push(
    `scanner-gate: FAIL: ${problems.length} problem(s): the job fails. A scanner that did not run, did not succeed, or had nothing to scan is not a pass.`,
  );
}
console.log(out.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    '### Security scanner results',
    '',
    '| scanner | step id | outcome | verdict |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.label} | \`${r.id}\` | ${r.outcome} | ${r.verdict ? `FAIL: ${r.verdict}` : 'ok'} |`,
    ),
    '',
    ...inputNotes.map((n) => `- input ${n}`),
    ...problems.filter((p) => p.startsWith('input:')).map((p) => `- FAIL: ${p}`),
    '',
    problems.length === 0 ? '**Gate: OK**' : `**Gate: FAIL** (${problems.length} problem(s))`,
    '',
  ].join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

process.exitCode = problems.length === 0 ? 0 : 1;
