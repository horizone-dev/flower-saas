import { z } from 'zod';

/** `POST .../accounting/setup` body — task 3b.1 existing-company bootstrap.
 *  Same wire shape as `configure-accounting-timezone.dto.ts` (this operation's
 *  only input is the explicit `accountingTimezone` a pre-3b.1 company must be
 *  given) — a distinct type alias, not a re-export, so the two endpoints stay
 *  independently versionable even though they coincide today. IANA-format
 *  validation happens in `posting-date.ts`'s `assertValidIanaTimezone` (reused,
 *  not duplicated) — this schema only enforces the wire shape. */
export const accountingSetupSchema = z
  .object({ accountingTimezone: z.string().min(1).max(64) })
  .strict();

export type AccountingSetupDto = z.infer<typeof accountingSetupSchema>;
