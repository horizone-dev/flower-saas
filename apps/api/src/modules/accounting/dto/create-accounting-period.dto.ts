import { z } from 'zod';

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `POST .../accounting/periods` body — task 3b.1. Civil dates (`YYYY-MM-DD`),
 *  never a timestamp — a period boundary is a date range, not an instant. */
export const createAccountingPeriodSchema = z
  .object({
    startDate: z.string().regex(CIVIL_DATE_RE, 'startDate must be YYYY-MM-DD'),
    endDate: z.string().regex(CIVIL_DATE_RE, 'endDate must be YYYY-MM-DD'),
  })
  .strict();

export type CreateAccountingPeriodDto = z.infer<typeof createAccountingPeriodSchema>;
