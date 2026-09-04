import { describe, it, expect } from 'vitest';
import { nextAvailableAt, sanitizeError, DEFAULT_PUBLISH_BACKOFF } from './backoff.js';

describe('nextAvailableAt', () => {
  it('grows exponentially with attempts, capped at maxMs', () => {
    const policy = { baseMs: 100, maxMs: 1_000 };
    const now = Date.now();
    const delay = (attempts: number): number => nextAvailableAt(attempts, policy).getTime() - now;

    expect(delay(1)).toBeGreaterThanOrEqual(90);
    expect(delay(1)).toBeLessThan(150);
    expect(delay(2)).toBeGreaterThanOrEqual(190);
    expect(delay(3)).toBeGreaterThanOrEqual(390);
    // capped — attempts=10 would be 100*2^9=51200ms uncapped, must clamp to 1000
    expect(delay(10)).toBeLessThanOrEqual(1_050);
  });

  it('uses DEFAULT_PUBLISH_BACKOFF when no policy is given', () => {
    const now = Date.now();
    const at = nextAvailableAt(1).getTime();
    expect(at - now).toBeGreaterThanOrEqual(DEFAULT_PUBLISH_BACKOFF.baseMs - 20);
  });

  it('never returns a delay below zero for attempts=0 (defensive floor)', () => {
    const now = Date.now();
    expect(nextAvailableAt(0).getTime()).toBeGreaterThanOrEqual(now - 5);
  });
});

describe('sanitizeError', () => {
  it('strips credentials embedded in a connection-string-shaped message (never leak a secret)', () => {
    const msg = sanitizeError(
      new Error('connect ECONNREFUSED redis://default:s3cr3t-pw@10.0.0.5:6379'),
    );
    expect(msg).not.toContain('s3cr3t-pw');
    expect(msg).toContain('redis://[redacted]@10.0.0.5:6379');
  });

  it('handles a postgres-style URI too', () => {
    const msg = sanitizeError(new Error('failed: postgres://app:hunter2@db.internal:5432/flower'));
    expect(msg).not.toContain('hunter2');
  });

  it('caps length so a pathological error cannot blow past a reasonable column size', () => {
    const msg = sanitizeError(new Error('x'.repeat(10_000)));
    expect(msg.length).toBeLessThanOrEqual(501);
  });

  it('stringifies a non-Error thrown value', () => {
    expect(sanitizeError('a plain string failure')).toBe('a plain string failure');
  });
});
