import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainError } from '../errors/domain-error.js';
import { UuidCursorPipe } from './uuid-pipes.js';
import { parseInput } from './zod-input.js';

const UUID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const run = (fn: () => unknown): DomainError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error('did not throw');
};

describe('UuidCursorPipe', () => {
  const pipe = new UuidCursorPipe();
  it('absent → first page; a UUID passes; anything else is 400 INVALID_CURSOR without echo', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform(UUID)).toBe(UUID);
    for (const bad of ['nope', '', 'eyJpZCI6MX0', ['a', 'b'], 5]) {
      const e = run(() => pipe.transform(bad));
      expect([e.status, e.code]).toEqual([400, 'INVALID_CURSOR']);
      expect(e.message).not.toContain('nope');
    }
  });
});

describe('parseInput', () => {
  const schema = z.object({ at: z.string().datetime().optional() }).strict();
  it('returns parsed data, or 400 VALIDATION_FAILED (a zod error is never a 500)', () => {
    expect(parseInput(schema, { at: '2026-01-01T00:00:00Z' }, 'query')).toEqual({
      at: '2026-01-01T00:00:00Z',
    });
    const e = run(() => parseInput(schema, { at: 'garbage' }, 'query'));
    expect([e.status, e.code]).toEqual([400, 'VALIDATION_FAILED']);
    const k = run(() => parseInput(schema, { '4111111111111111': 1 }, 'query'));
    expect(JSON.stringify(k.details)).not.toContain('4111111111111111');
  });
});
