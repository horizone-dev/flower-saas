import type { PrismaClient } from '../generated/client/index.js';
import { DB_ROLES } from './constants.js';

/**
 * A Prisma transaction client with the connection-management surface removed —
 * what a scoped callback is handed. It cannot open its own transaction or swap
 * the connection out from under the `SET LOCAL` GUCs.
 */
export type ScopedTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]*$/;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} is not a UUID: ${JSON.stringify(value)}`);
  }
}

export interface ScopeContext {
  tenantId: string;
  /** set alongside app.tenant_id when the session is bound to one branch */
  branchId?: string | null;
}

export interface RunOptions {
  /**
   * Role to drop to inside the transaction (`SET LOCAL ROLE`). Defaults to
   * `flower_app` so RLS is enforced even when the pool connects as a superuser
   * (dev / Testcontainers). In prod, connecting *as* `flower_app` makes this a
   * self-`SET ROLE` no-op. Pass `null` to skip (only when the caller guarantees
   * the connection role is already correct).
   */
  role?: string | null;
  maxWait?: number;
  timeout?: number;
}

/**
 * The ADR-0010 GO pattern, in production form. Runs `fn` inside a Prisma
 * **interactive transaction** that first drops to `flower_app` and sets
 * `app.tenant_id` (+ optionally `app.branch_id`) with `set_config(..., true)` —
 * i.e. `SET LOCAL`, transaction-scoped, so nothing bleeds onto a pooled
 * connection. Parameters are bound, never interpolated; a non-UUID id is rejected
 * before it reaches SQL.
 */
export async function runScoped<T>(
  prisma: PrismaClient,
  ctx: ScopeContext,
  fn: (tx: ScopedTx) => Promise<T>,
  opts: RunOptions = {},
): Promise<T> {
  assertUuid(ctx.tenantId, 'runScoped: tenantId');
  if (ctx.branchId != null && ctx.branchId !== '') assertUuid(ctx.branchId, 'runScoped: branchId');

  const role = opts.role === undefined ? DB_ROLES.app : opts.role;
  if (role != null && !ROLE_RE.test(role))
    throw new Error(`runScoped: bad role ${JSON.stringify(role)}`);

  return prisma.$transaction(
    async (tx) => {
      if (role != null) await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.branch_id', ${ctx.branchId ?? ''}, true)`;
      return fn(tx as unknown as ScopedTx);
    },
    { maxWait: opts.maxWait ?? 15_000, timeout: opts.timeout ?? 20_000 },
  );
}

/**
 * The separate, audited cross-tenant path (ADR-0014). Runs `fn` as
 * `flower_platform` (BYPASSRLS) — no `app.tenant_id` is set. **Every caller must
 * also write an `audit_log` row** (Phase 1 task 1.14); this helper only provides
 * the connection role. Reachable only from the `platform` module.
 */
export async function runPlatform<T>(
  prisma: PrismaClient,
  fn: (tx: ScopedTx) => Promise<T>,
  opts: Pick<RunOptions, 'maxWait' | 'timeout' | 'role'> = {},
): Promise<T> {
  const role = opts.role === undefined ? DB_ROLES.platform : opts.role;
  if (role != null && !ROLE_RE.test(role))
    throw new Error(`runPlatform: bad role ${JSON.stringify(role)}`);
  return prisma.$transaction(
    async (tx) => {
      if (role != null) await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      return fn(tx as unknown as ScopedTx);
    },
    { maxWait: opts.maxWait ?? 15_000, timeout: opts.timeout ?? 20_000 },
  );
}

/**
 * The outbox dispatcher's path (task 2.4 remediation — least-privilege review,
 * 2026-09-04). Runs `fn` as `flower_dispatcher`: BYPASSRLS (the dispatcher must
 * scan every tenant's undispatched rows — there is no single `app.tenant_id` to
 * scope to), but the role's *grants* are narrowed to exactly `outbox`
 * (SELECT, UPDATE) and `outbox_tenant_seq` (SELECT, INSERT, UPDATE) — it cannot
 * read or write `user` / `credential` / `session` / any tenant business table,
 * or any other platform-global table, regardless of RLS. Reachable only from
 * `apps/worker`'s outbox module (`seq-allocator.ts` / `publisher.ts`) — never
 * use this for anything else.
 */
export async function runDispatcher<T>(
  prisma: PrismaClient,
  fn: (tx: ScopedTx) => Promise<T>,
  opts: Pick<RunOptions, 'maxWait' | 'timeout' | 'role'> = {},
): Promise<T> {
  const role = opts.role === undefined ? DB_ROLES.dispatcher : opts.role;
  if (role != null && !ROLE_RE.test(role))
    throw new Error(`runDispatcher: bad role ${JSON.stringify(role)}`);
  return prisma.$transaction(
    async (tx) => {
      if (role != null) await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      return fn(tx as unknown as ScopedTx);
    },
    { maxWait: opts.maxWait ?? 15_000, timeout: opts.timeout ?? 20_000 },
  );
}

/** Read back the `app.tenant_id` GUC the current connection sees (bleed tests). */
export async function currentTenantGuc(tx: ScopedTx): Promise<string> {
  const rows = await tx.$queryRaw<{ v: string }[]>`
    SELECT COALESCE(current_setting('app.tenant_id', true), '') AS v
  `;
  return rows[0]?.v ?? '';
}
