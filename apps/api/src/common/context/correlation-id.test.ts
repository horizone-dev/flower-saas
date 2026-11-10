import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createRootLogger } from '@flower/backend';
import { ForbiddenException } from '@nestjs/common';
import { makeCanary, scanText } from '../../verification/pci-canary.js';
import {
  CORRELATION_HEADER,
  installCorrelationId,
  isSafeCorrelationId,
  resolveCorrelationId,
} from './correlation-id.js';

/**
 * Inbound `x-correlation-id` (task 3b.11): only a canonical, non-card-shaped UUID / ULID is honoured; everything else is
 * replaced by the server-generated id and is never echoed (header, body) or logged.
 */

const UUID_OK = '0191f3a0-7b1c-7d2e-8f3a-4b5c6d7e8f90'; // fixed: a random UUID is (rarely, ~0.7 %) rejected for containing a Luhn-valid digit window
const ULID = '01HZX3K9QJ7M2N8P4R5S6T7V8W';

describe('isSafeCorrelationId', () => {
  it('accepts a canonical UUID (lower / upper case) and a ULID', () => {
    for (const ok of [UUID_OK, UUID_OK.toUpperCase(), ULID, ULID.toLowerCase()]) {
      expect(isSafeCorrelationId(ok), ok).toBe(true);
    }
  });

  it('accepts random UUIDs even when they contain a long run of digits that is not a card number', () => {
    expect(isSafeCorrelationId('11111111-1111-1111-1111-111111111111')).toBe(true); // 32 digits, no Luhn-valid window
    let accepted = 0;
    for (let i = 0; i < 2000; i++) if (isSafeCorrelationId(randomUUID())) accepted++;
    expect(accepted / 2000).toBeGreaterThan(0.95);
  });

  it('rejects card-shaped numeric values, encoded values, unexpected formats, wrong types and oversized values', () => {
    const c = makeCanary();
    const rejected: unknown[] = [
      c.pan, // 16 digits
      c.pan.slice(0, 13),
      `${c.pan}${c.pan}`,
      `${c.pan.slice(0, 4)}-${c.pan.slice(4, 8)}-${c.pan.slice(8, 12)}-${c.pan.slice(12)}`,
      `${c.pan.slice(0, 4)} ${c.pan.slice(4, 8)} ${c.pan.slice(8, 12)} ${c.pan.slice(12)}`,
      // a UUID-shaped value whose digits carry a card number across the hyphens
      `${c.pan.slice(0, 8)}-${c.pan.slice(8, 12)}-${c.pan.slice(12)}-0000-000000000000`,
      // a ULID whose characters are digits only and contain a card number
      `${c.pan}0123456789`,
      encodeURIComponent(c.pan),
      Buffer.from(c.pan).toString('base64'),
      Buffer.from(c.pan).toString('hex'),
      `${randomUUID()}%0d%0aX-Injected: 1`,
      `${randomUUID()}\r\nX-Injected: 1`,
      ` ${randomUUID()}`,
      `${randomUUID()}x`,
      'abc',
      '',
      '<script>alert(1)</script>',
      'a'.repeat(200),
      [randomUUID(), randomUUID()],
      undefined,
      null,
      12345,
    ];
    for (const bad of rejected) expect(isSafeCorrelationId(bad), JSON.stringify(bad)).toBe(false);
  });

  it('resolveCorrelationId returns the inbound id when safe, else the generated one', () => {
    const inbound = UUID_OK;
    const generated = randomUUID();
    expect(resolveCorrelationId(inbound, generated)).toBe(inbound);
    expect(resolveCorrelationId(makeCanary().pan, generated)).toBe(generated);
    expect(resolveCorrelationId(undefined, generated)).toBe(generated);
  });
});

