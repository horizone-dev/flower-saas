import { z } from 'zod';
import {
  Quantity,
  QUANTITY_MAX_SCALED,
  QUANTITY_MIN_SCALED,
  type QuantityDTO,
} from './quantity.js';

/**
 * The wire-contract schema for a `QuantityDTO` (API-CONVENTIONS: "string-encoded
 * decimals in the item's base UOM"). Unit-neutral — the UOM code travels
 * alongside in the domain, never inside the value.
 *
 *  - `amount` is a decimal string with at most 4 fractional places, never a
 *    JSON number;
 *  - it must be within the storable `NUMERIC(18,4)` range.
 */
export const quantityDtoSchema = z
  .object({
    amount: z
      .string()
      .regex(/^-?\d+(\.\d{1,4})?$/, 'amount must be a decimal with at most 4 fractional places'),
  })
  .refine(
    (d) => {
      try {
        const q = Quantity.parse(d.amount);
        return q.scaled >= QUANTITY_MIN_SCALED && q.scaled <= QUANTITY_MAX_SCALED;
      } catch {
        return false;
      }
    },
    { message: 'amount is outside the storable NUMERIC(18,4) range', path: ['amount'] },
  );

export type QuantityDtoShape = z.infer<typeof quantityDtoSchema>;

/** Validate an unknown value as a `QuantityDTO` and construct the `Quantity`. */
export function parseQuantity(input: unknown): Quantity {
  return Quantity.fromDTO(quantityDtoSchema.parse(input) as QuantityDTO);
}
