import { z } from 'zod';

/** `PATCH .../accounting/accounts/:id` body — task 3b.1. `.strict()` rejects
 *  `key`/`category` (or any other field) outright at the schema boundary,
 *  belt-and-suspenders alongside `AccountRepository.updateDisplay`'s
 *  signature, which never accepts them either (ACCOUNT_IMMUTABLE_FIELD is
 *  the service-layer name for what this schema already makes unreachable). */
export const updateAccountDisplaySchema = z
  .object({
    displayCode: z.string().min(1).max(40).optional(),
    displayName: z.string().min(1).max(120).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

export type UpdateAccountDisplayDto = z.infer<typeof updateAccountDisplaySchema>;
