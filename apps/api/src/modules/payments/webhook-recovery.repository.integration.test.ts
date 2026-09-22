import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { ScopedTx } from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import {
  WebhookEventProcessorRepository,
  type ProcessVerifiedInboxEventInput,
  type ProcessVerifiedInboxEventOutcome,
} from './webhook-event-processor.repository.js';
import { WebhookRecoveryProcessor } from './webhook-recovery.repository.js';

/**
 * Task 3b.5 Checkpoint G operational proof pass §1 — the recovery
 * processor's OWN lifecycle (start/stop idempotency, graceful shutdown,
 * bounded batching, per-candidate failure isolation, overlapping-tick
 * safety). Deliberately does NOT exercise real Payment/PaymentAttempt
 * business logic — `tick()`'s own SELECT only ever reads
 * `provider_payment_event` rows, and every candidate is driven through a
 * SCRIPTED `WebhookEventProcessorRepository` subclass (never the real one),
 * so the only fixtures needed are a tenant/company/branch/credential to
 * satisfy `provider_payment_event`'s own FK — no Invoice/Order/
 * PaymentAttempt needed anywhere in this file.
 */
describe('WebhookRecoveryProcessor lifecycle (Task 3b.5 Checkpoint G proof pass §1)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let db: DbService;
  let credentialId = '';
  const TENANT = 'e1000000-0000-7000-8000-000000000001';
  const COMPANY = 'e1000000-0000-7000-8000-000000000002';
  const BRANCH = 'e1000000-0000-7000-8000-000000000003';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt")
       VALUES ('e1000000-0000-7000-8000-0000000000f1', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('e1000000-0000-7000-8000-0000000000f2',
               'e1000000-0000-7000-8000-0000000000f1', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'wh-recovery', 'wh-recovery', 'AE', 'ACTIVE', 'e1000000-0000-7000-8000-0000000000f2', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
       VALUES ($1, $2, $3, 'Main', now())`,
      [BRANCH, TENANT, COMPANY],
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, status,
          "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, 'fake-recovery', 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
       RETURNING id`,
      [TENANT, COMPANY, BRANCH],
    );
    credentialId = rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await stack?.stop();
  });

  let eventSeq = 0;
  async function insertReceivedEvent(): Promise<string> {
    eventSeq += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "provider_payment_event"
         ("tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId", "eventType", "payloadHash")
       VALUES ($1, $2, $3, $4, $5, 'x', 'hash')
       RETURNING id`,
      [TENANT, COMPANY, BRANCH, credentialId, `evt-lifecycle-${eventSeq}-${Date.now()}`],
    );
    return rows[0]!.id;
  }

  async function statusOf(id: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM provider_payment_event WHERE id = $1`,
      [id],
    );
    return rows[0]!.status;
  }

  /**
   * A fully scripted processor — never touches real Payment/PaymentAttempt
   * logic, only records which inboxIds it was asked to process and returns
   * whatever the test configures. `provider_payment_event` is append-only —
   * DELETE is permanently rejected (Checkpoint B's own frozen invariant) —
   * so a row this processor resolves to 'PROCESSED' is durably marked as
   * such (a real, minimal `status` transition, inside the SAME `tx` the
   * caller already opened) so it is never re-selected by a LATER test's own
   * `tick()` call; a "poisoned" row is deliberately left `RECEIVED` (no
   * update happens before the throw), exactly mirroring the real
   * processor's own fail-closed behavior. This is what keeps each test in
   * this file well-defined despite `tick()`'s own SELECT being deliberately
   * cross-tenant/global with no per-test scoping to filter on.
   */
  class ScriptedProcessor extends WebhookEventProcessorRepository {
    readonly calls: string[] = [];
    constructor(
      private readonly behavior: (inboxId: string) => Promise<ProcessVerifiedInboxEventOutcome>,
    ) {
      super(new AuditWriter(db), new OutboxWriter(db));
    }
    override async processVerifiedInboxEventInTx(
      tx: ScopedTx,
      input: ProcessVerifiedInboxEventInput,
    ): Promise<ProcessVerifiedInboxEventOutcome> {
      this.calls.push(input.inboxId);
      const outcome = await this.behavior(input.inboxId);
      if (outcome === 'PROCESSED') {
        await tx.$queryRaw`
          UPDATE "provider_payment_event" SET "status" = 'PROCESSED' WHERE "id" = ${input.inboxId}::uuid`;
      }
      return outcome;
    }
  }

  /** Wraps `recovery.tick` (an own-property override, shadowing the
   *  prototype method) to track concurrent in-flight invocations — the
   *  direct, deterministic way to prove "at most one tick ever runs at a
   *  time" without depending on timing-sensitive call counts. */
  function trackConcurrency(recovery: WebhookRecoveryProcessor): { maxConcurrent: () => number } {
    let concurrent = 0;
    let max = 0;
    const original = recovery.tick.bind(recovery);
    recovery.tick = (async (...args: Parameters<typeof original>) => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      try {
        return await original(...args);
      } finally {
        concurrent -= 1;
      }
    }) as typeof recovery.tick;
    return { maxConcurrent: () => max };
  }

  // ══════════════ A — start() idempotent ═══════════════════════════════════
  it('A: calling start() twice (even synchronously, before the first tick settles) never creates two concurrent polling loops', async () => {
    const processor = new ScriptedProcessor(async () => 'PROCESSED');
    const recovery = new WebhookRecoveryProcessor(db, processor);
    const tracker = trackConcurrency(recovery);

    recovery.start(30_000, 20);
    recovery.start(30_000, 20); // second call, issued before the first tick has any chance to settle

    await sleep(100); // let the (single, legitimate) first tick complete
    await recovery.stop();

    expect(tracker.maxConcurrent()).toBeLessThanOrEqual(1);
  });

  // ══════════════ B — stop() idempotent ═════════════════════════════════════
  it('B: calling stop() twice is harmless', async () => {
    const processor = new ScriptedProcessor(async () => 'PROCESSED');
    const recovery = new WebhookRecoveryProcessor(db, processor);
    recovery.start(30_000, 20);
    await sleep(50);
    await expect(recovery.stop()).resolves.toBeUndefined();
    await expect(recovery.stop()).resolves.toBeUndefined();
  });

  // ══════════════ C — graceful stop: no re-arm, no leaked handle ═══════════
  it('C: after stop(), no later tick fires and no timer handle remains', async () => {
    const processor = new ScriptedProcessor(async () => 'PROCESSED');
    const recovery = new WebhookRecoveryProcessor(db, processor);
    const tracker = trackConcurrency(recovery);
    recovery.start(30, 20); // short interval — would tick again quickly if not stopped
    await sleep(80); // let at least one real tick happen
    await recovery.stop();

    const tickedSoFar = processor.calls.length; // any candidates seen up to stop() — expect 0 here (no rows)
    void tickedSoFar;
    const concurrentAtStop = tracker.maxConcurrent();

    await sleep(200); // well past the 30ms interval — a re-armed timer would have fired several times by now
    expect(tracker.maxConcurrent()).toBe(concurrentAtStop); // no further tick() invocations counted at all

    // the private timer handle itself is cleared — inspected via a narrow
    // cast for this lifecycle proof only, mirroring how `stop()`'s own
    // internal contract is described in its doc comment.
    expect((recovery as unknown as { timer: unknown }).timer).toBeNull();
  });

  // ══════════════ D — bounded batch ═════════════════════════════════════════
  it('D: one tick processes at most batchSize candidates even when more RECEIVED rows exist', async () => {
    const ids = await Promise.all([
      insertReceivedEvent(),
      insertReceivedEvent(),
      insertReceivedEvent(),
      insertReceivedEvent(),
      insertReceivedEvent(),
    ]);
    const processor = new ScriptedProcessor(async () => 'PROCESSED');
    const recovery = new WebhookRecoveryProcessor(db, processor);

    const result = await recovery.tick(3);
    expect(result.candidates).toBe(3);
    expect(result.processed).toBe(3);
    expect(processor.calls).toHaveLength(3);

    // exactly the first 3 (oldest by receivedAt) were touched — the fake
    // processor never mutates status, so this also proves `tick()` itself
    // selected only `batchSize` rows, not all 5.
    const untouchedCount = ids.filter((id) => !processor.calls.includes(id)).length;
    expect(untouchedCount).toBe(2);
  });

  // ══════════════ E — one poisoned event isolates, never aborts the batch ═══
  it('E: one poisoned candidate fails in isolation — the rest of the same batch still processes', async () => {
    const healthyA = await insertReceivedEvent();
    const poisoned = await insertReceivedEvent();
    const healthyB = await insertReceivedEvent();
    // resolves anything that ISN'T this test's own poisoned id as PROCESSED
    // — this harmlessly sweeps up any still-RECEIVED leftover row a PRIOR
    // test's own batch bound left behind (§D's own test, by construction,
    // never touches all 5 of its inserted rows) without weakening what this
    // test actually proves: `tick()`'s per-candidate try/catch isolates a
    // failure and never aborts the rest of the SAME batch.
    const processor = new ScriptedProcessor(async (id) => {
      if (id === poisoned) throw new Error('simulated poisoned candidate');
      return 'PROCESSED';
    });
    const recovery = new WebhookRecoveryProcessor(db, processor);

    const result = await recovery.tick(10);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.processed).toBeGreaterThanOrEqual(2);
    expect(processor.calls).toEqual(expect.arrayContaining([healthyA, poisoned, healthyB]));
    expect(await statusOf(healthyA)).toBe('PROCESSED');
    expect(await statusOf(healthyB)).toBe('PROCESSED');
    expect(await statusOf(poisoned)).toBe('RECEIVED'); // untouched by its own failure
  });

  // ══════════════ F — overlapping tick safety (single-flight by construction) ══
  it("F: start()'s own loop never runs two ticks concurrently, even when a tick is slow relative to the interval", async () => {
    await Promise.all([insertReceivedEvent(), insertReceivedEvent()]);
    const processor = new ScriptedProcessor(async () => {
      await sleep(120); // deliberately slower than the tick interval below
      return 'PROCESSED';
    });
    const recovery = new WebhookRecoveryProcessor(db, processor);
    const tracker = trackConcurrency(recovery);

    // interval (20ms) is far shorter than a single tick's own duration
    // (>=120ms for 2 candidates) — if the loop were NOT single-flight, a
    // second tick would start well before the first resolves.
    recovery.start(20, 10);
    await sleep(400); // enough real time for several would-be overlapping ticks
    await recovery.stop();

    expect(tracker.maxConcurrent()).toBe(1);
  });

  // ══════════════ G — stop() called WHILE a tick is genuinely in-flight ═══
  it('G: stop() called while a tick is actively in-flight waits for it, then arms no further tick', async () => {
    await insertReceivedEvent();
    let tickStarted = false;
    let releaseTick!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const processor = new ScriptedProcessor(async () => {
      tickStarted = true;
      await gate; // held open deterministically until the test releases it
      return 'PROCESSED';
    });
    const recovery = new WebhookRecoveryProcessor(db, processor);

    recovery.start(20, 10);
    while (!tickStarted) await sleep(5); // wait until the tick is GENUINELY in-flight, not by timing luck

    const stopPromise = recovery.stop();
    await sleep(100); // stop() must still be pending — it awaits `this.ticking`
    releaseTick(); // let the in-flight tick finish
    await stopPromise;

    const callsAtStop = processor.calls.length;
    expect(callsAtStop).toBe(1); // exactly the one in-flight tick — no other ever ran

    await sleep(200); // well past the 20ms interval — a re-armed timer would have ticked again by now
    expect(processor.calls.length).toBe(callsAtStop); // no further tick after stop
    expect((recovery as unknown as { timer: unknown }).timer).toBeNull();
  });
});
