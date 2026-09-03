// Wire @typescript-eslint/rule-tester into Vitest and export a ready RuleTester.
import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** RuleTester using the TS parser (syntactic; no type-aware services needed). */
export function makeRuleTester() {
  return new RuleTester();
}
