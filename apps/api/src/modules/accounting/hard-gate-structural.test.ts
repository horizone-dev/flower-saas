import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Task 3b.1 hard-gate matrix — structural/source-level proofs that need no
 * database (fast, no Testcontainers stack). Complements the DB-backed proofs
 * in `packages/db/test/accounting-schema.integration.test.ts` and the
 * service-level proofs in `hard-gate-matrix.integration.test.ts`.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function readAllTsSource(): string {
  const files = readdirSync(moduleDir, { recursive: true, encoding: 'utf8' });
  return files
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => readFileSync(path.join(moduleDir, f), 'utf8'))
    .join('\n');
}

describe('Task 3b.1 hard-gate matrix — structural proofs', () => {
  const controllerSource = readFileSync(path.join(moduleDir, 'accounting.controller.ts'), 'utf8');
  const allSource = readAllTsSource();

  it('no raw HTTP journal-post endpoint exists — the controller exposes only CoA/period/config/setup routes', () => {
    const routeCalls = [
      ...controllerSource.matchAll(/@(Get|Post|Patch|Put|Delete)\(['"]([^'"]*)['"]\)/g),
    ]
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
      .sort();
    expect(routeCalls).toEqual(
      [
        'GET accounts',
        'PATCH accounts/:id',
        'GET periods',
        'POST periods',
        'POST periods/:id/close',
        'PATCH config/timezone',
        'POST setup',
      ].sort(),
    );
    // no route path or handler name suggests a raw journal-posting surface
    expect(controllerSource).not.toMatch(/journals?['"/]|postJournal|debitMinor|creditMinor/i);
  });

  it('no reopen capability exists anywhere in the accounting module (no method, no route)', () => {
    expect(allSource).not.toMatch(/reopen/i);
  });

  it('the accounting module never reads or branches on Business-Type / capability (ADR-0018 neutrality)', () => {
    expect(allSource).not.toMatch(/businessType|capabilityKey|templateKey/i);
  });

  it('posTerminalId is used only for insertion/attribution, never as an isolation predicate (no WHERE clause filters by it)', () => {
    // every occurrence of `posTerminalId` inside a Prisma `where:` object or a
    // raw SQL WHERE clause would indicate it being used for isolation/lookup
    // rather than pure attribution on write.
    const whereClauseWithPos = /where\s*:\s*\{[^}]*posTerminalId/is.test(allSource);
    const rawWhereWithPos = /WHERE[^;]*posTerminalId/is.test(allSource);
    expect(whereClauseWithPos).toBe(false);
    expect(rawWhereWithPos).toBe(false);
  });

  it('the Posting Engine never accepts a caller-supplied posting instant (no `postingInstant` parameter, only the injected Clock)', () => {
    const engineSource = readFileSync(path.join(moduleDir, 'posting-engine.service.ts'), 'utf8');
    expect(engineSource).not.toMatch(/postingInstant/);
    expect(engineSource).toMatch(/this\.clock\.now\(\)/);
  });

  it('no `Number()`/floating arithmetic is used on money fields — debit/credit are BigInt end to end', () => {
    for (const file of [
      'posting-engine.service.ts',
      'posting-fingerprint.ts',
      'account.repository.ts',
    ]) {
      const src = readFileSync(path.join(moduleDir, file), 'utf8');
      expect(src, `${file} must not coerce a money amount via Number()`).not.toMatch(
        /Number\(\s*(amountMinor|debitMinor|creditMinor)/,
      );
    }
  });
});
