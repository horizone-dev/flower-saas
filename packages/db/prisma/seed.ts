/**
 * Seed skeleton (Phase 0). No domain data — just an idempotent `app_meta` marker
 * proving the client + migration chain works end to end. Real fixtures (a demo
 * tenant, seeded roles/permissions/country config) arrive with Phase 1
 * provisioning.
 */
import 'dotenv/config';
import { createPrismaClient, databaseUrlFromEnv } from '../src/client.js';
import { SCHEMA_BASELINE_KEY } from '../src/index.js';

async function main(): Promise<void> {
  const prisma = createPrismaClient({ connectionString: databaseUrlFromEnv() });
  try {
    await prisma.appMeta.upsert({
      where: { key: SCHEMA_BASELINE_KEY },
      create: { key: SCHEMA_BASELINE_KEY, value: 'v0.4' },
      update: { value: 'v0.4' },
    });
    const rows = await prisma.appMeta.findMany();
    console.log(`seed ok — app_meta has ${rows.length} row(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
