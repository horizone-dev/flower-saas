import { z } from 'zod';

/**
 * `PATCH .../customers/:id/account/credit` body — task 3b.2 §12/§14.
 *
 * `creditLimitMinor` is a decimal-digit STRING, never a JSON number — a raw JS
 * `number` cannot safely round-trip an arbitrary BigInt minor-unit value (no
 * existing Money-in-HTTP-body precedent exists anywhere else in this codebase
 * to follow instead; this is the safest minimal shape, matching `@flower/money`'s
 * own bigint-minor-unit model). No `creditLimitCurrencyCode`/exponent field
 * exists here at all — the client can never supply either; both are resolved
 * server-side from the locked `Company.defaultCurrency` + the authoritative
 * `Currency` reference table (task 3b.2 §10/§14).
 *
 * `creditLimitMinor` omitted leaves a previously-stored limit untouched
 * (`CustomerRepository.configureCredit`'s `input.creditLimitMinor !== undefined`
 * check); when supplied it always validates and REPLACES the stored limit with
 * a positive value. There is intentionally NO way to explicitly clear a stored
 * limit in Task 3b.2 — no authoritative plan text requires it, and the owner's
 * review explicitly rejected inventing a `null`-means-clear verb that would
 * make `null` ambiguous with "not provided" (task 3b.2 §13/E).
 */
export const configureCreditSchema = z
  .object({
    creditEnabled: z.boolean(),
    creditLimitMinor: z
      .string()
      .regex(/^\d+$/, 'creditLimitMinor must be a non-negative decimal-digit string')
      .optional(),
  })
  .strict();

export type ConfigureCreditDto = z.infer<typeof configureCreditSchema>;
