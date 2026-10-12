/**
 * Task 3b.10 Checkpoint A — THE Trial Balance statement: ONE read statement, so the whole
 * report is a single consistent snapshot (`runScoped` offers no isolation-level control, so a
 * multi-statement report could straddle a concurrent posting). Pure data: a constant SQL text
 * with positional parameters — never interpolated, never built from input.
 *
 *   $1 tenantId   $2 companyId   $3 from (civil date)   $4 to (civil date)
 *
 * Sources (and ONLY these): `journal_entry`, `journal_line`, `account`, plus the one
 * `company` row for the currency / timezone authority. No source document is read, there is no
 * `sourceKind` predicate (the report is the complete company GL — an unknown or future source
 * kind is included), no branch / POS / customer predicate (company GL only), no pagination.
 *
 *   - tenant + company are EXPLICIT predicates on every table touched — the report never relies
 *     on RLS (or the branch GUC) alone;
 *   - only SEALED entries count (`sealedAt IS NOT NULL`);
 *   - `journal_entry.postingDate` — a civil DATE — is the period authority: an entry posted
 *     `< from` is opening, `from ≤ postingDate ≤ to` is period, `> to` is excluded;
 *   - sums are exact: `SUM(bigint)` is `numeric`, read back as TEXT and parsed to `bigint`;
 *   - an account appears iff it has at least one sealed line posted on or before `to`;
 *   - ordering is deterministic: the company's account code, then the immutable account key,
 *     then the id (byte-wise `C` collation, so the order never depends on a server locale);
 *   - the company row is ALWAYS returned (a `LEFT JOIN` over the aggregate), so "company not
 *     found" (zero rows) is distinguishable from "company with an empty ledger" (one row with a
 *     NULL account);
 *   - `currencyMismatch` counts the lines whose ENTRY currency differs from the company's accounting
 *     currency (a `journal_line` has no currency of its own — it inherits its entry's); any value
 *     above zero means a mixed or foreign currency reached this company's ledger.
 */
export const TRIAL_BALANCE_SQL = `
WITH co AS (
  SELECT c."defaultCurrency", c."accountingTimezone"
    FROM "company" c
   WHERE c."tenantId" = $1::uuid
     AND c."id" = $2::uuid
),
agg AS (
  SELECT jl."accountId" AS "accountId",
         COALESCE(SUM(jl."debitMinor")  FILTER (WHERE je."postingDate" <  $3::date), 0) AS "openingDebit",
         COALESCE(SUM(jl."creditMinor") FILTER (WHERE je."postingDate" <  $3::date), 0) AS "openingCredit",
         COALESCE(SUM(jl."debitMinor")  FILTER (WHERE je."postingDate" >= $3::date), 0) AS "periodDebit",
         COALESCE(SUM(jl."creditMinor") FILTER (WHERE je."postingDate" >= $3::date), 0) AS "periodCredit",
         COUNT(*) FILTER (
           WHERE je."currencyCode" IS DISTINCT FROM (SELECT co2."defaultCurrency" FROM co co2)
         ) AS "currencyMismatch"
    FROM "journal_entry" je
    JOIN "journal_line" jl
      ON jl."journalEntryId" = je."id"
     AND jl."tenantId" = $1::uuid
     AND jl."companyId" = $2::uuid
   WHERE je."tenantId" = $1::uuid
     AND je."companyId" = $2::uuid
     AND je."sealedAt" IS NOT NULL
     AND je."postingDate" <= $4::date
   GROUP BY jl."accountId"
)
SELECT co."defaultCurrency"          AS "defaultCurrency",
       co."accountingTimezone"       AS "accountingTimezone",
       a."id"                        AS "accountId",
       a."key"                       AS "accountKey",
       a."category"                  AS "category",
       a."displayCode"               AS "displayCode",
       a."displayName"               AS "displayName",
       agg."openingDebit"::text      AS "openingDebit",
       agg."openingCredit"::text     AS "openingCredit",
       agg."periodDebit"::text       AS "periodDebit",
       agg."periodCredit"::text      AS "periodCredit",
       agg."currencyMismatch"::text  AS "currencyMismatch"
  FROM co
  LEFT JOIN agg ON true
  LEFT JOIN "account" a
    ON a."id" = agg."accountId"
   AND a."tenantId" = $1::uuid
   AND a."companyId" = $2::uuid
 ORDER BY a."displayCode" COLLATE "C" ASC NULLS LAST,
          a."key" COLLATE "C" ASC NULLS LAST,
          a."id" ASC NULLS LAST
`;

export interface TrialBalanceQuery {
  readonly text: string;
  /** `[tenantId, companyId, from, to]` — positional parameters `$1..$4`. */
  readonly values: readonly [string, string, string, string];
}

export function buildTrialBalanceQuery(args: {
  readonly tenantId: string;
  readonly companyId: string;
  readonly from: string;
  readonly to: string;
}): TrialBalanceQuery {
  return {
    text: TRIAL_BALANCE_SQL,
    values: [args.tenantId, args.companyId, args.from, args.to],
  };
}

/** The row shape the statement returns (every aggregate already cast to TEXT). */
export interface TrialBalanceSqlRow {
  readonly defaultCurrency: string | null;
  readonly accountingTimezone: string | null;
  readonly accountId: string | null;
  readonly accountKey: string | null;
  readonly category: string | null;
  readonly displayCode: string | null;
  readonly displayName: string | null;
  readonly openingDebit: string | null;
  readonly openingCredit: string | null;
  readonly periodDebit: string | null;
  readonly periodCredit: string | null;
  readonly currencyMismatch: string | null;
}
