import { describe, expect, it } from 'vitest';
import { canonicalize, requestHash, type RequestHashParts } from './canonical-hash.js';

const base: RequestHashParts = {
  method: 'POST',
  routePattern: '/v1/orders',
  pathParams: {},
  query: {},
  scope: 'orders.create',
  tenantId: '00000000-0000-7000-8000-00000000t001',
  principalId: '00000000-0000-7000-8000-00000000u001',
  body: { a: 1, b: 2 },
};

describe('canonicalize', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toEqual({ a: { c: 3, d: 4 }, b: 1 });
  });
  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
  });
  it('drops undefined values', () => {
    expect(canonicalize({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});

describe('requestHash', () => {
  it('is stable across object-key order and whitespace', () => {
    const h1 = requestHash({ ...base, body: { a: 1, b: 2, nested: { x: 1, y: 2 } } });
    const h2 = requestHash({ ...base, body: { nested: { y: 2, x: 1 }, b: 2, a: 1 } });
    expect(h1).toBe(h2);
  });

  it('is a 64-char hex sha256', () => {
    expect(requestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a body value changes', () => {
    expect(requestHash({ ...base, body: { a: 1, b: 2 } })).not.toBe(
      requestHash({ ...base, body: { a: 1, b: 3 } }),
    );
  });

  it('changes when array order changes (arrays are semantic)', () => {
    expect(requestHash({ ...base, body: { items: [1, 2] } })).not.toBe(
      requestHash({ ...base, body: { items: [2, 1] } }),
    );
  });

  it('is method-case-insensitive', () => {
    expect(requestHash({ ...base, method: 'post' })).toBe(requestHash({ ...base, method: 'POST' }));
  });

  it('separates tenant, principal, scope, route, params and query', () => {
    const h = requestHash(base);
    expect(requestHash({ ...base, tenantId: 'x' })).not.toBe(h);
    expect(requestHash({ ...base, principalId: 'x' })).not.toBe(h);
    expect(requestHash({ ...base, scope: 'orders.other' })).not.toBe(h);
    expect(requestHash({ ...base, routePattern: '/v1/other' })).not.toBe(h);
    expect(requestHash({ ...base, pathParams: { id: '1' } })).not.toBe(h);
    expect(requestHash({ ...base, query: { force: 'true' } })).not.toBe(h);
  });

  it('treats a missing body and null identically, and both differ from {}', () => {
    const nullBody = requestHash({ ...base, body: null });
    expect(requestHash({ ...base, body: undefined })).toBe(nullBody);
    expect(requestHash({ ...base, body: {} })).not.toBe(nullBody);
  });
});
