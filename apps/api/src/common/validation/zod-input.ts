import type { ZodType } from 'zod';
import { DomainError } from '../errors/domain-error.js';
import { toValidationDetails } from './validation-details.js';

/**
 * Validate caller input (a query object, a path value) against a zod schema and fail with the standard `400 VALIDATION_FAILED`
 * envelope. A bare `schema.parse(...)` in a handler throws a `ZodError`, which the global filter does not recognise — it would be
 * reported as a `500` for something that is the caller's mistake (Task 3b.11 finding V-2). Details go through
 * `toValidationDetails`, so no caller-controlled text is echoed.
 */
export function parseInput<T>(schema: ZodType<T>, value: unknown, what: 'query' | 'parameter'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new DomainError(
    'VALIDATION_FAILED',
    `the request ${what} is invalid`,
    400,
    toValidationDetails(result.error.issues),
  );
}
