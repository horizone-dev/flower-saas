import { z } from 'zod';
import { currencyExponent, isKnownCurrency } from './currencies.js';
import { Money, MONEY_MAX_MINOR, MONEY_MIN_MINOR, type MoneyDTO } from './money.js';

/**
 * The authoritative wire-contract schema for a `MoneyDTO` (ADR-0006,
 * `API-CONVENTIONS.md`). `@flower/money` owns it because validation needs the
 * currency table:
 *
 *  - `amountMinor` is an **integer string**, never a JSON number;
 *  - the string must be within the storable `BIGINT` range;
 *  - `currency` must be known;
 *  - `exponent` must equal that currency's canonical exponent (a DTO whose
 *    exponent disagrees with its currency is malformed / adversarial).
 */
const INTEGER_STRING = /^-?\d+$/;

export const moneyDtoSchema = z
  .object({
    amountMinor: z
      .string()
      .regex(INTEGER_STRING, 'amountMinor must be an integer string (minor units)'),
    currency: z.string().min(1),
    exponent: z.number().int(),
  })
  // Every check below is written to be a no-op on input another check already
  // flagged — zod 4 runs all refinements and collects every issue rather than
  // short-circuiting, so a refinement must never throw on a still-invalid value.
  .refine((d) => isKnownCurrency(d.currency), {
    message: 'unknown currency',
    path: ['currency'],
  })
  .refine((d) => !isKnownCurrency(d.currency) || d.exponent === currencyExponent(d.currency), {
    message: 'exponent does not match the currency',
    path: ['exponent'],
  })
  .refine(
    (d) => {
      if (!INTEGER_STRING.test(d.amountMinor)) return true; // the field regex already flags this
      const v = BigInt(d.amountMinor);
      return v >= MONEY_MIN_MINOR && v <= MONEY_MAX_MINOR;
    },
    { message: 'amountMinor is outside the storable BIGINT range', path: ['amountMinor'] },
  );

export type MoneyDtoShape = z.infer<typeof moneyDtoSchema>;

/** Validate an unknown value as a `MoneyDTO` and construct the `Money`. Throws a
 *  `ZodError` on a malformed shape. */
export function parseMoney(input: unknown): Money {
  return Money.fromDTO(moneyDtoSchema.parse(input) as MoneyDTO);
}
