import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 3b.9 Checkpoint D — structural pins.
 *
 * Checkpoint D extends the ONE internal orchestrator to an identified customer and adds
 * one pure file (`sale-authority.ts`). These tests read the real source (comments
 * stripped) and content-hash every frozen surface D reuses, so they cannot be satisfied
 * by wording and a silent edit to a frozen primitive fails loudly.
 *
 * `[CHECKPOINT-D SCOPE]` pins describe what D legitimately does NOT contain yet (HTTP,
 * module wiring, public idempotency, permission decorators, the sale event): the
 * checkpoint that adds that surface replaces the pin in the same change.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..'); // apps/api/src
const SALES = join(SRC, 'modules/sales');
const read = (abs: string): string => readFileSync(abs, 'utf8');

const SERVICE = join(SALES, 'atomic-walk-in-sale.service.ts');
const AUTHORITY = join(SALES, 'sale-authority.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
function codeOnly(src: string): string {
  return stripComments(src)
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const specifiersOf = (abs: string): string[] =>
  [...stripComments(read(abs)).matchAll(IMPORT_RE)].map((m) => m[1]!);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}
const isTest = (abs: string): boolean => /\.(test|spec)\.ts$/.test(abs);
const productionFiles = (dir: string): string[] =>
  walk(dir).filter((f) => f.endsWith('.ts') && !isTest(f));
const rel = (abs: string): string => relative(SRC, abs).replace(/\\/g, '/');
const sha = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const sha256 = (abs: string): string => sha(read(abs));

/**
 * The credit-exposure correction added ONE optional, trusted field to two frozen files. Every
 * added line sits between a `3b.9-credit-exposure:begin` and a `3b.9-credit-exposure:end` marker
 * line; stripping exactly those lines (and restoring the one replaced gate argument) must give
 * back the frozen file BYTE FOR BYTE — so nothing else in either file changed.
 */
const EXPOSURE_BEGIN = '3b.9-credit-exposure:begin';
const EXPOSURE_END = '3b.9-credit-exposure:end';
function withoutMarkedBlocks(
  text: string,
  begin: string,
  end: string,
): { restored: string; blocks: number } {
  const out: string[] = [];
  let skipping = false;
  let blocks = 0;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.includes(begin)) {
      if (skipping) throw new Error(`nested ${begin} marker`);
      skipping = true;
      blocks += 1;
    } else if (line.includes(end)) {
      if (!skipping) throw new Error(`${end} marker without a begin`);
      skipping = false;
    } else if (!skipping) {
      out.push(line);
    }
  }
  if (skipping) throw new Error(`unterminated ${begin} block`);
  return { restored: out.join('\n'), blocks };
}
const withoutExposureBlocks = (text: string): { restored: string; blocks: number } =>
  withoutMarkedBlocks(text, EXPOSURE_BEGIN, EXPOSURE_END);

// ── the service split into its regions ─────────────────────────────────────────
const ANON_START = '  async completeAnonymousPayNowForBranchScoped(';
const ANON_END = '  /**\n   * The conventional entry point of the identified-customer path';
const CUSTOMER_END = '  /** lock the order FOR UPDATE in exact scope';
function region(start: string, end: string): string {
  const s = read(SERVICE);
  const a = s.indexOf(start);
  const b = s.indexOf(end, a + 1);
  if (a < 0 || b < 0)
    throw new Error(`service region markers not found: ${start.trim().slice(0, 40)}`);
  return s.slice(a, b);
}
const anonymousRegion = (): string => region(ANON_START, ANON_END);
const customerRegion = (): string => region(ANON_END, CUSTOMER_END);
const anonymousPrimitive = (): string => {
  const r = anonymousRegion();
  return r.slice(r.indexOf('  async completeAnonymousPayNowInTx('));
};
const anonymousEntryPoint = (): string => {
  const r = anonymousRegion();
  return r.slice(0, r.indexOf('  /**\n   * The whole sale on the CALLER'));
};

