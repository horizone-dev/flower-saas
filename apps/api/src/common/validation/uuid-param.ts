import { DomainError } from '../errors/domain-error.js';

/** a UUID in canonical 8-4-4-4-12 hex form (any version / variant: ids are `uuidv7()` in the database, `randomUUID()` in memory) */
const UUID_PARAM_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validate an identifier taken from a URL path BEFORE it is used in any write, audit row or security event.
 * `400 INVALID_ID`; the message is fixed, so the rejected value is never echoed into the response or the logs.
 */
export function requireUuidParam(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PARAM_RE.test(value)) {
    throw new DomainError('INVALID_ID', 'identifier is not a valid UUID', 400);
  }
  return value;
}
