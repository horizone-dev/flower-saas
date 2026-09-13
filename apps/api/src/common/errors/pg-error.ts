/**
 * Extracts the real Postgres SQLSTATE from a Prisma error, across every shape
 * this codebase's Prisma 7 + `@prisma/adapter-pg` setup produces:
 *  - a raw `pg.Client` error (used directly in tests) — the code is `err.code`.
 *  - a Prisma-recognised ORM unique-constraint violation — `err.code` is the
 *    Prisma-level `'P2002'`, not a SQLSTATE (checked separately, see
 *    `isPgUniqueViolation`).
 *  - any other database error the query engine does not specifically
 *    categorise (an EXCLUDE constraint, or a PL/pgSQL `RAISE EXCEPTION`
 *    trigger, hit via either an ORM method or a raw `$queryRaw`/`$executeRaw`
 *    call) — surfaces as Prisma's generic `'P2039'`, with the true SQLSTATE
 *    nested at `err.meta.driverAdapterError.cause.originalCode`.
 * Confirmed empirically against this exact Prisma/adapter version — do not
 * assume the classic (non-driver-adapter) Prisma error shapes apply here.
 */
export function extractPgCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const meta = (err as { meta?: unknown }).meta;
  if (typeof meta === 'object' && meta !== null) {
    const driverAdapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
    if (typeof driverAdapterError === 'object' && driverAdapterError !== null) {
      const cause = (driverAdapterError as { cause?: unknown }).cause;
      if (typeof cause === 'object' && cause !== null) {
        const originalCode = (cause as { originalCode?: unknown }).originalCode;
        if (typeof originalCode === 'string') return originalCode;
      }
    }
    const metaCode = (meta as { code?: unknown }).code;
    if (typeof metaCode === 'string') return metaCode;
  }
  const code = (err as { code?: unknown }).code;
  // a Prisma-level P-code (e.g. 'P2002', 'P2039') is not itself a SQLSTATE.
  if (typeof code === 'string' && !code.startsWith('P2')) return code;
  return undefined;
}

/** True if `err` is a unique-constraint violation for the given Postgres SQLSTATE ('23505' / '23P01' etc). */
export function isPgError(err: unknown, sqlstate: string): boolean {
  if (extractPgCode(err) === sqlstate) return true;
  // Prisma's own schema-aware unique-constraint recognition reports 'P2002'
  // directly (no nested SQLSTATE) for a `tx.model.create/update` unique hit.
  if (sqlstate === '23505') {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'P2002') return true;
  }
  return false;
}
