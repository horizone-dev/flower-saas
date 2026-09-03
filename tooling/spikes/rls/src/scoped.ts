import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/client/index.js';

export { PrismaClient };
export type ScopedTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function createSpikeClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

/**
 * The candidate ADR-0010 pattern: run `fn` inside a Prisma **interactive
 * transaction** that first sets `app.tenant_id` with `set_config(..., is_local =>
 * true)` — i.e. `SET LOCAL`, so the GUC is scoped to this transaction only and
 * cannot bleed onto a pooled connection.
 *
 * `set_config` (not `SET LOCAL app.tenant_id = $1`) is used because `SET` does not
 * accept bind parameters; `set_config` does, so the tenant id is never string-
 * interpolated. A non-UUID tenant id is rejected before it reaches SQL.
 */
export async function runScoped<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`runScoped: tenantId is not a UUID: ${JSON.stringify(tenantId)}`);
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as ScopedTx);
    },
    // headroom for pooled/queued connections; production tunes these per workload
    { maxWait: 15_000, timeout: 20_000 },
  );
}

/** Read back the GUC the current connection sees (for the bleed test). */
export async function readTenantGuc(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.$queryRaw<{ v: string }[]>`
    SELECT COALESCE(current_setting('app.tenant_id', true), '') AS v
  `;
  return rows[0]?.v ?? '';
}

export type { Prisma };
