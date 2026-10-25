import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ArgumentsHost } from '@nestjs/common';
import { makeCanary, scanText, type Canary } from '../../verification/pci-canary.js';
import { scopeSchema } from '../../modules/access/access.schemas.js';
import { DomainError } from '../errors/domain-error.js';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter.js';
import { ZodBody } from './zod-body.js';
import {
  isSafePropertyName,
  sanitizeFieldPath,
  sanitizeIssueMessage,
  toValidationDetails,
  type ValidationIssueLike,
} from './validation-details.js';

// the exception filter logs through the shared logger; keep this unit test free of real logger configuration
vi.mock('../logger/logger.js', () => ({
  rootLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * F1 (task 3b.11) — validation error responses must not echo caller-controlled, card-shaped text.
 *
 * Synthetic canaries only (see `pci-canary.ts`): generated at run time, never printed. A failure message names the disguise
 * and the field that leaked, never the value.
 */

/** the mapping every caller used before F1, kept here as the compatibility reference */
const legacy = (issues: readonly ValidationIssueLike[]): { field?: string; issue: string }[] =>
  issues.map((i) => {
    const field = i.path.join('.');
    return field ? { field, issue: i.message } : { issue: i.message };
  });

const issuesOf = (schema: z.ZodType, input: unknown): ValidationIssueLike[] => {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('expected the input to be rejected');
  return r.error.issues as unknown as ValidationIssueLike[];
};

/** every disguise of the canary PAN usable as a property name, plus look-alike digit scripts */
function nameForms(c: Canary): Record<string, string> {
  const fullWidth = [...c.pan].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
  const arabicIndic = [...c.pan].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
  return {
    plain: c.pan,
    spaced: c.panForms['spaced']!,
    dashed: c.panForms['dashed']!,
    dotted: c.panForms['dotted']!,
    urlEncoded: c.panForms['urlEncoded']!,
    base64Plain: c.panForms['base64Plain']!,
    base64Spaced: c.panForms['base64Spaced']!,
    hex: c.panForms['hexPlain']!,
    track2: c.track2,
    prefixedWord: `card${c.pan}`,
    suffixedWord: `${c.pan}x`,
    fullWidth,
    arabicIndic,
    zeroWidthSplit: [...c.pan].join('​'),
    quoted: `"${c.pan}"`,
    tagged: c.tagged.pan,
    underscoreSplit: c.pan.replace(/(.{4})/g, '$1_').replace(/_$/, ''),
  };
}

const NON_ASCII_DIGITS = new RegExp('[\uff10-\uff19\u0660-\u0669\u06f0-\u06f9\u200b]');

/** assert that a serialized response carries no trace of the canary, in any known form */
function expectClean(label: string, serialized: string, c: Canary): void {
  expect(
    scanText(serialized, c).map((h) => h.kind),
    `${label}: leaked`,
  ).toEqual([]);
  expect(
    NON_ASCII_DIGITS.test(serialized),
    `${label}: look-alike digits or zero-width characters echoed`,
  ).toBe(false);
  expect(/\d{6,}/.test(serialized), `${label}: a long digit run was echoed`).toBe(false);
}

describe('F1 validation-details — compatibility for legitimate names', () => {
  const strict = z.object({ name: z.string().min(1), qty: z.number().max(10) }).strict();

  it('ordinary unrecognized keys keep Zod’s exact text and the exact legacy details', () => {
    for (const body of [
      { name: 'a', qty: 1, extraField: 1 },
      {
        name: 'a',
        qty: 1,
        branch_id: 1,
        'x-custom': 2,
        'a.b': 3,
        track2: 4,
        accountingTimezone: 5,
      },
      { name: 'a', qty: 99 }, // a non-key issue
      { qty: 'x' },
      {},
    ]) {
      const issues = issuesOf(strict, body);
      expect(toValidationDetails(issues)).toEqual(legacy(issues));
    }
  });

  it('nested objects, arrays and record paths with ordinary names are unchanged', () => {
    const schema = z
      .object({
        lines: z.array(z.object({ quantity: z.number().positive(), uomCode: z.string() }).strict()),
        meta: z.object({ deep: z.object({ leaf: z.string() }).strict() }).strict(),
      })
      .strict();
    const issues = issuesOf(schema, {
      lines: [
        { quantity: -1, uomCode: 1 },
        { quantity: 2, uomCode: 'x', surplusKey: 1 },
      ],
      meta: { deep: { leaf: 1, otherLeaf: 2 } },
    });
    expect(toValidationDetails(issues)).toEqual(legacy(issues));
    expect(toValidationDetails(issues).some((d) => d.field === 'lines.1')).toBe(true);
    expect(toValidationDetails(issues).some((d) => d.field === 'meta.deep')).toBe(true);
  });

  it('a record keyed by ordinary UUIDs keeps its exact path (perBranchOverlay)', () => {
    const branch = '0191f3a0-7b1c-7d2e-8f3a-4b5c6d7e8f90';
    const issues = issuesOf(scopeSchema, {
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: { [branch]: [123] },
    });
    const details = toValidationDetails(issues);
    expect(details).toEqual(legacy(issues));
    expect(details.some((d) => d.field?.includes(branch))).toBe(true);
  });

  it('safe names are accepted and unsafe shapes are refused by isSafePropertyName', () => {
    for (const ok of [
      'name',
      'accountingTimezone',
      'nonSecretConfig',
      'branch_id',
      'x-custom',
      'a.b',
      'track2',
      '_private',
      'v1',
      'a'.repeat(64),
    ]) {
      expect(isSafePropertyName(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '9abc',
      'a'.repeat(65),
      'has space',
      'quote"s',
      'é',
      'ｃａｒｄ',
      'a​b',
      'v1234',
      'abcDEF1234567890xyz'.replace('1234567890', '1a2b3c4d5e'),
      '%34%31',
    ]) {
      expect(isSafePropertyName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('error text that only contains short numbers is unchanged', () => {
    for (const m of [
      'Too big: expected number to be <=4000',
      'Invalid input: expected string, received number',
      'must be 12 characters',
      'Too small: expected string to have >=1 characters',
    ]) {
      expect(sanitizeIssueMessage({ path: [], message: m })).toBe(m);
    }
  });
});

describe('F1 validation-details — card-shaped caller text is never echoed', () => {
  it('unrecognized_keys at the top level, in every disguise', () => {
    const c = makeCanary();
    const schema = z.object({ ok: z.string() }).strict();
    for (const [form, name] of Object.entries(nameForms(c))) {
      const issues = issuesOf(schema, { ok: 'x', [name]: 1 });
      const details = toValidationDetails(issues);
      expectClean(`top-level ${form}`, JSON.stringify(details), c);
      expect(details[0]!.issue).toBe('Unrecognized key: "[redacted]"'); // still a useful diagnostic, in Zod's own wording
    }
  });

  it('several unrecognized keys: only the unsafe ones are replaced, the safe ones keep their text', () => {
    const c = makeCanary();
    const schema = z.object({ ok: z.string() }).strict();
    const issues = issuesOf(schema, { ok: 'x', surplus: 1, [c.pan]: 2, another: 3 });
    const [d] = toValidationDetails(issues);
    expect(d!.issue).toBe('Unrecognized keys: "surplus", "[redacted]", "another"');
    expectClean('mixed', JSON.stringify(d), c);
  });

  it('nested sensitive property names (object → object → array element) are sanitized in both field and issue', () => {
    const c = makeCanary();
    const schema = z
      .object({
        payment: z.object({ lines: z.array(z.object({ amount: z.string() }).strict()) }).strict(),
      })
      .strict();
    for (const [form, name] of Object.entries(nameForms(c))) {
      const body = { payment: { lines: [{ amount: '1' }, { amount: '2', [name]: 'x' }] } };
      const details = toValidationDetails(issuesOf(schema, body));
      expectClean(`nested ${form}`, JSON.stringify(details), c);
      expect(details[0]!.field).toBe('payment.lines.1'); // the path position is kept
    }
    // a sensitive name used as an INTERMEDIATE object key (not-strict parents surface it as a path segment)
    const loose = z.object({ [c.pan]: z.object({ v: z.string() }) });
    const details = toValidationDetails(issuesOf(loose, { [c.pan]: { v: 1 } }));
    expectClean('intermediate path segment', JSON.stringify(details), c);
    expect(details[0]!.field).toBe('*.v');
  });

  it('z.record keys: perBranchOverlay with a card number as the key (invalid key) and as a valid-shaped key with a bad value', () => {
    const c = makeCanary();
    for (const [form, name] of Object.entries(nameForms(c))) {
      const details = toValidationDetails(
        issuesOf(scopeSchema, {
          companyScope: 'ALL',
          branchScope: 'ALL',
          perBranchOverlay: { [name]: ['x'] },
        }),
      );
      expectClean(`record key ${form}`, JSON.stringify(details), c);
      expect(details.length).toBeGreaterThan(0); // the request is still rejected, with a useful path prefix
      expect(details.some((d) => (d.field ?? '').startsWith('perBranchOverlay'))).toBe(true);
    }
    // a UUID-SHAPED key that actually carries a card-shaped run is treated as unsafe
    const pan = c.pan;
    const sneaky = `${pan.slice(0, 8)}-${pan.slice(8, 12)}-${pan.slice(12, 16)}-0000-000000000000`;
    expect(isSafePropertyName(sneaky)).toBe(false);
    const details = toValidationDetails(
      issuesOf(scopeSchema, {
        companyScope: 'ALL',
        branchScope: 'ALL',
        perBranchOverlay: { [sneaky]: [123] },
      }),
    );
    expectClean('uuid-shaped key carrying a card-shaped run', JSON.stringify(details), c);
  });

  it('defensive mask: any message that interpolates a long digit run — even in look-alike digits — is masked', () => {
    const c = makeCanary();
    const fullWidth = [...c.pan].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    for (const text of [
      `bad value ${c.pan}`,
      `bad value ${c.panForms['spaced']}`,
      `bad value ${c.panForms['dashed']}`,
      `bad value ${fullWidth}`,
    ]) {
      const out = sanitizeIssueMessage({ code: 'custom', path: [], message: text });
      expectClean('custom message', out, c);
      expect(out.startsWith('bad value')).toBe(true);
    }
    expect(sanitizeFieldPath(['a', 3, Symbol('s'), 'ok_name'])).toBe('a.3.*.ok_name');
  });
});

describe('F1 validation-details — the real pipe and the real exception filter', () => {
  const schema = z.object({ name: z.string().min(1) }).strict();

  it('ZodBody still rejects unknown keys (strict validation is not weakened) and still accepts valid input', () => {
    const pipe = new ZodBody(schema);
    expect(pipe.transform({ name: 'ok' })).toEqual({ name: 'ok' });
    for (const body of [
      { name: 'ok', extra: 1 },
      { name: 'ok', [makeCanary().pan]: 1 },
      { name: '' },
      {},
      5,
      null,
    ]) {
      expect(() => pipe.transform(body)).toThrow(DomainError);
    }
  });

  function run(exception: unknown, correlationId?: string): { status: number; body: unknown } {
    let status = 0;
    let body: unknown;
    const reply = {
      status(s: number) {
        status = s;
        return this;
      },
      send(b: unknown) {
        body = b;
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ url: '/v1/x', ...(correlationId ? { correlationId } : {}) }),
      }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(exception, host);
    return { status, body };
  }

  it('the HTTP contract is unchanged: 400, VALIDATION_FAILED, the same message, { field, issue } details and the correlation id', () => {
    const pipe = new ZodBody(schema);
    let thrown: unknown;
    try {
      pipe.transform({ name: '', surplus: 1 });
    } catch (e) {
      thrown = e;
    }
    const { status, body } = run(thrown, 'corr-123');
    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'the request body is invalid',
        details: [
          { field: 'name', issue: 'Too small: expected string to have >=1 characters' },
          { issue: 'Unrecognized key: "surplus"' },
        ],
        correlationId: 'corr-123',
      },
    });
  });

  it('through the filter, a card-shaped property name never reaches the response body', () => {
    const c = makeCanary();
    const pipe = new ZodBody(schema);
    for (const [form, name] of Object.entries(nameForms(c))) {
      let thrown: unknown;
      try {
        pipe.transform({ name: 'ok', [name]: 1 });
      } catch (e) {
        thrown = e;
      }
      const { status, body } = run(thrown, 'corr');
      expect(status).toBe(400);
      expectClean(`response ${form}`, JSON.stringify(body), c);
      expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('F1 validation-details — no other mapped Zod issue text carries caller-controlled data', () => {
  it('empirical: with a card-shaped value as the INPUT, no built-in Zod message for any common schema kind contains it', () => {
    const c = makeCanary();
    const v = c.tagged.pan;
    const kinds: Record<string, [z.ZodType, unknown]> = {
      string: [z.string(), 12345],
      number: [z.number(), v],
      boolean: [z.boolean(), v],
      enum: [z.enum(['A', 'B']), v],
      literal: [z.literal('A'), v],
      regex: [z.string().regex(/^[a-z]+$/), v],
      uuid: [z.string().uuid(), v],
      email: [z.string().email(), v],
      min: [z.string().min(500), v],
      max: [z.string().max(3), v],
      int: [z.number().int(), 1.5],
      union: [z.union([z.string().uuid(), z.number()]), v],
      discriminated: [z.discriminatedUnion('t', [z.object({ t: z.literal('a') })]), { t: v }],
      array: [z.array(z.string()), v],
      arrayItem: [z.array(z.number()), [v]],
      object: [z.object({ a: z.number() }), { a: v }],
      recordValue: [z.record(z.string(), z.number()), { k: v }],
      date: [z.string().date(), v],
      nullable: [z.string().nullable(), { v }],
      optionalObject: [z.object({ a: z.string() }).optional(), v],
    };
    for (const [name, [schema, input]] of Object.entries(kinds)) {
      const issues = issuesOf(schema, input);
      const out = JSON.stringify(toValidationDetails(issues));
      expectClean(`built-in ${name}`, out, c);
      expect(out).not.toContain(c.marker);
    }
  });

  it('source scan: every custom Zod message in the API is a static string, and no mapper bypasses the helper', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../../', import.meta.url)); // apps/api/src
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !/\.test\.ts$/.test(p)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(300);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = f.slice(root.length);
      // a custom issue builder or a function-valued message could interpolate the input: none exists, so none may appear
      if (/\baddIssue\(|\bsuperRefine\(|ctx\.issues\b/.test(src))
        offenders.push(`${rel}: custom issue builder`);
      if (
        /\b(?:message|error)\s*:\s*(?:\(|`[^`]*\$\{)/.test(src) &&
        /from 'zod'|from "zod"/.test(src)
      ) {
        offenders.push(`${rel}: function-valued or interpolated zod message`);
      }
      // the legacy mapping that echoed Zod text verbatim
      if (/issue:\s*i\.message/.test(src))
        offenders.push(`${rel}: maps Zod issue text without the helper`);
    }
    expect(offenders).toEqual([]);
  });
});
