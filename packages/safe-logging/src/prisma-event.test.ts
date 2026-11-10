import { describe, expect, it } from 'vitest';
import { summarizePrismaLogEvent } from './prisma-event.js';
import { leaked, makeSecrets, prismaLikeError } from './test-support.js';

describe('summarizePrismaLogEvent', () => {
  it('reduces an error event to operation, site, code and one templated reason — no excerpt, no value', () => {
    const s = makeSecrets();
    const event = {
      message: prismaLikeError({ value: s.pan }).message,
      target: 'quaint::connector::postgres',
    };
    const out = summarizePrismaLogEvent('error', event);
    expect(out).toMatchObject({
      level: 'error',
      target: 'quaint::connector::postgres',
      operation: 'tx.user.findUnique()',
      site: 'apps/api/src/modules/access/access.repository.ts:81:34',
      message:
        'Inconsistent column data: Invalid input value: invalid input syntax for type uuid: "…"',
    });
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('where:');
  });

  it('extracts a Prisma code when the text carries one', () => {
    expect(
      summarizePrismaLogEvent('error', {
        message: 'Invalid `x.y()` invocation in\nf.ts:1:1\n\nP2025 record not found',
      }).code,
    ).toBe('P2025');
  });

  it('a non-invocation warning becomes one templated line', () => {
    const s = makeSecrets();
    const out = summarizePrismaLogEvent('warn', {
      message: `connection pool nearly exhausted for "${s.person}"\nsecond line ${s.pan}`,
    });
    expect(out.message).toBe('connection pool nearly exhausted for "…"');
    expect(out.operation).toBeUndefined();
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });

  it('a query event keeps only its duration — never the SQL text or parameters', () => {
    const s = makeSecrets();
    const out = summarizePrismaLogEvent('query', {
      message: `SELECT * FROM x WHERE a = '${s.pan}'`,
      target: 'quaint',
      duration: 12.7,
    } as never);
    expect(out).toEqual({ level: 'query', target: 'quaint', durationMs: 13, message: 'query' });
  });

  it('drops a hostile target or operation and survives unreadable events', () => {
    const s = makeSecrets();
    const out = summarizePrismaLogEvent('error', {
      message: `Invalid \`${s.token} x\` invocation in\nf.ts:1:1\n\nreason`,
      target: s.person,
    });
    expect(out.target).toBeUndefined();
    expect(out.operation).toBeUndefined();
    expect(summarizePrismaLogEvent('error', { message: 42 }).message).toBe('');
    expect(summarizePrismaLogEvent('error', {}).message).toBe('');
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });
});
