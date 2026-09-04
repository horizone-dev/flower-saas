import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, scrubSensitive } from './snapshot.js';

describe('scrubSensitive', () => {
  it('redacts sensitive-looking keys, keeps the rest', () => {
    const out = scrubSensitive({
      orderId: 'ord_1',
      accessToken: 'sk_live_abc',
      access_token: 'x',
      refreshToken: 'y',
      api_key: 'k',
      nested: { password: 'p', name: 'ok', client_secret: 's' },
      list: [{ token: 't', label: 'keep' }],
    }) as Record<string, unknown>;
    expect(out).toEqual({
      orderId: 'ord_1',
      accessToken: '[redacted]',
      access_token: '[redacted]',
      refreshToken: '[redacted]',
      api_key: '[redacted]',
      nested: { password: '[redacted]', name: 'ok', client_secret: '[redacted]' },
      list: [{ token: '[redacted]', label: 'keep' }],
    });
  });

  it('does not over-match (e.g. "tokenizer", "authored")', () => {
    const out = scrubSensitive({ tokenizer: 'v', authored_by: 'u' }) as Record<string, unknown>;
    expect(out).toEqual({ tokenizer: 'v', authored_by: 'u' });
  });
});

describe('buildSnapshot', () => {
  const MAX = 1024;

  it('stores a scrubbed plain body', () => {
    const r = buildSnapshot({ ok: true, secret: 's' }, MAX);
    expect(r).toEqual({ stored: true, body: { ok: true, secret: '[redacted]' } });
  });

  it('stores null for an undefined body', () => {
    expect(buildSnapshot(undefined, MAX)).toEqual({ stored: true, body: null });
  });

  it('does not store a body over the size limit', () => {
    const r = buildSnapshot({ blob: 'x'.repeat(2000) }, MAX);
    expect(r).toEqual({ stored: false, reason: 'too-large' });
  });

  it('does not store a Buffer / typed array', () => {
    expect(buildSnapshot(Buffer.from('hi'), MAX)).toEqual({ stored: false, reason: 'binary' });
    expect(buildSnapshot(new Uint8Array([1, 2]), MAX)).toEqual({ stored: false, reason: 'binary' });
  });

  it('does not store a stream / StreamableFile-like value', () => {
    expect(buildSnapshot(Readable.from(['a']), MAX)).toEqual({ stored: false, reason: 'stream' });
    expect(buildSnapshot({ getStream: () => Readable.from(['a']) }, MAX)).toEqual({
      stored: false,
      reason: 'stream',
    });
  });

  it('does not store a circular / non-serialisable value', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(buildSnapshot(circular, MAX)).toEqual({ stored: false, reason: 'non-serialisable' });
  });
});
