import { describe, expect, it } from 'vitest';
import { firstLine, sanitizeLogMessage, templateText, TEMPLATE_MAX_LENGTH } from './template.js';
import { leaked, makeSecrets } from './test-support.js';

describe('templateText', () => {
  it('replaces quoted spans of every quote style and keeps the sentence', () => {
    expect(templateText('unknown account key "ABC-123" in `col` of \'tbl\'')).toBe(
      'unknown account key "…" in `…` of \'…\'',
    );
  });

  it('does not mangle apostrophes inside words', () => {
    expect(templateText("it can't be done; the customer's order")).toBe(
      "it can't be done; the customer's order",
    );
  });

  it('replaces e-mails and long opaque tokens', () => {
    const s = makeSecrets();
    expect(templateText(`from ${s.email} with ${s.token}`)).toBe('from <email> with <token>');
  });

  it('replaces digit runs of six or more in any script and with separators, keeps short numbers', () => {
    const s = makeSecrets();
    const fullWidth = [...s.pan].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    const arabicIndic = [...s.pan].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
    const zeroWidth = [...s.pan].join('​');
    for (const form of [
      s.pan,
      (s.pan.match(/.{1,4}/g) ?? []).join(' '),
      (s.pan.match(/.{1,4}/g) ?? []).join('-'),
      fullWidth,
      arabicIndic,
      zeroWidth,
    ]) {
      expect(templateText(`rejected ${form} today`), form.slice(0, 4)).toBe('rejected # today');
    }
    expect(templateText('status 404 after 3 retries, 12345 ms')).toBe(
      'status 404 after 3 retries, 12345 ms',
    );
  });

  it('bounds the length', () => {
    const out = templateText('word '.repeat(500));
    expect(out.length).toBeLessThanOrEqual(TEMPLATE_MAX_LENGTH + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is idempotent', () => {
    const s = makeSecrets();
    const once = templateText(`bad "${s.pan}" ${s.email} ${s.token} ${s.pan}`);
    expect(templateText(once)).toBe(once);
    expect(leaked(once, s)).toEqual([]);
  });

  it('firstLine stops at any newline style', () => {
    expect(firstLine('a\nb')).toBe('a');
    expect(firstLine('a\r\nb')).toBe('a');
    expect(firstLine('only')).toBe('only');
  });

  it('sanitizeLogMessage leaves ordinary developer sentences untouched', () => {
    for (const m of [
      'unhandled error',
      'outbox dispatcher tick failed',
      'webhook recovery: a candidate failed — it remains RECEIVED for the next pass',
      'shutting down',
    ]) {
      expect(sanitizeLogMessage(m)).toBe(m);
    }
  });
});

describe('templateText — compatibility forms', () => {
  it('folds full-width quotes and at-signs before templating', () => {
    expect(templateText('bad ＂secret value＂ here')).toBe('bad "…" here');
    expect(templateText('mail a.b＠example.test now')).toBe('mail <email> now');
  });
});
