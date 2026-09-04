import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * The BullMQ queue set.
 *
 * `DOMAIN_QUEUES` (ARCHITECTURE §49) are declared up front so the topology is
 * visible, but a queue only gets a running `Worker` when a processor is
 * registered for it (see `ProcessorRegistry`). Domain processors attach in their
 * own phases — the worker never re-implements a domain rule (CLAUDE.md rule 1).
 *
 * `INFRA_QUEUES` are the cross-cutting queues Phase 2-core owns:
 *   - `probe`        — a trivial round-trip that proves the framework.
 *   - `dead-letter`  — the landing zone for a job that exhausted its retries.
 */
export const DOMAIN_QUEUES = [
  'notifications',
  'documents',
  'payments-webhooks',
  'reconciliation',
  'reporting-rollups',
  'ai',
  'whatsapp',
  'attendance-ingest',
  'exports',
  'reservation-expiry',
  'subscription-generation',
  'commission-calc',
  'cache-invalidation',
] as const;

export const INFRA_QUEUES = ['probe', 'dead-letter'] as const;

export const QUEUES = [...DOMAIN_QUEUES, ...INFRA_QUEUES] as const;

export type QueueName = (typeof QUEUES)[number];

export const DEAD_LETTER_QUEUE: QueueName = 'dead-letter';

/** Build a `Queue` handle for each name (no eager connection). */
export function buildQueues(
  connection: Redis,
  names: readonly QueueName[] = QUEUES,
): Map<QueueName, Queue> {
  return new Map(names.map((name) => [name, new Queue(name, { connection })] as const));
}