describe('D — every frozen surface is byte-identical (content-hash pins)', () => {
  const FROZEN: Record<string, string> = {
    // Checkpoint A / B
    'modules/orders/canonical-totals.ts':
      '231d09308fdf8002c6cbb7e9914050b331165bcb822cf9f45d2bb8c3761b35dd',
    // (comment-only edit at Checkpoint F: the header now names the field `issuedInvoice` and the real wiring)
    'modules/orders/order-invoice-summary.ts':
      '135fb272658f797f677bc33336768e5073d9349fe42b4eef2bbce109dde34549',
    'modules/sales/sale-plan.ts':
      'b5a437bef60dc62210c3d9315eca2bc22b76ef8abb6d5729c44cd216be74198d',
    'modules/sales/walk-in-sale-journal.ts':
      'a1c5eeadef8e32aeb8bb4d79fa9fb1c60c3b497aad31106b87ae182a1d33e547',
    'modules/sales/walk-in-sale-journal.repository.ts':
      '0335a9df9e07289d17be304284de3b4869adc71f72fa2f24ec993c4864cf510c',
    // (tax-finalization.service.ts and invoice-issuance.repository.ts each gained ONE optional trusted
    //  field at the credit-exposure correction — proven by the marked-block restore pin below)
    // the frozen 3b.3 / 3b.5 / 3b.6 / 3b.8 primitives the customer path REUSES — none was edited
    // (modules/orders/order.repository.ts gained ONE additive, marker-delimited read method at
    //  Checkpoint E — proven by the marked-block restore pin below)
    'modules/orders/credit-note.repository.ts':
      '87534d1946297a288134330dd6e8a0c85fef11d8ff08dd810b9cfb24c1fd14ed',
    'modules/payments/payment-collection.repository.ts':
      '61b6d4110099e5cb8eb3c43078313f06aa3f4a0b89bcf390f54eec5caaf19e5f',
    'modules/receivables/customer-invoice-ar.repository.ts':
      '84b7b9f510d1d211bbbdfa32d36a989af8010134446346591be5c7b7b709e7a6',
    'modules/receivables/credit-override-authorization.service.ts':
      '452a8d7d4be3af5a33e867ed39084b9e61e27e30fca1a2bbfe4d85ccbcec0863',
    'modules/receivables/customer-advance-application.repository.ts':
      'eddb1e66f0121103b9b42d64b85af13e0726e2a3bc5c06a1537fc680704559e5',
    'modules/receivables/customer-receipt-effects.repository.ts':
      'eb65820bc46cbb9cd2c90594561c47a904867e3d5be9a29f8e6c3f009184e533',
    'modules/receivables/credit-exposure.ts':
      'e3d797784b2a4b228b02667adb94107cccef737994844cd7b7d0b6ef05a72f1a',
    'modules/receivables/advance-application.ts':
      '4800ce54bf498c0a92b7d950fcd74cdc31cd7edf001f7e9d02179d1e2094b09f',
    'modules/receivables/payment-intent.ts':
      '2dcc66af1b601fe4bdb269fc3ed31ca8c1bc1652a3966e01c594946e4862a84f',
    'modules/receivables/receivable-balance.repository.ts':
      'c866a5d015516c67597ca4aacdd3eecef64dc4556356de378a55686b1267c8f9',
    'modules/receivables/payment-advance-conversion.repository.ts':
      '4461bc0b4854ed58eaa1850f63fc66c8fa7acc38f880c53f1db1b5ec72c967ff',
    'modules/receivables/payment-customer-attribution.repository.ts':
      '64ba4f9d869a3989f13abab2eac2ae6fd903b729b4fe8209dc2a9227a18329a7',
  };
  for (const [file, hash] of Object.entries(FROZEN)) {
    it(`${file} is unchanged`, () => {
      expect(sha256(join(SRC, file))).toBe(hash);
    });
  }

  it('tax-finalization.service.ts equals its frozen Checkpoint-C hash once the marked credit-exposure lines are removed (ONE optional field, passed through, nothing else)', () => {
    const { restored, blocks } = withoutExposureBlocks(
      read(join(SRC, 'modules/orders/tax-finalization.service.ts')),
    );
    expect(blocks).toBe(2); // the interface field + the issuePrepared pass-through
    expect(sha(restored)).toBe('29a4575d4f97b7b82b05c522b0038c53962315f204b951df6efabef4d595eadb');
  });

  it('invoice-issuance.repository.ts equals its frozen hash once the marked credit-exposure lines are removed and the ONE replaced gate argument is restored', () => {
    const { restored, blocks } = withoutExposureBlocks(
      read(join(SRC, 'modules/orders/invoice-issuance.repository.ts')),
    );
    expect(blocks).toBe(2); // the interface field + the validation block
    const replaced = '          proposedAmountMinor: finalSaleOutstandingMinor,';
    expect(restored.split(replaced).length - 1).toBe(1);
    expect(
      sha(
        restored.replace(replaced, '          proposedAmountMinor: input.totals.totalAmountMinor,'),
      ),
    ).toBe('afc24c420ee9ba376d006efa8676bd526136698ef9c0ece9c93e5c94304190de');
  });

  it('order.repository.ts equals its frozen hash once the marked order-invoice lines (ONE additive read method + its import) are removed — the frozen getForBranchScoped and every cancellation path are byte-identical', () => {
    const { restored, blocks } = withoutMarkedBlocks(
      read(join(SRC, 'modules/orders/order.repository.ts')),
      '3b.9-order-invoice:begin',
      '3b.9-order-invoice:end',
    );
    expect(blocks).toBe(2); // the import + the method
    expect(sha(restored)).toBe('9f438552aa5098de024c009c1a965552beb47ea347858dd2cc0ac64b596d697f');
  });

  it('the permission registry is unchanged — Checkpoint D adds NO permission', () => {
    expect(sha256(join(ROOT, 'packages/permissions/src/index.ts'))).toBe(
      '20f66e4258f62899b67471a4f0e64fe84f8098a2dffe9a4b6575734729ed4c42',
    );
  });

  it('the ANONYMOUS primitive and entry point are byte-identical to Checkpoint C (anonymous behaviour frozen)', () => {
    expect(sha(anonymousPrimitive())).toBe(
      'f4a0dea34331e9a028427af04470c1f3c5c945da9b3e13e1618be6d546087c96',
    );
    expect(sha(anonymousEntryPoint())).toBe(
      '97d2f453947017cf2c720b794d6f281ac31266e72fb203717e4bec30f14c19ed',
    );
  });
});

