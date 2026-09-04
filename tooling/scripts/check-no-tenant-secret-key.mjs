#!/usr/bin/env node
/**
 * CI `security` gate (PHASE-1-PLAN §1.15): the tenant realm must never gain a
 * permission key that manages an external secret. Secret custody is Platform
 * Super Admin only (CLAUDE.md rule 26) — the ONLY key is `platform:secrets:manage`.
 *
 * Fails if:
 *   - any key in `@flower/permissions` ALL_PERMISSIONS (the tenant catalogue)
 *     matches /secret/i, or
 *   - any `@RequirePermission('…secret…')` in an api controller uses a key other
 *     than `platform:secrets:manage`.
 *
 * Exit non-zero on any violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALL_PERMISSIONS, PLATFORM_PERMISSIONS } from '@flower/permissions';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const violations = [];

// 1 — the tenant catalogue
for (const key of ALL_PERMISSIONS) {
  if (/secret/i.test(key)) violations.push(`tenant permission key "${key}" matches /secret/i`);
}
const platformSecretKeys = PLATFORM_PERMISSIONS.filter((k) => /secret/i.test(k));
if (platformSecretKeys.length !== 1 || platformSecretKeys[0] !== 'platform:secrets:manage') {
  violations.push(
    `expected exactly [platform:secrets:manage], got [${platformSecretKeys.join(', ')}]`,
  );
}

// 2 — controller route declarations
const apiSrc = path.join(repoRoot, 'apps/api/src');
const RE = /@RequirePermission\(\s*['"]([^'"]*secret[^'"]*)['"]\s*\)/gi;
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
    for (const m of readFileSync(full, 'utf8').matchAll(RE)) {
      if (m[1] !== 'platform:secrets:manage') {
        violations.push(`${path.relative(repoRoot, full)}: @RequirePermission('${m[1]}')`);
      }
    }
  }
}
walk(apiSrc);

if (violations.length > 0) {
  console.error('check-no-tenant-secret-key FAIL:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(
  `check-no-tenant-secret-key OK — ${ALL_PERMISSIONS.length} tenant keys, secret custody is platform-only`,
);
