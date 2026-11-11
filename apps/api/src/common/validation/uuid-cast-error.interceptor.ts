import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';
import { NotFoundError } from '../errors/domain-error.js';
import { extractPgCode } from '../errors/pg-error.js';

/**
 * Task 3b.11 findings V-1 / V-2 — a caller-supplied identifier that is not a UUID must never be a server fault.
 *
 * Handlers that validate their own ids (`assertUuid` → 404, `requireUuidParam` → 400 …) keep their exact, frozen behaviour: they
 * throw first and this interceptor never sees a database error. For every other route, a malformed id reaches PostgreSQL, whose
 * `$1::uuid` cast raises `22P02 invalid input syntax for type uuid`; the global filter does not recognise that error and would
 * answer `500`. Here ONLY that one error (SQLSTATE 22P02 AND the text "type uuid") is translated into the same
 * `404 NOT_FOUND` (as is the `runScoped` pre-flight refusal of a non-UUID tenant / branch id, a typed `InvalidScopeIdError` raised
 * before any statement) the frozen modules answer for a non-UUID id: a value that cannot be an id identifies nothing, and a 404
 * discloses nothing. Every other error — including a 22P02 on any other type — passes through untouched (still a 500, still
 * logged), so a genuine fault is never disguised. The caller's value is never echoed.
 */

function isUuidCastError(err: unknown): boolean {
  // typed, message-independent: `@flower/db` raises InvalidScopeIdError (stable `code`) before any statement runs
  if ((err as { code?: unknown } | null)?.code === 'INVALID_SCOPE_ID') return true;
  if (extractPgCode(err) !== '22P02') return false;
  const e = err as {
    message?: unknown;
    meta?: { message?: unknown; driverAdapterError?: { cause?: { message?: unknown } } };
  };
  const text = [e.message, e.meta?.message, e.meta?.driverAdapterError?.cause?.message]
    .filter((x): x is string => typeof x === 'string')
    .join(' ');
  return /type uuid/i.test(text);
}

@Injectable()
export class UuidCastErrorInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((err: unknown) =>
          throwError(() => (isUuidCastError(err) ? new NotFoundError('resource') : err)),
        ),
      );
  }
}

export { isUuidCastError };
