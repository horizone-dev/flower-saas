import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3B closure — the optional `userId` of the shared test fixture `mintTenantToken` must not weaken identity or isolation
 * testing. The default (no `userId`) is a RANDOM user id with no `user` row, exactly as before; a caller may name a user only
 * deliberately, and the one caller that does (P6f of the PCI suite) must take that user from the SAME tenant as the session.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8').replace(/\r\n/g, '\n');

describe('mintTenantToken fixture — identity pins', () => {
  it('the default is still a random user id; the session tenant is still the explicit tenant argument', () => {
    const w = read('load-sale-world.ts');
    expect(w).toMatch(/s\.userId = o\.userId \?\? randomUUID\(\);/);
    expect(w).toMatch(/s\.tenantId = tenantId;/);
    expect(w).toMatch(/aud: 'tenant', tid: tenantId/);
  });

  it('NO test other than the PCI suite passes a userId to mintTenantToken', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(HERE).filter(
      (x) => x.endsWith('.ts') && x !== 'load-sale-world.ts',
    )) {
      if (f === 'fixture-identity.structural.test.ts') continue;
      const src = read(f);
      for (const m of src.matchAll(/mintTenantToken\(([\s\S]*?)\);/g)) {
        if (/\buserId\b/.test(m[1]!)) offenders.push(f);
      }
    }
    expect([...new Set(offenders)]).toEqual(['task-3b11-pci-bounded-negative.test.ts']);
  });

  it("the PCI suite's named user is looked up in the SAME tenant as the session and must exist", () => {
    const p = read('task-3b11-pci-bounded-negative.test.ts');
    expect(p).toMatch(/FROM "user" WHERE "tenantId" = \$1 AND "accountType" = 'OWNER'/);
    expect(p).toMatch(/\[w\.a\.tenantId\]/);
    expect(p).toMatch(/expect\(realOwnerId\)\.toBeTruthy\(\)/);
    expect(p).toMatch(
      /mintTenantToken\(w\.h, w\.a\.tenantId, owner, \{\s*stepUp: true,\s*userId: realOwnerId,\s*\}\)/,
    );
  });
});
