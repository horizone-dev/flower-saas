import { describe, it, expect } from 'vitest';
import {
  moneyDtoSchema,
  quantityDtoSchema,
  apiErrorSchema,
  readinessResponseSchema,
} from './index.js';

describe('@flower/shared-types schemas', () => {
  it('re-exports the authoritative Money DTO schema (currency + range aware)', () => {
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10500', currency: 'KWD', exponent: 3 }).success,
    ).toBe(true);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10.5', currency: 'AED', exponent: 2 }).success,
    ).toBe(false);
    // exponent must match the currency; 'AED' is exponent 2
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '1', currency: 'AED', exponent: 5 }).success,
    ).toBe(false);
  });

  it('re-exports the Quantity DTO schema', () => {
    expect(quantityDtoSchema.safeParse({ amount: '1.5000' }).success).toBe(true);
    expect(quantityDtoSchema.safeParse({ amount: 1.5 }).success).toBe(false);
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
