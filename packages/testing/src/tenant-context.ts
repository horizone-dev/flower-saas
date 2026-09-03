import pg from 'pg';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Run `fn` with a `pg` client scoped to `tenantId` (and optionally `branchId`) —
 * an interactive transaction that first sets the RLS GUCs via `set_config(...,
 * is_local => true)`, i.e. `SET LOCAL`, so the scope cannot bleed onto a pooled
 * connection. This is the test-side mirror of the production `ScopedRepository`
 * pattern verified in Task 0.6 (ADR-0010).
 *
 * The transaction is ROLLED BACK afterwards unless `commit: true`, so tests stay
 * isolated from each other without a truncate.
 */
export interface TenantContextOptions {
  branchId?: string;
  commit?: boolean;
}

export async function withTenantContext<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  options: TenantContextOptions = {},
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`withTenantContext: tenantId is not a UUID: ${JSON.stringify(tenantId)}`);
  }
  if (options.branchId !== undefined && !UUID_RE.test(options.branchId)) {
    throw new Error(
      `withTenantContext: branchId is not a UUID: ${JSON.stringify(options.branchId)}`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (options.branchId !== undefined) {
      await client.query("SELECT set_config('app.branch_id', $1, true)", [options.branchId]);
    }
    const result = await fn(client);
    await client.query(options.commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Read back the tenant GUC the current connection sees (for bleed assertions). */
export async function currentTenantGuc(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ v: string }>(
    "SELECT COALESCE(current_setting('app.tenant_id', true), '') AS v",
  );
  return rows[0]?.v ?? '';
}

export { pg };
