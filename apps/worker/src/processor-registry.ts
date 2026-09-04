import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  type Logger,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  jobOptions,
} from '@flower/service-runtime';
import { DEAD_LETTER_QUEUE, type QueueName } from './queues.js';

/** What a processor receives alongside the BullMQ job. */
export interface JobContext {
  readonly logger: Logger;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;

export interface ProcessorRegistration {
  readonly queue: QueueName;
  readonly handler: JobHandler;
  /** worker concurrency for this queue (default 1) */
  readonly concurrency?: number;
}

/** The shape of a dead-letter record (constraint 5 / constraint 8). */
export interface DeadLetter {
  readonly queue: string;
  readonly jobId: string;
  readonly name: string;
  readonly data: unknown;
  readonly failedReason: string;
  readonly attemptsMade: number;
  readonly failedAt: string;
}

/**
 * The processor framework (constraint 5). Bind a handler to a queue with
 * `register`, then `start` opens one BullMQ `Worker` per registered queue. Every
 * job carries the shared retry / backoff policy (`@flower/service-runtime`
 * `jobOptions`); a job that **exhausts its attempts** is copied to the
 * `dead-letter` queue with a failure summary so the original queue keeps flowing.
 *
 * No business logic lives here — a handler orchestrates `@flower/backend`
 * services (CLAUDE.md rule 1).
 */
export class ProcessorRegistry {
  private readonly registrations = new Map<QueueName, ProcessorRegistration>();
  private readonly workers: Worker[] = [];
  private readonly producers = new Map<QueueName, Queue>();
  private deadLetter: Queue | null = null;
  private connection: Redis | null = null;

  constructor(private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY) {}

  register(reg: ProcessorRegistration): this {
    if (this.registrations.has(reg.queue)) {
      throw new Error(`a processor is already registered for queue "${reg.queue}"`);
    }
    if (reg.queue === DEAD_LETTER_QUEUE) {
      throw new Error('the dead-letter queue must not have a processor');
    }
    this.registrations.set(reg.queue, reg);
    return this;
  }

  get registeredQueues(): QueueName[] {
    return [...this.registrations.keys()];
  }

  /** Open a `Worker` for every registered queue. Call once. */
  start(connection: Redis, logger: Logger): void {
    if (this.workers.length > 0) throw new Error('ProcessorRegistry already started');
    this.connection = connection;
    this.deadLetter = new Queue(DEAD_LETTER_QUEUE, { connection });

    for (const reg of this.registrations.values()) {
      const child = logger.child({ queue: reg.queue });
      const worker = new Worker(
        reg.queue,
        (job) => reg.handler(job, { logger: child.child({ jobId: job.id, jobName: job.name }) }),
        { connection, concurrency: reg.concurrency ?? 1 },
      );

      worker.on('failed', (job, err) => {
        if (!job) {
          child.error({ err }, 'job failed with no job reference');
          return;
        }
        const attempts = job.opts.attempts ?? this.retryPolicy.attempts;
        const exhausted = job.attemptsMade >= attempts;
        child.warn(
          { jobId: job.id, attemptsMade: job.attemptsMade, attempts, exhausted, err: err.message },
          exhausted ? 'job exhausted retries — dead-lettering' : 'job failed — will retry',
        );
        if (exhausted) void this.toDeadLetter(job, err);
      });

      worker.on('error', (err) => child.error({ err }, 'worker error'));
      this.workers.push(worker);
    }

    logger.info({ queues: this.registeredQueues }, 'processors started');
  }

  /**
   * Enqueue a job with the framework's default retry / backoff policy applied.
   * Used by `apps/scheduler` (repeatable jobs) and by tests.
   */
  async enqueue(queue: QueueName, jobName: string, data: unknown): Promise<string> {
    if (!this.connection) throw new Error('ProcessorRegistry not started');
    let producer = this.producers.get(queue);
    if (!producer) {
      producer = new Queue(queue, { connection: this.connection });
      this.producers.set(queue, producer);
    }
    const job = await producer.add(jobName, data, jobOptions(this.retryPolicy));
    return String(job.id);
  }

  private async toDeadLetter(job: Job, err: Error): Promise<void> {
    if (!this.deadLetter) return;
    const record: DeadLetter = {
      queue: job.queueName,
      jobId: String(job.id),
      name: job.name,
      data: job.data,
      failedReason: err.message,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };
    await this.deadLetter.add('dead-letter', record, { removeOnComplete: false });
  }

  /**
   * Graceful stop — `worker.close()` waits for the in-flight job on each worker
   * to finish (or its lock to lapse), then releases the connection.
   */
  async stop(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.producers.values()].map((q) => q.close()));
    if (this.deadLetter) await this.deadLetter.close().catch(() => undefined);
  }
}
