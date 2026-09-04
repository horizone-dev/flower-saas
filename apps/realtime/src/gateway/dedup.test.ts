import { describe, it, expect } from 'vitest';
import { RecentEventIds } from './dedup.js';

describe('RecentEventIds', () => {
  it('returns true the first time an id is seen, false on every repeat', () => {
    const c = new RecentEventIds(10);
    expect(c.offer('a')).toBe(true);
    expect(c.offer('a')).toBe(false);
    expect(c.offer('a')).toBe(false);
    expect(c.offer('b')).toBe(true);
  });

  it('evicts the oldest id once over capacity, forgetting it', () => {
    const c = new RecentEventIds(2);
    expect(c.offer('a')).toBe(true);
    expect(c.offer('b')).toBe(true);
    expect(c.offer('c')).toBe(true); // evicts 'a'
    expect(c.offer('a')).toBe(true); // 'a' forgotten — treated as new again
    expect(c.offer('c')).toBe(false); // 'c' still remembered
  });
});
