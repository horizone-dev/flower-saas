import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

/** the shared non-API logger factory with its production options (only the destination is replaced) */
describe('createLogger — safe options (task 3b.11 S-1)', () => {
  function logger(): { log: ReturnType<typeof createLogger>; text: () => string } {
    const chunks: string[] = [];
    const log = createLogger('svc', 'trace', false, {
      write: (s: string) => void chunks.push(s),
    } as never);
    return { log, text: () => chunks.join('') };
  }

  it('serializes an error through the allowlisted shape and keeps the redact paths', () => {
    const { log, text } = logger();
    const e = Object.assign(new Error('rejected "SECRET-VALUE-123456" for tenant'), {
      code: 'ECONNRESET',
      response: { body: 'SECRET-BODY' },
    });
    log.error({ err: e, user: { password: 'pw-xyz' }, tenantId: 't-1' }, 'tick failed');
    const rec = JSON.parse(text()) as Record<string, unknown>;
    expect(rec['name']).toBe('svc');
    expect(rec['tenantId']).toBe('t-1');
    expect(rec['err']).toMatchObject({
      type: 'Error',
      code: 'ECONNRESET',
      message: 'rejected "…" for tenant',
    });
    expect(text()).not.toContain('SECRET-VALUE');
    expect(text()).not.toContain('SECRET-BODY');
    expect(text()).not.toContain('pw-xyz');
  });

  it('an Error as the first argument does not leak its message through `msg`', () => {
    const { log, text } = logger();
    log.error(new Error('boom "SECRET-VALUE-123456"'));
    expect((JSON.parse(text()) as { msg: string }).msg).toBe('boom "…"');
    expect(text()).not.toContain('SECRET-VALUE');
  });
});
