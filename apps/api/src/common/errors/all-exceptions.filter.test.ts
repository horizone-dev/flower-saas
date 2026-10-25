import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ForbiddenException,
  HttpException,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { makeCanary, scanText } from '../../verification/pci-canary.js';
import { DomainError } from './domain-error.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

const logged = vi.hoisted(() => ({ calls: [] as { level: string; args: unknown[] }[] }));
vi.mock('../logger/logger.js', () => ({
  rootLogger: {
    error: (...args: unknown[]) => logged.calls.push({ level: 'error', args }),
    warn: (...args: unknown[]) => logged.calls.push({ level: 'warn', args }),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * F2 (task 3b.11) — the exception filter logs a SAFE path: no query string, no card-shaped path segment, while the HTTP
 * response, the status, the error code, the correlation id and the matched route pattern are all preserved.
 */

interface Req {
  url: string;
  method?: string;
  correlationId?: string;
  routeOptions?: { url?: string };
}

function run(exception: unknown, req: Req): { status: number; body: unknown } {
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
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, body };
}

const fields = (i = 0): Record<string, unknown> =>
  logged.calls[i]!.args[0] as Record<string, unknown>;

describe('F2 AllExceptionsFilter — log content', () => {
  beforeEach(() => {
    logged.calls.length = 0;
  });

  it('a 4xx logs status, code, correlation id, the pathname WITHOUT its query string, and the route pattern', () => {
    run(new DomainError('NOT_FOUND', 'order not found', 404), {
      url: '/v1/companies/c1/orders/o1?q=secret&token=abc',
      correlationId: 'corr-1',
      routeOptions: { url: '/v1/companies/:companyId/orders/:id' },
    });
    expect(logged.calls).toHaveLength(1);
    expect(logged.calls[0]!.level).toBe('warn');
    expect(fields()).toEqual({
      code: 'NOT_FOUND',
      status: 404,
      correlationId: 'corr-1',
      path: '/v1/companies/c1/orders/o1',
      route: '/v1/companies/:companyId/orders/:id',
    });
    expect(logged.calls[0]!.args[1]).toBe('order not found');
  });

  it('a 5xx logs the error object, correlation id, safe path and route pattern at error level', () => {
    const boom = new Error('boom');
    run(boom, { url: '/v1/x/y?a=1', correlationId: 'corr-2', routeOptions: { url: '/v1/x/:id' } });
    expect(logged.calls[0]!.level).toBe('error');
    expect(fields()).toEqual({
      err: boom,
      correlationId: 'corr-2',
      path: '/v1/x/y',
      route: '/v1/x/:id',
    });
    expect(logged.calls[0]!.args[1]).toBe('unhandled error');
  });

  it('an unmatched route has no pattern; the pathname is still logged (and a missing correlation id stays absent)', () => {
    run(new HttpException('Not Found', 404), { url: '/v1/nope?x=1' });
    expect(fields()).toMatchObject({ status: 404, path: '/v1/nope' });
    expect(fields()['route']).toBeUndefined();
    expect(fields()['correlationId']).toBeUndefined();
  });

  it('a card number in the query string never reaches the logger, in any form', () => {
    const c = makeCanary();
    for (const form of Object.values(c.panForms)) {
      logged.calls.length = 0;
      run(new DomainError('BAD', 'bad request', 400), {
        url: `/v1/catalog/products?q=${form}&cardNumber=${c.pan}#${form}`,
        correlationId: 'corr',
        routeOptions: { url: '/v1/catalog/products' },
      });
      expect(scanText(JSON.stringify(logged.calls), c).map((h) => h.kind)).toEqual([]);
      expect(fields()['path']).toBe('/v1/catalog/products');
    }
  });

  it('a card number in a path segment (unmatched route or a bad id) is masked in the logged path', () => {
    const c = makeCanary();
    for (const seg of [c.pan, c.panForms['dashed']!, encodeURIComponent(c.panForms['spaced']!)]) {
      logged.calls.length = 0;
      run(new HttpException('Not Found', 404), { url: `/v1/${seg}/orders?x=${c.pan}` });
      expect(scanText(JSON.stringify(logged.calls), c).map((h) => h.kind)).toEqual([]);
      expect(fields()['path']).toBe('/v1/[digits]/orders');
    }
    logged.calls.length = 0;
    run(new Error('x'), { url: `/v1/customers/${c.pan}` });
    expect(scanText(JSON.stringify(logged.calls), c).map((h) => h.kind)).toEqual([]);
  });
});

describe('F2 AllExceptionsFilter — the HTTP response is unchanged', () => {
  beforeEach(() => {
    logged.calls.length = 0;
  });

  it('DomainError: status, code, message, details and correlation id are returned exactly as before', () => {
    const { status, body } = run(
      new DomainError('VALIDATION_FAILED', 'the request body is invalid', 400, [
        { field: 'name', issue: 'bad' },
        { issue: 'x' },
      ]),
      { url: '/v1/a?q=1', correlationId: 'corr-3' },
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'the request body is invalid',
        details: [{ field: 'name', issue: 'bad' }, { issue: 'x' }],
        correlationId: 'corr-3',
      },
    });
  });

  it('HttpException and unknown errors keep their mapped status, code and generic message', () => {
    expect(run(new HttpException('Forbidden', 403), { url: '/v1/a' })).toEqual({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
    });
    expect(run(new Error('internal detail'), { url: '/v1/a', correlationId: 'c' })).toEqual({
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          correlationId: 'c',
        },
      },
    });
  });
});

