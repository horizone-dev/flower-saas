import { z } from 'zod';

/** `PATCH .../customers/:id` body — task 3b.2 §8/§20. `.strict()` rejects
 *  `tenantId`/`status`/`version`/`createdByUserId`/anything CustomerCompanyAccount-
 *  shaped — status changes only through the explicit archive route, never a
 *  generic PATCH. `null` for `phone`/`email` explicitly clears the field;
 *  `undefined` (omitted) leaves it unchanged — the repository distinguishes the
 *  two exactly this way (`updateForCompany`'s `input.phone !== undefined` check). */
export const updateCustomerSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().min(1).max(64).nullable().optional(),
    email: z.string().trim().min(1).max(320).nullable().optional(),
  })
  .strict();

export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;