describe('installCorrelationId on a real Fastify instance + the real exception filter and real pino logger', () => {
  const serialized: string[] = [];
  const logger = createRootLogger({ write: (s: string) => void serialized.push(s) } as never);
  logger.level = 'trace';

  async function build() {
    const app = Fastify({ genReqId: () => randomUUID() });
    installCorrelationId(app);
    app.get('/echo', (req) => ({ id: (req as { correlationId?: string }).correlationId }));
    app.get('/fail', async (req, reply) => {
      // what AllExceptionsFilter does with the id: log it and put it in the body
      const correlationId = (req as { correlationId?: string }).correlationId;
      logger.warn({ code: 'FORBIDDEN', status: 403, correlationId }, 'forbidden');
      const e = new ForbiddenException('nope');
      void reply
        .status(e.getStatus())
        .send({ error: { code: 'FORBIDDEN', message: 'nope', correlationId } });
    });
    await app.ready();
    return app;
  }

  it('honours a valid UUID and a valid ULID end to end (header, body, log)', async () => {
    const app = await build();
    for (const id of [UUID_OK, ULID]) {
      serialized.length = 0;
      const res = await app.inject({
        method: 'GET',
        url: '/fail',
        headers: { [CORRELATION_HEADER]: id },
      });
      expect(res.headers[CORRELATION_HEADER]).toBe(id);
      expect((res.json() as { error: { correlationId: string } }).error.correlationId).toBe(id);
      expect(serialized.join('')).toContain(id);
    }
    await app.close();
  });

  it('replaces PAN-shaped and other unsafe values with a generated UUID; the raw value appears nowhere', async () => {
    const app = await build();
    const c = makeCanary();
    const hostile = [
      c.pan,
      `${c.pan.slice(0, 4)}-${c.pan.slice(4, 8)}-${c.pan.slice(8, 12)}-${c.pan.slice(12)}`,
      encodeURIComponent(c.pan),
      Buffer.from(c.pan).toString('base64'),
      `${c.pan.slice(0, 8)}-${c.pan.slice(8, 12)}-${c.pan.slice(12)}-0000-000000000000`,
      'not a canonical id',
    ];
    for (const value of hostile) {
      serialized.length = 0;
      const res = await app.inject({
        method: 'GET',
        url: '/fail',
        headers: { [CORRELATION_HEADER]: value },
      });
      const generated = res.headers[CORRELATION_HEADER] as string;
      expect(generated).not.toBe(value);
      expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const everything = JSON.stringify(res.headers) + res.body + serialized.join('');
      expect(everything).not.toContain(value);
      expect(scanText(everything, c).filter((h) => h.kind !== 'generic-luhn')).toEqual([]);
      // the replacement is what is logged and returned — traceability is preserved
      expect(serialized.join('')).toContain(generated);
      expect((res.json() as { error: { correlationId: string } }).error.correlationId).toBe(
        generated,
      );
    }
    await app.close();
  });

  it('a duplicated header is rejected and a missing header gets a generated id', async () => {
    const app = await build();
    const dup = await app.inject({
      method: 'GET',
      url: '/echo',
      headers: { [CORRELATION_HEADER]: [randomUUID(), randomUUID()] as unknown as string },
    });
    expect(dup.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    const none = await app.inject({ method: 'GET', url: '/echo' });
    expect(none.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});

describe('production wiring', () => {
  it('main.ts installs the safe hook and never reads the inbound header itself', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8');
    expect(main).toContain('installCorrelationId(adapter.getInstance())');
    expect(main).not.toMatch(/request\.headers\[CORRELATION_HEADER\]/);
    expect(main).not.toMatch(/\.correlationId\s*=/);
  });
});

/**
 * Characterization of the DOCUMENTED formats (docs/conventions/API-CONVENTIONS.md "Correlation id"): these pin the policy as
 * it is, so a later change to what is accepted is a deliberate, visible edit rather than an accident.
 */
describe('documented accepted / rejected formats', () => {
  const V1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const V4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const V7 = '0191f3a0-7b1c-7d2e-8f3a-4b5c6d7e8f90';

  it('accepts every documented variant: a UUID of any version in either case, and a ULID (up to the maximum ULID)', () => {
    for (const ok of [
      V1,
      V4,
      V7,
      'ffffffff-ffff-ffff-ffff-ffffffffffff', // maximum UUID
      V4.toUpperCase(),
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      '7ZZZZZZZZZZZZZZZZZZZZZZZZZ', // maximum ULID
    ]) {
      expect(isSafeCorrelationId(ok), ok).toBe(true);
    }
  });

  it('replaces every documented unsupported format, including look-alikes of the supported ones', () => {
    const unsupported: Record<string, string> = {
      'nil UUID (an all-zero digit run is Luhn-valid, so it is card-shaped)':
        '00000000-0000-0000-0000-000000000000',
      'ULID with a letter outside the Crockford alphabet (I)': '01ARZ3NDEKTSV4RRFFQ69G5FAI',
      'ULID with a letter outside the Crockford alphabet (L)': '01ARZ3NDEKTSV4RRFFQ69G5FAL',
      'ULID with a letter outside the Crockford alphabet (O)': '01ARZ3NDEKTSV4RRFFQ69G5FAO',
      'ULID with a letter outside the Crockford alphabet (U)': '01ARZ3NDEKTSV4RRFFQ69G5FAU',
      'ULID one character short': '01ARZ3NDEKTSV4RRFFQ69G5FA',
      'ULID one character long': '01ARZ3NDEKTSV4RRFFQ69G5FAVV',
      'UUID without hyphens (32 hex)': V4.replace(/-/g, ''),
      'UUID in braces': `{${V4}}`,
      'UUID as a urn': `urn:uuid:${V4}`,
      'UUID with a trailing newline': `${V4}\n`,
      'UUID with a trailing space': `${V4} `,
      'W3C traceparent value': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'W3C trace-id on its own (32 hex)': '4bf92f3577b34da6a3ce929d0e0e4736',
      'custom prefixed request id': 'req-8f3a2c1d9b7e',
      'short numeric counter': '42',
    };
    for (const [why, value] of Object.entries(unsupported)) {
      expect(isSafeCorrelationId(value), why).toBe(false);
    }
  });

  describe('only x-correlation-id is read: x-request-id, traceparent and tracestate are ignored', () => {
    const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    async function build() {
      const app = Fastify({ genReqId: () => randomUUID() });
      installCorrelationId(app);
      app.get('/echo', (req) => ({ id: (req as { correlationId?: string }).correlationId }));
      await app.ready();
      return app;
    }

    it('x-request-id / traceparent / tracestate alone never become the correlation id and are never echoed', async () => {
      const app = await build();
      const res = await app.inject({
        method: 'GET',
        url: '/echo',
        headers: { 'x-request-id': V4, traceparent: TRACEPARENT, tracestate: 'vendor=abc' },
      });
      const issued = res.headers[CORRELATION_HEADER] as string;
      expect(issued).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(issued).not.toBe(V4); // even a perfectly valid UUID in x-request-id is not used
      expect((res.json() as { id: string }).id).toBe(issued);
      for (const h of ['x-request-id', 'traceparent', 'tracestate']) {
        expect(res.headers[h], h).toBeUndefined();
      }
      expect(res.body + JSON.stringify(res.headers)).not.toContain(
        '4bf92f3577b34da6a3ce929d0e0e4736',
      );
      await app.close();
    });

    it('with a valid x-correlation-id AND the other headers, only x-correlation-id is honoured', async () => {
      const app = await build();
      const res = await app.inject({
        method: 'GET',
        url: '/echo',
        headers: { [CORRELATION_HEADER]: V7, 'x-request-id': V4, traceparent: TRACEPARENT },
      });
      expect(res.headers[CORRELATION_HEADER]).toBe(V7);
      expect((res.json() as { id: string }).id).toBe(V7);
      expect(res.headers['x-request-id']).toBeUndefined();
      expect(res.headers['traceparent']).toBeUndefined();
      await app.close();
    });
  });
});
