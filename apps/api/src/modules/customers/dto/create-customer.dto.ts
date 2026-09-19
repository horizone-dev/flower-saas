import { z } from 'zod';

/** `POST .../customers` body — task 3b.2 §5/§20. `.strict()` rejects any
 *  client-supplied `tenantId`/`status`/`version`/`createdByUserId` outright —
 *  those are always server-assigned. `phone`/`email` are raw caller input,
 *  normalized server-side (task 3b.2 §1/§4) — never stored verbatim. */
export const createCustomerSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    phone: z.string().trim().min(1).max(64).optional(),
    email: z.string().trim().min(1).max(320).optional(),
  })
  .strict();

export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;