describe('F2b AllExceptionsFilter — the router’s unmatched-route message', () => {
  beforeEach(() => {
    logged.calls.length = 0;
  });

  /** exactly what @nestjs/core's registerNotFoundHandler throws: `Cannot ${method} ${url}` with the RAW request target */
  const unmatched = (method: string, url: string): HttpException =>
    new NotFoundException(`Cannot ${method} ${url}`);
  const run404 = (method: string, url: string): { status: number; body: unknown } =>
    run(unmatched(method, url), { url, method, correlationId: 'corr-404' });
  const bodyMessage = (b: unknown): string => (b as { error: { message: string } }).error.message;
  const loggedText = (): string => JSON.stringify(logged.calls);

  it('an ordinary unmatched route keeps its diagnostic: same status, code, envelope, correlation id and "Cannot <METHOD> <path>"', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      logged.calls.length = 0;
      const { status, body } = run404(method, '/v1/does/not/exist');
      expect(status).toBe(404);
      expect(body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: `Cannot ${method} /v1/does/not/exist`,
          correlationId: 'corr-404',
        },
      });
      expect(logged.calls[0]!.level).toBe('warn');
      expect(logged.calls[0]!.args[1]).toBe(`Cannot ${method} /v1/does/not/exist`);
      expect(fields()).toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
        correlationId: 'corr-404',
        path: '/v1/does/not/exist',
      });
    }
  });

  it('the query string and fragment are dropped from both the response body and the log message', () => {
    const { body } = run404('GET', '/v1/nope?token=abc&x=1#frag');
    expect(bodyMessage(body)).toBe('Cannot GET /v1/nope');
    expect(logged.calls[0]!.args[1]).toBe('Cannot GET /v1/nope');
    expect(loggedText()).not.toMatch(/token|abc|frag/);
  });

  it('a card number in the unmatched path — every form — is in neither the response body nor any logged value', () => {
    const c = makeCanary();
    const fullWidth = [...c.pan].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    const arabicIndic = [...c.pan].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
    const forms: Record<string, string> = {
      plain: c.pan,
      dashed: c.panForms['dashed']!,
      dotted: c.panForms['dotted']!,
      spacedEncoded: encodeURIComponent(c.panForms['spaced']!),
      percentDigits: [...c.pan].map((d) => `%3${d}`).join(''),
      fullWidthEncoded: encodeURIComponent(fullWidth),
      arabicIndicEncoded: encodeURIComponent(arabicIndic),
      zeroWidthSplitEncoded: encodeURIComponent([...c.pan].join('​')),
      tagged: encodeURIComponent(c.tagged.pan),
    };
    const seen = (text: string): string => {
      let decoded = text;
      try {
        decoded = decodeURIComponent(text);
      } catch {
        /* read as is */
      }
      const folded = decoded
        .normalize('NFKC')
        .replace(new RegExp('[\u200b-\u200d\u2060\ufeff]', 'g'), '');
      return `${text}\n${folded}`;
    };
    for (const [name, seg] of Object.entries(forms)) {
      for (const [method, url] of [
        ['GET', `/${seg}`],
        ['GET', `/v1/${seg}`],
        ['GET', `/v1/x/${seg}/y?q=${c.pan}`],
        ['POST', `/v1/x/${seg}`],
        ['DELETE', `/v1/${seg}?q=${c.pan}`],
      ] as const) {
        logged.calls.length = 0;
        const { status, body } = run404(method, url);
        expect(status, name).toBe(404);
        for (const [where, text] of [
          ['response body', JSON.stringify(body)],
          ['logged values', loggedText()],
        ] as const) {
          const view = seen(text);
          expect(
            scanText(view, c)
              .map((h) => h.kind)
              .filter((k) => k !== 'marker'),
            `${name} ${where}`,
          ).toEqual([]);
          // the marker is only the test's label (its 12 random hex chars may contain digits) — judge the rest
          expect(
            /\p{Nd}{8,}/u.test(view.split(c.marker).join('')),
            `${name} ${where}: a long digit run survived`,
          ).toBe(false);
        }
        expect(bodyMessage(body).startsWith(`Cannot ${method} /`)).toBe(true); // still a readable diagnostic
      }
    }
  });

  it('only the router’s own unmatched-route message is rewritten: other 404s, other statuses and DomainErrors keep their text', () => {
    expect(
      bodyMessage(
        run(new NotFoundException('Order not found'), { url: '/v1/x?y=1', method: 'GET' }).body,
      ),
    ).toBe('Order not found');
    expect(
      bodyMessage(
        run(new DomainError('NOT_FOUND', 'Cannot GET the thing', 404), {
          url: '/v1/x?y=1',
          method: 'GET',
        }).body,
      ),
    ).toBe('Cannot GET the thing');
    const forbidden = run(new ForbiddenException('Cannot GET /v1/x?y=1'), {
      url: '/v1/x?y=1',
      method: 'GET',
    });
    expect(forbidden.status).toBe(403);
    expect(bodyMessage(forbidden.body)).toBe('Cannot GET /v1/x?y=1'); // a 403 is not an unmatched route: untouched
  });

  it('a missing correlation id and a missing route pattern stay absent; the diagnostics of the log line are otherwise complete', () => {
    run(unmatched('GET', '/v1/zzz'), { url: '/v1/zzz', method: 'GET' });
    expect(fields()).toEqual({
      code: 'NOT_FOUND',
      status: 404,
      correlationId: undefined,
      path: '/v1/zzz',
      route: undefined,
    });
  });
});
