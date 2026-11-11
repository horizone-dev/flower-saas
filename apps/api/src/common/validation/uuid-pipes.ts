import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainError } from '../errors/domain-error.js';
import { requireUuidParam } from './uuid-param.js';

/**
 * For the list routes whose keyset cursor is a row UUID (customers, orders, settlement batches): `@Query('cursor', UuidCursorPipe)`.
 * Absent → undefined (first page). Present but not a UUID → `400 INVALID_CURSOR` (the value is never echoed). Routes with an
 * opaque cursor (the customer statement) deliberately do NOT use this pipe.
 */
@Injectable()
export class UuidCursorPipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    try {
      return requireUuidParam(value);
    } catch {
      throw new DomainError('INVALID_CURSOR', 'the cursor is not valid', 400);
    }
  }
}
