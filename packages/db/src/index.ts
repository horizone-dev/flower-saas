export {
  PrismaClient,
  createPrismaClient,
  databaseUrlFromEnv,
  type Prisma,
  type CreateClientOptions,
} from './client.js';

/** Schema-baseline marker key stored in `app_meta` by the baseline migration/seed. */
export const SCHEMA_BASELINE_KEY = 'schema_baseline';
