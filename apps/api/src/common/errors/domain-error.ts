/**
 * Base class for typed domain errors. Every domain error carries a stable machine
 * `code` (screaming snake case) and an HTTP status. Never leak secrets / PII in
 * `message` or `details` (CODING-STANDARDS).
 */
export interface ErrorDetail {
  field?: string;
  issue: string;
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, code = 'NOT_FOUND') {
    super(code, `${resource} not found`, 404);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN') {
    super(code, message, 403);
    this.name = 'ForbiddenError';
  }
}
