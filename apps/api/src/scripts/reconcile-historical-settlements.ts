/**
 * Task 3b.7 Checkpoint E — the ONE sanctioned way to invoke historical
 * PAID->SETTLED Invoice reconciliation. Explicit, one-shot/on-demand,
 * operator-run — never wired into `AppModule` bootstrap, never reachable
 * from any HTTP route, never triggered automatically after a migration or
 * for every tenant.
 *
 * Lives under `src/` (not a sibling `scripts/` directory) so it participates
 * in the SAME production build `apps/api` already ships
 * (`tsc -p tsconfig.build.json` -> `dist/`) and needs no devDependency
 * (`tsx`/`ts-node`) at runtime — the repo has no Dockerfile/deploy manifest
 * for `apps/api` to inspect, so this deliberately does not assume `tsx`
 * (a devDependency) survives whatever production install strategy is used
 * later; it only assumes what `"start": "node dist/main.js"` already
 * assumes (a prior `pnpm --filter @flower/api build`, `dependencies`
 * installed).
 *
 * Deliberately does NOT boot the full Nest HTTP application
 * (`NestFactory.create(AppModule)` / `.createApplicationContext(AppModule)`)
 * — that would pull in every controller/guard/module this maintenance
 * operation has nothing to do with. Instead it constructs only the small,
 * DI-free-constructible dependency graph
 * `HistoricalSettlementReconciliationRepository` actually needs
 * (`DbService` -> `InvoiceSettlementProjectionRepository` -> `AuditWriter`),
 * exactly mirroring the "pure repository" construction style already used
 * throughout this task's own integration tests (e.g.
 * `customer-advance-application.integration.test.ts`). Reuses `apps/api`'s
 * own `loadConfig()` (`src/config/env.ts`) — the same env parsing `main.ts`
 * uses — rather than a bespoke one.
 *
 * Build + run (production):
 *   pnpm --filter @flower/api build
 *   node dist/scripts/reconcile-historical-settlements.js \
 *     --tenant <tenantId> --company <companyId> [--branch <branchId>] \
 *     [--cursor <uuid>] [--limit 100]
 *
 * Local/dev (no build step): `tsx src/scripts/reconcile-historical-settlements.ts ...`
 * — `tsx` is a devDependency, fine for a developer's own machine, never
 * assumed in production.
 *
 * Repeat with the printed `nextCursor` until `hasMore` is false. Exit code
 * 0 on success; non-zero on invalid arguments or a reconciliation/DB
 * failure. Never logs `DATABASE_URL`/config or any provider secret — only
 * the error message.
 */
import 'reflect-metadata';
import { DbService } from '@flower/backend';
import { loadConfig } from '../config/env.js';
import { AuditWriter } from '../common/audit/audit.writer.js';
import { InvoiceSettlementProjectionRepository } from '../modules/settlements/invoice-settlement-projection.repository.js';
import { HistoricalSettlementReconciliationRepository } from '../modules/settlements/historical-settlement-reconciliation.repository.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const USAGE =
  'usage: node dist/scripts/reconcile-historical-settlements.js --tenant <uuid> --company <uuid> [--branch <uuid>] [--cursor <uuid>] [--limit 1-100]';

function arg(name: string, envName: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[envName];
}

interface ParsedArgs {
  tenantId: string;
  companyId: string;
  branchId: string | null;
  cursor: string | null;
  limit: number;
}

/** Fails closed on any malformed operator input — never silently
 *  reinterprets it into a different (and possibly broader) scope. The
 *  in-range clamp to the repository's own hard ceiling stays inside
 *  `HistoricalSettlementReconciliationRepository` itself (defense in
 *  depth); this layer rejects what's simply invalid. */
function parseArgs(): ParsedArgs | { error: string } {
  const tenantId = arg('tenant', 'RECONCILE_TENANT_ID');
  const companyId = arg('company', 'RECONCILE_COMPANY_ID');
  const branchId = arg('branch', 'RECONCILE_BRANCH_ID') ?? null;
  const cursor = arg('cursor', 'RECONCILE_CURSOR') ?? null;
  const limitRaw = arg('limit', 'RECONCILE_LIMIT');

  if (!tenantId) return { error: 'missing --tenant' };
  if (!UUID_RE.test(tenantId)) return { error: `--tenant is not a UUID: ${tenantId}` };
  if (!companyId) return { error: 'missing --company' };
  if (!UUID_RE.test(companyId)) return { error: `--company is not a UUID: ${companyId}` };
  if (branchId !== null && !UUID_RE.test(branchId)) {
    return { error: `--branch is not a UUID: ${branchId}` };
  }
  if (cursor !== null && !UUID_RE.test(cursor)) {
    return { error: `--cursor is not a UUID: ${cursor}` };
  }

  let limit = 100;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) {
      return { error: `--limit must be a positive integer, got: ${limitRaw}` };
    }
    limit = Number(limitRaw);
    if (limit <= 0) return { error: `--limit must be > 0, got: ${limitRaw}` };
  }

  return { tenantId, companyId, branchId, cursor, limit };
}

async function main(): Promise<void> {
  const parsed = parseArgs();
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const db = new DbService(config);
  try {
    const projection = new InvoiceSettlementProjectionRepository();
    const audit = new AuditWriter(db);
    const reconciliation = new HistoricalSettlementReconciliationRepository(db, projection, audit);

    const result = await reconciliation.runBatch(parsed);
    console.log(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    // never the config/DATABASE_URL — only the error's own message.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
