import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { QUEUES, DOMAIN_QUEUES, INFRA_QUEUES, DEAD_LETTER_QUEUE, buildQueues } from './queues.js';

describe('worker queue set', () => {
  it('declares the ARCHITECTURE §49 domain queues + the Phase 2-core infra queues, de-duplicated', () => {
    expect(DOMAIN_QUEUES.length).toBeGreaterThanOrEqual(13);
    expect(QUEUES).toEqual([...DOMAIN_QUEUES, ...INFRA_QUEUES]);
    expect(new Set(QUEUES).size).toBe(QUEUES.length);
    expect(QUEUES).toContain('reservation-expiry');
    expect(QUEUES).toContain('payments-webhooks');
    expect(QUEUES).toContain('probe');
    expect(QUEUES).toContain('stream-retention'); // task 2.8 retention sweep
    expect(INFRA_QUEUES).toEqual(['probe', 'stream-retention', 'dead-letter']);
    expect(QUEUES).toContain(DEAD_LETTER_QUEUE);
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
    expect(queues.get('probe')?.name).toBe('probe');
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
    connection.disconnect();
  });
});
