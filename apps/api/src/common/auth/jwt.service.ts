// Thin re-export barrel (task 2.5) — the implementation moved to
// `@flower/backend` (`packages/backend/src/auth/jwt.service.ts`) so
// `apps/realtime` verifies tokens with the identical class, never a
// duplicated copy. Zero import-path churn for the ~4 files in this app that
// still `import { JwtService } from './jwt.service.js'` (same pattern task
// 2.3 used for `common/{context,data,db,logger}`).
export { JwtService, TokenInvalidError } from '@flower/backend';
