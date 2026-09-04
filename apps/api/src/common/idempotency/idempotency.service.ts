import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { IdempotencyRepository } from './idempotency.repository.js';

/**
 * Thin service surface over the store. The interceptor drives the request path;
 * this exposes the operational bits — the TTL sweep (wired to the scheduler in
 * task 2.3) and the configured thresholds.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly repo: IdempotencyRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get ttlSeconds(): number {
    return this.config.IDEMPOTENCY_TTL_SECONDS;
  }
  get staleLockSeconds(): number {
    return this.config.IDEMPOTENCY_STALE_LOCK_SECONDS;
  }

  /** Delete every expired key across all tenants. Safe to run any time — the
   *  interceptor already clears an expired row for its own identity, so this is
   *  purely space reclamation. */
  sweepExpired(): Promise<number> {
    return this.repo.sweepExpired();
  }
}
