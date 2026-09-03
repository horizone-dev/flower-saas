// Prisma 7 config — used by the Prisma CLI (migrate / db pull / studio).
// The runtime client (src/client.ts) does NOT read this; it takes a pg driver
// adapter built from DATABASE_URL.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const url = process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // CLI-only connection string. In CI/tests this is set to the throwaway
  // Testcontainers Postgres; locally it comes from .env (docker compose).
  ...(url ? { datasource: { url } } : {}),
});
