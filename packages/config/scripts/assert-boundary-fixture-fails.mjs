#!/usr/bin/env node
/**
 * Negative test (Phase 0 Task 0.2 checklist item):
 * Runs ESLint on `fixtures/boundary-violation/` and asserts that BOTH
 *   - `boundaries/element-types`  (a pure package importing an app), and
 *   - `flower/no-scope-from-request` (reading tenantId from req.body)
 * produce errors. If lint comes back clean, the guardrails have no teeth → exit 1.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../fixtures/boundary-violation');

const eslint = new ESLint({
  cwd: fixtureDir,
  overrideConfigFile: path.join(fixtureDir, 'eslint.config.js'),
  errorOnUnmatchedPattern: true,
});

const results = await eslint.lintFiles(['src/**/*.ts']);
const ruleIds = new Set();
let errorCount = 0;
for (const r of results) {
  for (const m of r.messages) {
    if (m.severity === 2) errorCount++;
    if (m.ruleId) ruleIds.add(m.ruleId);
  }
}

const expected = ['boundaries/dependencies', 'flower/no-scope-from-request'];
const missing = expected.filter((id) => !ruleIds.has(id));

console.log(
  `fixture lint: ${errorCount} error(s); rules fired: ${[...ruleIds].join(', ') || '(none)'}`,
);

if (errorCount === 0 || missing.length > 0) {
  console.error(
    `NEGATIVE TEST FAILED — expected these rules to fire but they did not: ${missing.join(', ') || '(no errors at all)'}`,
  );
  process.exit(1);
}

console.log('NEGATIVE TEST PASSED — the deliberate boundary + scope violations were caught.');
