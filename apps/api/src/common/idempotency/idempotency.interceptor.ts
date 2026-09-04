import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { getContext } from '../context/index.js';
import { DomainError } from '../errors/domain-error.js';
import { rootLogger } from '../logger/logger.js';
import { requestHash } from './canonical-hash.js';
import { IDEMPOTENT_META, type IdempotentOptions } from './idempotent.decorator.js';
import { type IdemIdentity, IdempotencyRepository } from './idempotency.repository.js';
import { buildSnapshot } from './snapshot.js';

const KEY_HEADER = 'idempotency-key';
const KEY_RE = /^[A-Za-z0-9._~:-]{8,200}$/;
/** never idempotency-cache these route families (defence in depth — the startup
 *  assertion already rejects a decorated one) */
const FORBIDDEN_PATH = /\/v1\/auth\/|provider-credentials|\/secret(s)?(\/|$)/i;
/** poll backoff while waiting for the owner: 50ms → ×1.5 → capped at 500ms */
const POLL_MIN_MS = 50;
const POLL_MAX_MS = 500;
const MARK_DONE_ATTEMPTS = 3;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly repo: IdempotencyRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execCtx.getType() !== 'http') return next.handle();
    const options = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_META,
      execCtx.getHandler(),
    );
    if (!options) return next.handle();

    const req = execCtx.switchToHttp().getRequest<FastifyRequest>();
    const reply = execCtx.switchToHttp().getResponse<FastifyReply>();
    const routePattern = req.routeOptions?.url ?? req.url;

    if (FORBIDDEN_PATH.test(routePattern)) {
      // a misconfiguration — @Idempotent on a credential route must never ship
      // (the startup assertion already rejects one; this is request-time defence).
      return throwError(
        () =>
          new DomainError(
            'IDEMPOTENCY_MISCONFIGURED',
            'idempotency must not be applied to an auth / credential route',
            500,
          ),
      );
    }

    const ctx = getContext();
    const tenantId = ctx?.tenantId ?? null;
    const principalId = ctx?.userId ?? null;
    if (!tenantId || !principalId) {
      return throwError(
        () =>
          new DomainError(
            'IDEMPOTENCY_MISCONFIGURED',
            'idempotency requires an authenticated tenant user',
            500,
          ),
      );
    }

    const rawKey = req.headers[KEY_HEADER];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key) {
      return throwError(
        () => new DomainError('IDEMPOTENCY_KEY_MISSING', 'Idempotency-Key header is required', 400),
      );
    }
    if (!KEY_RE.test(key)) {
      return throwError(
        () =>
          new DomainError(
            'IDEMPOTENCY_KEY_INVALID',
            'Idempotency-Key must be 8–200 chars of [A-Za-z0-9._~:-]',
            400,
          ),
      );
    }

    const identity: IdemIdentity = { tenantId, scope: options.scope, principalId, key };
    const hash = requestHash({
      method: req.method,
      routePattern,
      pathParams: req.params ?? {},
      query: req.query ?? {},
      scope: options.scope,
      tenantId,
      principalId,
      body: req.body ?? null,
    });

    const httpStatus =
      this.reflector.get<number>(HTTP_CODE_METADATA, execCtx.getHandler()) ??
      (req.method === 'POST' ? 201 : 200);

    return from(this.resolve(identity, hash)).pipe(
      mergeMap((decision) => {
        if (decision.execute) {
          const { claimToken } = decision;
          return next.handle().pipe(
            mergeMap((value) => from(this.onSuccess(identity, claimToken, httpStatus, value))),
            catchError((err: unknown) =>
              from(this.repo.release(identity, claimToken).catch(() => undefined)).pipe(
                mergeMap(() => throwError(() => err)),
              ),
            ),
          );
        }
        // a replayed result
        reply.header('idempotency-replayed', 'true');
        if (!decision.snapshotStored) {
          return throwError(
            () =>
              new DomainError(
                'IDEMPOTENCY_REPLAY_UNAVAILABLE',
                'the original request succeeded but its response was not cached — re-fetch the resource',
                409,
              ),
          );
        }
        void reply.status(decision.httpStatus);
        return from(Promise.resolve(decision.snapshot));
      }),
    );
  }

  /**
   * Acquire the claim, or wait (bounded) for the current owner and replay its
   * result. Returns `execute` only when this request itself holds a fresh claim
   * — so the handler never runs twice while a valid owner exists. If the owner
   * fails / releases, the freed row lets a waiter acquire it and re-execute
   * (a retry, not a duplicate — a non-2xx did not mutate).
   */
  private async resolve(
    identity: IdemIdentity,
    hash: string,
  ): Promise<
    | { execute: true; claimToken: string }
    | { execute: false; snapshotStored: boolean; httpStatus: number; snapshot: unknown }
  > {
    // Every branch below either returns/throws or sleeps ≥ POLL_MIN_MS and
    // re-checks this deadline, so the loop is hard-bounded by IDEMPOTENCY_WAIT_MS
    // — no busy loop, no unbounded spin.
    const deadline = Date.now() + this.config.IDEMPOTENCY_WAIT_MS;
    let backoff = POLL_MIN_MS;

    for (;;) {
      const outcome = await this.repo.acquire(
        identity,
        hash,
        this.config.IDEMPOTENCY_TTL_SECONDS,
        this.config.IDEMPOTENCY_STALE_LOCK_SECONDS,
      );
      switch (outcome.kind) {
        case 'acquired':
          return { execute: true, claimToken: outcome.claimToken };
        case 'replay':
          return {
            execute: false,
            snapshotStored: outcome.snapshotStored,
            httpStatus: outcome.httpStatus,
            snapshot: outcome.snapshot,
          };
        case 'mismatch':
          throw new DomainError(
            'IDEMPOTENCY_KEY_REUSED',
            'this Idempotency-Key was already used for a different request',
            409,
          );
        case 'retry': {
          // raced with cleanup (row deleted / expired mid-acquire) — re-acquire
          // with a minimal yield, still bounded by the same deadline.
          if (Date.now() >= deadline) {
            throw new DomainError(
              'IDEMPOTENCY_IN_PROGRESS',
              'could not acquire the Idempotency-Key — retry shortly',
              409,
            );
          }
          await sleep(POLL_MIN_MS);
          continue;
        }
        case 'in_progress': {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new DomainError(
              'IDEMPOTENCY_IN_PROGRESS',
              'a request with this Idempotency-Key is still being processed — retry shortly',
              409,
            );
          }
          await sleep(Math.min(backoff, remaining));
          backoff = Math.min(Math.ceil(backoff * 1.5), POLL_MAX_MS);
          continue;
        }
      }
    }
  }

  private async onSuccess(
    identity: IdemIdentity,
    claimToken: string,
    httpStatus: number,
    value: unknown,
  ): Promise<unknown> {
    if (httpStatus < 200 || httpStatus >= 300) {
      // defensive: a value-returning handler that set a non-2xx status.
      await this.repo.release(identity, claimToken).catch(() => undefined);
      return value;
    }
    const snap = buildSnapshot(value, this.config.IDEMPOTENCY_MAX_SNAPSHOT_BYTES);
    for (let i = 0; i < MARK_DONE_ATTEMPTS; i++) {
      try {
        await this.repo.markDone(identity, claimToken, httpStatus, snap);
        return value;
      } catch (err) {
        if (i === MARK_DONE_ATTEMPTS - 1) {
          // the mutation committed but the key is still PENDING — a monitored
          // condition. The underlying domain op is itself idempotent, so a later
          // stale-reclaim + re-execute is a no-op, not a double mutation.
          rootLogger.error(
            { err, scope: identity.scope },
            'idempotency: failed to mark key DONE after a successful handler',
          );
        }
      }
    }
    return value;
  }
}