describe('D — scope (advanced by E): the orchestrator itself still has no HTTP, permission or idempotency machinery', () => {
  it('modules/sales holds exactly the fifteen expected production files (E added the public surface)', () => {
    expect(
      productionFiles(SALES)
        .map((f) => relative(SALES, f).replace(/\\/g, '/'))
        .sort(),
    ).toEqual([
      'atomic-walk-in-sale.service.ts',
      'complete-sale-authority.guard.ts',
      'complete-sale-fingerprint.provider.ts',
      'complete-sale-response.ts',
      'dto/complete-sale.dto.ts',
      'order-totals-preview.repository.ts',
      'order-totals-preview.service.ts',
      'sale-authority.ts',
      'sale-events.ts',
      'sale-plan.ts',
      'sales-application.service.ts',
      'sales.controller.ts',
      'sales.module.ts',
      'walk-in-sale-journal.repository.ts',
      'walk-in-sale-journal.ts',
    ]);
  });

  it('[CHECKPOINT-D SCOPE, advanced by E] the service is provided by SalesModule alone and named only by that module and the thin facade; no pre-existing route learned a sale endpoint', () => {
    expect(read(join(SRC, 'app.module.ts'))).not.toMatch(/AtomicWalkInSale/);
    expect(
      productionFiles(SRC)
        .filter((f) => /AtomicWalkInSaleService/.test(stripComments(read(f))))
        .map(rel)
        .sort(),
    ).toEqual([
      'modules/sales/atomic-walk-in-sale.service.ts',
      'modules/sales/sales-application.service.ts',
      'modules/sales/sales.module.ts',
    ]);
    for (const c of [
      join(SRC, 'modules/orders/order.controller.ts'),
      join(SRC, 'modules/payments/payment.controller.ts'),
      join(SRC, 'modules/receivables/customer-advance-application.controller.ts'),
    ]) {
      expect(read(c), rel(c)).not.toMatch(/complete-sale|completeCustomerSale|completeAnonymous/);
    }
  });

  it('[CHECKPOINT-D SCOPE] no HTTP decorator, permission literal, step-up wiring or public-idempotency machinery in the service', () => {
    const src = stripComments(read(SERVICE));
    const code = codeOnly(read(SERVICE));
    expect(code).not.toMatch(
      /@(Controller|Get|Post|Put|Patch|Delete|RequirePermission|Public|UseGuards|Body|Param|Query|Headers)\b/,
    );
    expect(src).not.toMatch(/@flower\/permissions|RequirePermission|'[a-z_]+:[a-z_]+'/);
    expect(src).not.toMatch(
      /common\/idempotency|IdempotencyInterceptor|Idempotency-Key|IdempotencyScope/,
    );
    expect(code).not.toMatch(/claim|replay/i);
    expect(code).not.toMatch(/StepUp|step-up|stepUp/);
    expect(src).not.toMatch(/sale_completed|orders\.sale|eventType/);
  });

  it('no provider call, inventory call, business-type branching, float money, or cancellation / refund workaround', () => {
    const code = codeOnly(read(SERVICE));
    expect(code.replace(/this\.creditOverride\.authorize\(/g, '')).not.toMatch(
      /payment-provider|PaymentProvider|ProviderConfig|provider-config|webhook|\.(createIntent|authorize|capture|refund|getStatus|verifyWebhook)\s*\(/i,
    );
    expect(code).not.toMatch(/inventory|\bstock\b|reservation|availability|movement/i);
    expect(read(SERVICE)).not.toMatch(/businessType|business_type|BusinessType/);
    expect(code).not.toMatch(/\bNumber\s*\(|\bparseFloat\b|\bparseInt\b|\.toFixed\s*\(|\bMath\./);
    expect(code).not.toMatch(/(?<![\w.])\d+\.\d+(?![\w.])/);
    expect(code).not.toMatch(/credit_?note|refund|cancel|voided|void_?sale|\bvoid[A-Z_]/i);
  });
});

describe('D — the customer accounting path is the frozen 3b.6 set, never the walk-in journal', () => {
  const customer = (): string => stripComments(customerRegion());
  const anonymous = (): string => stripComments(anonymousRegion());
  const whole = (): string => stripComments(read(SERVICE));

  it('the customer region never touches the walk-in journal, its builder or its source kind', () => {
    expect(customer()).not.toMatch(
      /walkInJournal|buildWalkInSaleJournal|postWalkInSaleJournalInTx|walk_in_sale|WalkInSale/,
    );
  });

  it('the walk-in journal has exactly ONE call site in the whole service — inside the ANONYMOUS primitive', () => {
    const calls = whole().match(/postWalkInSaleJournalInTx\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(anonymous()).toMatch(/this\.walkInJournal\.postWalkInSaleJournalInTx\(/);
  });

  it('the service writes NO journal itself: no posting engine, no postJournal, no source-kind literal of any journal', () => {
    const src = whole();
    expect(src).not.toMatch(/PostingEngineService|postJournal\s*\(|postingEngine/);
    expect(src).not.toMatch(
      /invoice_ar|customer_receipt_payment|payment_allocation|customer_advance_application|walk_in_sale/,
    );
    expect(src).not.toMatch(/ASSET\.|REVENUE\.|LIABILITY\.|CONTRA_REVENUE/);
  });

  it('no manual Payment / PaymentAllocation / CustomerAdvance / CustomerReceivable / account-entry / projection access of any kind', () => {
    const code = codeOnly(read(SERVICE));
    expect(code).not.toMatch(
      /\btx\.(payment|paymentAllocation|paymentAttempt|customerAdvance|customerAdvanceApplication|customerReceivable|customerAccountEntry|customerCompanyAccount|journalEntry|journalLine|invoice|order)\b/,
    );
    const src = whole();
    expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM/i);
    expect(src).not.toMatch(
      /"payment"|"payment_allocation"|"customer_advance"|"customer_receivable"|"customer_account_entry"|"customer_company_account"\s+SET/i,
    );
  });

  it('credit is never a tender: no CREDIT method literal anywhere in the service', () => {
    expect(whole()).not.toMatch(
      /'CREDIT'|"CREDIT"|method\s*:\s*'(CREDIT|ADVANCE|WALLET|STORE_CREDIT)'/,
    );
  });

  it('the customer collaborators appear ONLY in the customer region (the anonymous path never touches them)', () => {
    const a = anonymous();
    expect(a).not.toMatch(
      /invoiceAr|advanceApplication|creditOverride|loadAdvanceBalances|preflightCustomer|assertAdvancesApplicable/,
    );
    expect(customer()).toMatch(/this\.invoiceAr\.lockAndAuthorizeCredit\(/);
    expect(customer()).toMatch(/this\.advanceApplication\.applyInTx\(/);
  });
});

describe('D — the customer sequence, and the pre-issuance discipline', () => {
  const src = stripComments(read(SERVICE));
  const body = (): string => {
    const c = stripComments(customerRegion());
    const a = c.indexOf('async completeCustomerSaleInTx(');
    const b = c.indexOf('private async preflightCustomer(');
    return c.slice(a, b);
  };

  it('order gate → canonical prepare → pure plan → customer pre-flight → advance pre-check → issuance → advances → tenders → coverage check', () => {
    const steps = [
      "this.lockAndGateOrder(tx, input, 'CUSTOMER')",
      'this.finalization.prepareFinalization(',
      'this.planPayment(input, totals,',
      'this.preflightCustomer(',
      'this.assertAdvancesApplicable(',
      'this.finalization.issuePrepared(',
      'this.advanceApplication.applyInTx(',
      'this.collection.captureSynchronousTendersInTx(',
      'loadInvoiceBalance(',
    ];
    const b = body();
    const positions = steps.map((s) => b.indexOf(s));
    expect(
      positions.every((p) => p >= 0),
      JSON.stringify(steps.filter((_, i) => positions[i]! < 0)),
    ).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    for (const s of steps) expect(b.split(s).length - 1, s).toBe(1);
  });

  it('everything refusable runs BEFORE the first number: the plan, the credit gate and the advance pre-check precede issuance', () => {
    const b = body();
    const issue = b.indexOf('this.finalization.issuePrepared(');
    for (const s of [
      'this.planPayment(',
      'this.preflightCustomer(',
      'this.assertAdvancesApplicable(',
    ]) {
      expect(b.indexOf(s), s).toBeLessThan(issue);
    }
  });

  it('advances are applied from the PLAN (ascending id), and BEFORE the tenders; tenders are captured only when real tenders exist', () => {
    const b = body();
    expect(b).toMatch(
      /for \(const a of plan\.advances\) \{\s*const applied = await this\.advanceApplication\.applyInTx\(/,
    );
    // the only OTHER loop over the raw request advances is the id shape check — it applies nothing
    const rawLoops = b.match(/for \(const a of input\.advances\) \{[\s\S]*?\n {4}\}/g) ?? [];
    expect(rawLoops).toHaveLength(1);
    expect(rawLoops[0]).toMatch(/UUID_RE\.test\(a\.advanceId\)/);
    expect(rawLoops[0]).not.toMatch(/applyInTx/);
    expect(b.indexOf('this.advanceApplication.applyInTx(')).toBeLessThan(
      b.indexOf('this.collection.captureSynchronousTendersInTx('),
    );
    expect(b).toMatch(/plan\.tenders\.length > 0/);
  });

  it('the shared steps appear exactly once per path in the whole file; the pure plan is built in ONE place', () => {
    const counts: Record<string, number> = {
      prepareFinalization: 2,
      issuePrepared: 2,
      captureSynchronousTendersInTx: 2,
      applyInTx: 1,
      lockAndAuthorizeCredit: 2, // the pre-flight, and its override retry
      planSale: 1,
      postWalkInSaleJournalInTx: 1,
    };
    for (const [call, expected] of Object.entries(counts)) {
      const n = src.match(new RegExp(String.raw`(?<![\w.])(?:[\w.]*\.)?${call}\s*\(`, 'g'));
      expect(n, call).toHaveLength(expected);
    }
  });

  it('a payment status is never written, and the one-shot finalizeAndIssueInvoice is never used', () => {
    expect(src).not.toMatch(/finalizeAndIssueInvoice/);
    expect(src).not.toMatch(/SET\s+"invoicePaymentStatus"/);
    expect(src).not.toMatch(
      /computeInvoiceCoverage|recomputeInvoicePaymentStatus|assertInvoicePaymentStatusTransition/,
    );
  });

  it("the customer is the ORDER's persisted customer: no customer field exists on the input, and the plan is built from order.customerId", () => {
    const iface = (name: string): string => {
      const m = src.match(new RegExp(String.raw`export interface ${name}\b[^{]*\{[\s\S]*?\n\}`));
      if (!m) throw new Error(`interface ${name} not found`);
      return m[0];
    };
    for (const name of ['CompleteCustomerSaleInput', 'CompleteCustomerSaleInTxInput']) {
      expect(iface(name), name).not.toMatch(
        /\bcustomerId\b|\bcustomerCompanyAccountId\b|\bcustomer\b\s*[?:]/,
      );
    }
    expect(body()).not.toMatch(/input\.customerId|input\.customerCompanyAccountId/);
    expect(body()).toMatch(/const customerId = order\.customerId;/);
    expect(body()).not.toMatch(/input\.customer/);
  });
});

describe('D — the credit-limit override: server-determined, one authorization path, no boolean', () => {
  const src = stripComments(read(SERVICE));
  const preflight = (): string => {
    const c = stripComments(customerRegion());
    return c.slice(
      c.indexOf('private async preflightCustomer('),
      c.indexOf('private async assertAdvancesApplicable('),
    );
  };

  it('authorize() is called exactly once, only inside the pre-flight, only AFTER the gate denied the sale', () => {
    expect(src.match(/\.authorize\s*\(/g)).toHaveLength(1);
    const p = preflight();
    expect(p).toMatch(/this\.creditOverride\.authorize\(/);
    expect(p.indexOf("err.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED'")).toBeGreaterThan(-1);
    expect(p.indexOf("err.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED'")).toBeLessThan(
      p.indexOf('this.creditOverride.authorize('),
    );
    // no denial (or no reason) → the original error stands; a reason alone grants nothing
    expect(p).toMatch(/if \(!denied \|\| reason === undefined \|\| reason === null\) throw err;/);
  });

  it('an override can only come from authorize(): never from the request, never hand-built, never a boolean', () => {
    expect(src).not.toMatch(
      /input\.creditOverride|overrideCreditLimit|allowOverLimit|forceOverride|isOverride|\bforce\b/,
    );
    expect(src).not.toMatch(/OVERRIDE_BRAND|actorUserId\s*:[^}]*reason\s*:/);
    // the override handed to issuance is the pre-flight's, nothing else
    expect(src).toMatch(
      /\.\.\.\(preflight\.creditOverride !== undefined\s*\?\s*\{ creditOverride: preflight\.creditOverride \}\s*:\s*\{\}\)/,
    );
    // (the constructor dependency declaration aside) that spread is the ONLY place an override key appears
    const withoutCtor = src.replace(
      /private readonly creditOverride: CreditOverrideAuthorizationService,/,
      '',
    );
    expect(withoutCtor.match(/creditOverride\s*:/g)).toHaveLength(1);
  });

  it('the credit-limit exception reason is an INTERNAL input and is read in exactly one place', () => {
    expect(src.match(/creditLimitExceptionReason/g)).toHaveLength(2); // the input field + the pre-flight read
    expect(preflight()).toMatch(/input\.creditLimitExceptionReason/);
  });

  it('a missing authenticated context fails closed (CREDIT_OVERRIDE_DENIED) before authorize() is consulted', () => {
    const p = preflight();
    expect(p).toMatch(/input\.authorizationContext === null/);
    expect(p).toMatch(/CREDIT_OVERRIDE_DENIED/);
    expect(p.indexOf('input.authorizationContext === null')).toBeLessThan(
      p.indexOf('this.creditOverride.authorize('),
    );
  });
});

describe('D — advances: the frozen primitive spends them; the orchestrator only pre-checks', () => {
  const src = stripComments(read(SERVICE));
  it('only the frozen applyInTx mutates an advance; the pre-check is a read through the canonical balance loader', () => {
    expect(src).toMatch(/loadAdvanceBalances\(/);
    expect(src.match(/this\.advanceApplication\.applyInTx\(/g)).toHaveLength(1);
    // (the receivable-outstanding projection is READ — never written — in exactly two named places:
    //  see the credit-exposure pins below)
    expect(src).not.toMatch(/advanceBalanceMinor|"customer_advance"/);
  });
  it('the pre-check is scoped to THIS company, THIS branch and THIS customer account — and the id is shape-checked before any SQL', () => {
    const c = stripComments(customerRegion());
    const check = c.slice(c.indexOf('private async assertAdvancesApplicable('));
    expect(check).toMatch(/customerCompanyAccountId,/);
    expect(check).toMatch(/branchId: input\.branchId,/);
    expect(check).toMatch(/companyId: input\.companyId,/);
    expect(src).toMatch(/UUID_RE\.test\(a\.advanceId\)/);
  });
});

describe('D — OWNER RULING: the credit limit applies to the RESULTING receivable exposure (finalSaleOutstanding), never the gross invoice total', () => {
  const src = stripComments(read(SERVICE));
  const customer = (): string => stripComments(customerRegion());
  const method = (name: string, next: string): string => {
    const c = customer();
    const a = c.indexOf(name);
    const b = c.indexOf(next, a + 1);
    if (a < 0 || b < 0) throw new Error(`method markers not found: ${name}`);
    return c.slice(a, b);
  };
  const body = (): string =>
    method('async completeCustomerSaleInTx(', 'private finalSaleOutstanding(');
  const exposure = (): string =>
    method('private finalSaleOutstanding(', 'private async preflightCustomer(');
  const preflight = (): string =>
    method('private async preflightCustomer(', 'private async assertExposureProjection(');
  const projection = (): string =>
    method('private async assertExposureProjection(', 'private async assertAdvancesApplicable(');

  it('finalSaleOutstanding is computed INTERNALLY: invoice total − same-sale tenders − same-sale advances, cross-checked against the pure plan, in exact BigInt and one currency', () => {
    const e = exposure();
    // the remainder is the frozen pure plan's; conservation against the canonical total is re-proven by ADDITION
    expect(e).toMatch(/const exposure = plan\.outstandingMinor;/);
    expect(e).toMatch(
      /plan\.tenderTotalMinor \+ plan\.advanceTotalMinor \+ exposure !== totals\.totalAmountMinor/,
    );
    expect(e).toMatch(/exposure < 0n/);
    expect(e).toMatch(/plan\.currencyCode !== totals\.currencyCode/);
    expect(e).toMatch(/plan\.currencyExponent !== totals\.currencyExponent/);
    expect(e).toMatch(/plan\.totalAmountMinor !== totals\.totalAmountMinor/);
    expect(e).toMatch(/SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED/);
    // never from the request, never a float
    expect(e).not.toMatch(/\binput\b|Number\(|parseFloat|Math\./);
  });

  it('the credit gate is fed finalSaleOutstanding — and ONLY that: no invoice total reaches the pre-flight or its gate input', () => {
    const b = body();
    expect(b.match(/this\.finalSaleOutstanding\(plan, totals\)/g)).toHaveLength(1);
    expect(b).toMatch(
      /this\.preflightCustomer\(\s*tx,\s*input,\s*customerId,\s*intent,\s*finalSaleOutstanding,?\s*\)/,
    );
    const p = preflight();
    expect(p).toMatch(/proposedAmountMinor: exposureMinor,/);
    expect(p).not.toMatch(/totalAmountMinor|totals\b/);
    // the exposure is computed BEFORE the pre-flight, which precedes issuance (no number can be burned by a credit denial)
    expect(b.indexOf('this.finalSaleOutstanding(plan, totals)')).toBeLessThan(
      b.indexOf('this.preflightCustomer('),
    );
    expect(b.indexOf('this.preflightCustomer(')).toBeLessThan(
      b.indexOf('this.finalization.issuePrepared('),
    );
  });

  it("issuance's own (second) gate receives the SAME internally computed exposure, and nothing else passes finalSaleOutstandingMinor", () => {
    const b = body();
    const issue = b.slice(b.indexOf('this.finalization.issuePrepared('));
    expect(issue.slice(0, issue.indexOf('});'))).toMatch(
      /finalSaleOutstandingMinor: finalSaleOutstanding,/,
    );
    expect(src.match(/finalSaleOutstandingMinor/g)).toHaveLength(1);
    // closed world: only the two issuance files that carry the optional field and this orchestrator mention it
    const holders = productionFiles(SRC)
      .filter((f) => /finalSaleOutstandingMinor/.test(stripComments(read(f))))
      .map(rel)
      .sort();
    expect(holders).toEqual([
      'modules/orders/invoice-issuance.repository.ts',
      'modules/orders/tax-finalization.service.ts',
      'modules/sales/atomic-walk-in-sale.service.ts',
    ]);
    // …and no controller / DTO can ever carry it
    for (const f of productionFiles(SRC)) {
      if (/\.controller\.ts$|[\\/]dto[\\/]/.test(f)) {
        expect(stripComments(read(f)), rel(f)).not.toMatch(/finalSaleOutstanding/);
      }
    }
  });

  it('a POSTCONDITION proves the committed state: invoice balance == finalSaleOutstanding, and the account projection == existing + finalSaleOutstanding', () => {
    const b = body();
    expect(b).toMatch(/balance\.outstandingMinor !== finalSaleOutstanding/);
    expect(b).toMatch(/captured\.remainingAvailableToCollectMinor !== finalSaleOutstanding/);
    expect(b.match(/this\.assertExposureProjection\(/g)).toHaveLength(1);
    // after the advances AND the tenders were applied, after the invoice balance was loaded
    expect(b.indexOf('this.assertExposureProjection(')).toBeGreaterThan(
      b.indexOf('this.collection.captureSynchronousTendersInTx('),
    );
    expect(b.indexOf('this.assertExposureProjection(')).toBeGreaterThan(
      b.indexOf('loadInvoiceBalance('),
    );
    const p = projection();
    expect(p).toMatch(/committed !== preflight\.existingOutstandingMinor \+ finalSaleOutstanding/);
    expect(p).toMatch(/SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED/);
    // a scoped READ of the very column the gate evaluates — never a write
    expect(p).toMatch(/SELECT "currentOutstandingMinor" FROM "customer_company_account"/);
    expect(p).toMatch(/"tenantId" = \$\{input\.tenantId\}::uuid/);
    expect(p).toMatch(/"companyId" = \$\{input\.companyId\}::uuid/);
    expect(p).toMatch(/"id" = \$\{preflight\.customerCompanyAccountId\}::uuid/);
    expect(p).not.toMatch(/UPDATE|INSERT|DELETE|\.update\(|\.create\(/i);
  });

  it('the pre-flight still takes the account lock FIRST (the frozen lockAndAuthorizeCredit) and reports the locked existing outstanding the postcondition uses', () => {
    const p = preflight();
    expect(p.match(/this\.invoiceAr\.lockAndAuthorizeCredit\(/g)).toHaveLength(2); // gate + the override retry
    expect(p).toMatch(/existingOutstandingMinor: allowed\.account\.currentOutstandingMinor/);
    expect(p).toMatch(/existingOutstandingMinor: overridden\.account\.currentOutstandingMinor/);
  });

  it('the stored outstanding projection is READ only in those two places and written nowhere in the service', () => {
    const c = customer();
    const without = c.replace(preflight(), '').replace(projection(), '');
    expect(without).not.toMatch(/currentOutstandingMinor/);
    expect(src).not.toMatch(
      /UPDATE\s+"|SET\s+"currentOutstandingMinor"|currentOutstandingMinor\s*:\s*\{/i,
    );
  });

  it('the ANONYMOUS path knows nothing of the exposure: no finalSaleOutstanding, projection check or gate', () => {
    const a = stripComments(anonymousRegion());
    expect(a).not.toMatch(
      /finalSaleOutstanding|assertExposureProjection|currentOutstandingMinor|lockAndAuthorizeCredit/,
    );
  });

  it('PAY_NOW consumes no credit by construction: its planned exposure is 0 (the pure plan), and the gate is not required for it', () => {
    const plan = read(join(SALES, 'sale-plan.ts'));
    expect(plan).toMatch(/creditGateRequired: intent === 'ON_CREDIT'/);
    const intents = stripComments(read(join(SRC, 'modules/receivables/payment-intent.ts')));
    const gateFn = intents.slice(
      intents.indexOf('export function requiresCreditGate'),
      intents.indexOf('export function computeCreditAuthorizedFlag'),
    );
    expect(gateFn).toMatch(/case 'PAY_NOW':\s*return false;/);
    expect(gateFn).toMatch(/case 'ON_CREDIT':\s*return true;/);
  });
});

describe('D — sale-authority.ts is PURE metadata', () => {
  it('imports nothing, touches no DB / clock / randomness, and names exactly the three already-registered keys', () => {
    expect(specifiersOf(AUTHORITY)).toEqual([]);
    const code = codeOnly(read(AUTHORITY));
    expect(code).not.toMatch(
      /\btx\b|\$queryRaw|\bDate\b|Math\.random|randomUUID|process\.env|\bfetch\b/,
    );
    const keys = [...stripComments(read(AUTHORITY)).matchAll(/'([a-z_]+(?::[a-z_]+)+)'/g)]
      .map((m) => m[1]!)
      .sort();
    expect(keys).toEqual([
      'customers:credit:override',
      'payments:collect',
      'receivables:advance:apply',
    ]);
  });
});

describe('D — no migration 50, no Task 3b.10, RB-1 still open, the performance note is recorded as a non-production benchmark', () => {
  const migrationsDir = join(ROOT, 'packages/db/prisma/migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((n) => /^\d{14}_/.test(n))
    .sort();

  it('the migration chain is exactly the frozen 49 — the customer path needed no new DB mechanism', () => {
    expect(migrations).toHaveLength(49);
    expect(migrations[48]).toBe('20261010120000_phase_3b8_currency_and_release_integrity');
    expect(
      migrations.filter((n) =>
        /3b_?9|walk_?in_?sale|atomic_?sale|complete_?sale|customer_?sale/i.test(n),
      ),
    ).toEqual([]);
  });

  it('no Task 3b.10 artifact', () => {
    // Task 3b.10 (approved after the 3b.9 merge) owns `modules/reporting/`; this 3b.9 pin keeps guarding
    // everything else — no reporting / trial-balance artifact OUTSIDE that read-only module.
    expect(
      productionFiles(SRC).filter(
        (f) =>
          !/^modules\/reporting\//.test(rel(f)) && /reporting|trial-?balance|3b-?10/i.test(rel(f)),
      ),
    ).toEqual([]);
  });

  it('RB-1 stays open: the frozen walk-in post-invoice restriction is intact and no anonymous void / refund exists', () => {
    expect(read(join(SRC, 'modules/orders/order.repository.ts'))).toMatch(
      /WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE/,
    );
    expect(read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'))).toMatch(/RB-1/);
    expect(existsSync(join(SALES, 'void-sale.ts'))).toBe(false);
  });

  it('the Checkpoint C throughput figure is recorded as a NON-PRODUCTION benchmark, with a later Phase-3 latency hard gate', () => {
    const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));
    const phase = read(join(ROOT, 'docs/phase-3/PHASE-3B-PLAN.md'));
    expect(plan).toMatch(/non-production benchmark/);
    expect(plan).toMatch(/NOT a production capacity guarantee/);
    expect(plan).toMatch(/HG3b-SALE-LATENCY/);
    expect(phase).toMatch(/HG3b-SALE-LATENCY/);
    expect(phase).toMatch(/non-production benchmark/);
    expect(phase).toMatch(/NOT a capacity guarantee/);
  });
});
