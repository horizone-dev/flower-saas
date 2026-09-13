import { z } from 'zod';

/** `PATCH .../accounting/config/timezone` body — task 3b.1. IANA-format
 *  validation itself happens in `posting-date.ts`'s `assertValidIanaTimezone`
 *  (reused, not duplicated) — this schema only enforces the wire shape. */
export const configureAccountingTimezoneSchema = z
  .object({ accountingTimezone: z.string().min(1).max(64) })
  .strict();

export type ConfigureAccountingTimezoneDto = z.infer<typeof configureAccountingTimezoneSchema>;
