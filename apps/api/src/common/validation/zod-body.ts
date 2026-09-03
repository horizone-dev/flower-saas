import { type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { DomainError } from '../errors/domain-error.js';

/**
 * `@Body(new ZodBody(schema)) dto: T` — validates the request body against a zod
 * schema and returns the parsed value, or throws a 400 in the standard envelope.
 */
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new DomainError(
      'VALIDATION_FAILED',
      'the request body is invalid',
      400,
      result.error.issues.map((i) => {
        const field = i.path.join('.');
        return field ? { field, issue: i.message } : { issue: i.message };
      }),
    );
  }
}
