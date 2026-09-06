import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * HG3-NO-BT-BRANCH — structural proof (owner §21). No Task 3.2 catalog
 * domain-logic file may read `tenant.businessTypeKey` / a business-type label to
 * branch behaviour. Behaviour is `product.fulfilmentStrategy` + the enabled
 * `tenant_catalog_capability` rows ONLY. (The behavioural half — two tenants with
 * different business types but identical capabilities behave identically — is in
 * `catalog-core.integration.test.ts`.)
 *
 * `catalog-capability.*` (task 3.1) is deliberately excluded: `ownView()` exposes
 * `businessTypeKey` as pure provenance in a read projection, never a branch.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

const DOMAIN_FILES = [
  'category.repository.ts',
  'category.controller.ts',
  'product.repository.ts',
  'product.service.ts',
  'product.controller.ts',
  'product-type.repository.ts',
  'product-type.controller.ts',
  'catalog-write.helpers.ts',
];

/** strip `//` line comments and `/* *\/` block comments */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('HG3-NO-BT-BRANCH — Task 3.2 catalog domain code never branches on Business Type', () => {
  for (const file of DOMAIN_FILES) {
    it(`${file} has no business-type reference in executable code`, () => {
      const code = stripComments(readFileSync(path.join(here, file), 'utf8'));
      expect(code).not.toMatch(/business[_-]?type/i);
      // and no hardcoded preset-key comparison
      expect(code).not.toMatch(
        /['"](FLOWER_FLORIST|BAKERY_CAKE|PERFUME_ATTAR|CUSTOM|PLANT_NURSERY)['"]/,
      );
    });
  }
});
