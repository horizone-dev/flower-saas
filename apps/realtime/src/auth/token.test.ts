import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { extractToken } from './token.js';

function req(over: { authorization?: string; cookie?: string; query?: unknown }): FastifyRequest {
  return {
    headers: {
      ...(over.authorization !== undefined && { authorization: over.authorization }),
      ...(over.cookie !== undefined && { cookie: over.cookie }),
    },
    query: over.query,
  } as unknown as FastifyRequest;
}

describe('extractToken', () => {
  it('prefers the Authorization: Bearer header', () => {
    expect(extractToken(req({ authorization: 'Bearer abc123' }))).toBe('abc123');
    expect(extractToken(req({ authorization: 'bearer abc123' }))).toBe('abc123'); // case-insensitive
  });

  it('falls back to the flower_access cookie', () => {
    expect(extractToken(req({ cookie: 'other=1; flower_access=xyz789; more=2' }))).toBe('xyz789');
  });

  it('falls back to a ?token= query string', () => {
    expect(extractToken(req({ query: { token: 'qtoken' } }))).toBe('qtoken');
  });

  it('header takes priority over cookie takes priority over query', () => {
    expect(
      extractToken(
        req({ authorization: 'Bearer h', cookie: 'flower_access=c', query: { token: 'q' } }),
      ),
    ).toBe('h');
    expect(extractToken(req({ cookie: 'flower_access=c', query: { token: 'q' } }))).toBe('c');
  });

  it('returns null when nothing is present', () => {
    expect(extractToken(req({}))).toBeNull();
  });

  it('a URL-encoded cookie value is decoded', () => {
    expect(extractToken(req({ cookie: `flower_access=${encodeURIComponent('a b')}` }))).toBe('a b');
  });
});
