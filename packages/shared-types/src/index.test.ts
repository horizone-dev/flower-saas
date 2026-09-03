import { describe, it, expect } from 'vitest';
import { moneyDtoSchema, apiErrorSchema, readinessResponseSchema } from './index.js';

describe('@flower/shared-types schemas', () => {
  it('accepts a valid Money DTO and rejects a non-integer amount', () => {
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10500', currency: 'KWD', exponent: 3 }).success,
    ).toBe(true);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10.5', currency: 'AED', exponent: 2 }).success,
    ).toBe(false);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '1', currency: 'AED', exponent: 5 }).success,
    ).toBe(false);
  });

  it('validates the API error envelope', () => {
    const parsed = apiErrorSchema.safeParse({
      error: { code: 'ORDER_NOT_FOUND', message: 'Not found', correlationId: '01J' },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a readiness response', () => {
    expect(
      readinessResponseSchema.safeParse({
        status: 'ok',
        checks: { db: 'ok', redis: 'ok', storage: 'ok', migrations: 'ok' },
      }).success,
    ).toBe(true);
  });
});
