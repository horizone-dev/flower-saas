import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * The BullMQ queue set (ARCHITECTURE §49). Processors are attached per phase from
 * the apps/api domain modules — the worker never re-implements a domain rule
 * (CLAUDE.md rule 1).
 */
export const QUEUES = [
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

export type QueueName = (typeof QUEUES)[number];

export function buildQueues(connection: Redis): Map<QueueName, Queue> {
  return new Map(QUEUES.map((name) => [name, new Queue(name, { connection })] as const));
}
