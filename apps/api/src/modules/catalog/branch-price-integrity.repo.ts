import type { ScopedTx } from '@flower/db';
import { requireTenantContext } from '../../common/context/index.js';

/**
 * Task 3.8 — the THREE narrow cross-branch integrity read helpers (scope freeze
 * rev.5 §3.4 / Correction F). **There is deliberately NO generic
 * `withTenantWideBranchIntegrity(tx, fn)` callback.**
 *
 * A company-level invariant — "does ANY branch of this company reference this
 * company UOM price / this custom UOM / this variant?" — cannot run under the
 * Task 3.8 branch-GUC RLS narrowing (a single-branch caller would only see its
 * own branch's rows and could wrongly permit an orphan — BD-1 / BD-2 violation).
 * These helpers evaluate exactly that class of invariant **tenant-wide across
 * every branch** while staying **strictly tenant-isolated**.
 *
 * Each helper, WITHOUT EXCEPTION:
 *   1. reads the current `app.branch_id`;
 *   2. neutralizes ONLY `app.branch_id` (sets it to '');
 *   3. runs EXACTLY ONE read-only dependency `SELECT` / grouped `SELECT`, which
 *      also carries an explicit `"tenantId" = <current tenant>` predicate;
 *   4. restores the previous `app.branch_id` (in a `finally` — a thrown error
 *      still restores; if PG aborts the transaction the rollback discards the
 *      GUC anyway);
 *   5. returns ONLY a count / boolean / blocked-UOM-code set — never a row,
 *      never a `branchId`.
 *
 * It NEVER: accepts a callback / arbitrary SQL; performs INSERT/UPDATE/DELETE;
 * changes `app.tenant_id`; changes the DB role; uses BYPASSRLS / flower_platform
 * / runPlatform / runDispatcher.
 *
 * SEQUENTIAL-EXECUTION RULE: `app.branch_id` is transaction/connection state.
 * Every call MUST be a standalone `await` — NEVER inside a `Promise.all`, and no
 * other `tx.*` query may be pending while the branch GUC is neutralized. The
 * call-sites (`company-pricing.repository.ts`, `uom.repository.ts`,
 * `variant.repository.ts`) invoke these AFTER their ordinary (non-widened) count
 * batches are fully awaited.
 *
 * NOT exported from the catalog barrel / imported by any controller (enforced by
 * `branch-price-integrity.repo.static.test.ts`).
 */

/** Read the current `app.branch_id` GUC as seen by this transaction's connection. */
async function readBranchGuc(tx: ScopedTx): Promise<string> {
  const rows = await tx.$queryRaw<{ v: string }[]>`
    SELECT COALESCE(current_setting('app.branch_id', true), '') AS v`;
  return rows[0]?.v ?? '';
}

/** #1 — the subset of `uomCodes` (the caller's OWN company UOM codes) that ANY
 *  branch of `companyId` currently overrides for `variantId`, plus the total
 *  row count. Used by the Task 3.7 company-price replace guard (§3.2). Returns
 *  UOM codes + a count — NEVER a `branchId`. */
export async function findTenantWideBlockedCompanyPriceUoms(
  tx: ScopedTx,
  args: { companyId: string; variantId: string; uomCodes: readonly string[] },
): Promise<{ blockedUomCodes: string[]; dependentRowCount: number }> {
  const tenantId = requireTenantContext().tenantId;
  if (args.uomCodes.length === 0) return { blockedUomCodes: [], dependentRowCount: 0 };
  const codes = [...args.uomCodes];
  const prev = await readBranchGuc(tx);
  try {
    await tx.$executeRaw`SELECT set_config('app.branch_id', '', true)`;
    const rows = await tx.$queryRaw<{ uomCode: string; n: bigint }[]>`
      SELECT "uomCode", count(*)::bigint AS n
        FROM "branch_variant_uom_price"
       WHERE "tenantId"  = ${tenantId}::uuid
         AND "companyId" = ${args.companyId}::uuid
         AND "variantId" = ${args.variantId}::uuid
         AND "uomCode"   = ANY(${codes}::text[])
       GROUP BY "uomCode"`;
    return {
      blockedUomCodes: rows.map((r) => r.uomCode).sort(),
      dependentRowCount: rows.reduce((acc, r) => acc + Number(r.n), 0),
    };
  } finally {
    await tx.$executeRaw`SELECT set_config('app.branch_id', ${prev}, true)`;
  }
}

/** #2 — how many `branch_variant_uom_price` rows across EVERY branch of this
 *  tenant reference `uomCode`. Used by the Task 3.6 custom-UOM hard-delete guard
 *  (§10.2), AFTER `uom … FOR UPDATE` is held. */
export async function countTenantWideBranchPriceUomDependencies(
  tx: ScopedTx,
  args: { uomCode: string },
): Promise<number> {
  const tenantId = requireTenantContext().tenantId;
  const prev = await readBranchGuc(tx);
  try {
    await tx.$executeRaw`SELECT set_config('app.branch_id', '', true)`;
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
        FROM "branch_variant_uom_price"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "uomCode"  = ${args.uomCode}`;
    return Number(rows[0]?.n ?? 0n);
  } finally {
    await tx.$executeRaw`SELECT set_config('app.branch_id', ${prev}, true)`;
  }
}

/** #3 — how many `branch_variant_uom_price` rows across EVERY branch of this
 *  tenant reference `variantId`. Used by the Task 3.6 base-UOM change guard
 *  (§10.1), while `variant … FOR UPDATE` is held. */
export async function countTenantWideBranchPriceVariantDependencies(
  tx: ScopedTx,
  args: { variantId: string },
): Promise<number> {
  const tenantId = requireTenantContext().tenantId;
  const prev = await readBranchGuc(tx);
  try {
    await tx.$executeRaw`SELECT set_config('app.branch_id', '', true)`;
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
        FROM "branch_variant_uom_price"
       WHERE "tenantId"  = ${tenantId}::uuid
         AND "variantId" = ${args.variantId}::uuid`;
    return Number(rows[0]?.n ?? 0n);
  } finally {
    await tx.$executeRaw`SELECT set_config('app.branch_id', ${prev}, true)`;
  }
}
