import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { QUEUES, buildQueues } from './queues.js';

describe('worker queue set', () => {
  it('declares the ARCHITECTURE §49 queues, de-duplicated', () => {
    expect(QUEUES.length).toBeGreaterThanOrEqual(13);
    expect(new Set(QUEUES).size).toBe(QUEUES.length);
    expect(QUEUES).toContain('reservation-expiry');
    expect(QUEUES).toContain('payments-webhooks');
  });

  it('buildQueues creates one Queue per name (no eager connection)', async () => {
    const connection = new Redis({
      host: '127.0.0.1',
      port: 59955,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    const queues = buildQueues(connection);
    expect(queues.size).toBe(QUEUES.length);
    expect(queues.get('ai')?.name).toBe('ai');
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
    connection.disconnect();
  });
});
