import type { Redis } from 'ioredis';
import { liveChannel, streamKey } from '@flower/backend';

const GROUP = 'relay';
const STREAM_PREFIX = 'rt:stream:';
const ENVELOPE_FIELD = 'event';

export interface RelayOptions {
  /** unique per relay process instance — used only for `XPENDING` observability;
   *  correctness (no lost event across a restart) comes from `XAUTOCLAIM`, which
   *  reclaims a stale entry regardless of which consumer name originally held
   *  it, so this name need not be stable across restarts. */
  readonly consumerName: string;
  /** an entry pending (delivered, unacked) for at least this long is reclaimed
   *  — covers a crashed relay (task 2.5 demonstration 7). */
  readonly minIdleMs?: number;
  readonly batchSize?: number;
  readonly tenantScanCount?: number;
}

const DEFAULTS = { minIdleMs: 30_000, batchSize: 50, tenantScanCount: 100 };

/**
 * Discover tenants with a durable Stream via a plain Redis `SCAN` over
 * `rt:stream:*` — **never** a Postgres query. OI-P2-2 (owner-approved,
 * 2026-09-04): the relay is background-consumer work that must not duplicate
 * the task 2.4 outbox dispatcher's responsibilities; it is a pure Redis
 * consumer of the stream the dispatcher already produced, with no dependency
 * on `packages/db` / Postgres at all.
 */
export async function discoverTenantStreams(redis: Redis, count = 100): Promise<string[]> {
  const tenantIds = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${STREAM_PREFIX}*`, 'COUNT', count);
    cursor = next;
    for (const k of keys) {
      const id = k.slice(STREAM_PREFIX.length);
      if (id) tenantIds.add(id);
    }
  } while (cursor !== '0');
  return [...tenantIds];
}

async function ensureGroup(redis: Redis, tenantId: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', streamKey(tenantId), GROUP, '0', 'MKSTREAM');
  } catch (err) {
    // BUSYGROUP = the group already exists — idempotent create, not an error.
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

type StreamEntry = [id: string, fields: string[]];

function extractEnvelopeJson(fields: string[]): string | null {
  const idx = fields.indexOf(ENVELOPE_FIELD);
  return idx >= 0 ? (fields[idx + 1] ?? null) : null;
}

async function publishEntries(
  redis: Redis,
  channel: string,
  key: string,
  entries: StreamEntry[],
): Promise<number> {
  let n = 0;
  for (const [id, fields] of entries) {
    const json = extractEnvelopeJson(fields);
    if (json !== null) {
      // Forward the envelope VERBATIM — the relay never re-derives or
      // re-parses routing metadata (branch_id/tenant_id/etc.) from anything;
      // it republishes exactly the trusted bytes the task 2.4 dispatcher
      // `XADD`ed (the same discipline the 2.4 remediation proved for the
      // dispatcher itself, carried forward here by construction — this
      // function never even looks at the field values beyond copying them).
      await redis.publish(channel, json);
      n++;
    }
    await redis.xack(key, GROUP, id);
  }
  return n;
}

/**
 * Relay every currently-eligible entry for one tenant: claim anything stale
 * first — a crashed relay's still-pending, unacked deliveries (`XAUTOCLAIM`,
 * so a restart never loses an event — task 2.5 demonstration 7) — then read
 * genuinely new entries (`XREADGROUP ... >`). A relay restart may re-publish
 * an already-published entry (its `XACK` never landed before the crash) —
 * **duplicate live delivery is acceptable** and is dropped downstream by
 * `event_id` (task 2.5 demonstration 8, `apps/realtime`'s per-tenant recent-ids
 * cache).
 */
export async function relayTenant(
  redis: Redis,
  tenantId: string,
  opts: RelayOptions,
): Promise<number> {
  const minIdleMs = opts.minIdleMs ?? DEFAULTS.minIdleMs;
  const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
  await ensureGroup(redis, tenantId);
  const key = streamKey(tenantId);
  const channel = liveChannel(tenantId);

  let published = 0;

  const claimed = (await redis.xautoclaim(
    key,
    GROUP,
    opts.consumerName,
    minIdleMs,
    '0',
    'COUNT',
    batchSize,
  )) as [string, StreamEntry[], string[]?];
  published += await publishEntries(redis, channel, key, claimed[1]);

  const read = (await redis.xreadgroup(
    'GROUP',
    GROUP,
    opts.consumerName,
    'COUNT',
    batchSize,
    'STREAMS',
    key,
    '>',
  )) as [string, StreamEntry[]][] | null;
  if (read) {
    for (const [, entries] of read) {
      published += await publishEntries(redis, channel, key, entries);
    }
  }

  return published;
}

export interface RelayTickResult {
  readonly tenantsSeen: number;
  readonly published: number;
}

/** One relay tick across every discovered tenant stream. */
export async function relayTick(redis: Redis, opts: RelayOptions): Promise<RelayTickResult> {
  const tenantIds = await discoverTenantStreams(
    redis,
    opts.tenantScanCount ?? DEFAULTS.tenantScanCount,
  );
  let published = 0;
  for (const tenantId of tenantIds) {
    published += await relayTenant(redis, tenantId, opts);
  }
  return { tenantsSeen: tenantIds.length, published };
}
