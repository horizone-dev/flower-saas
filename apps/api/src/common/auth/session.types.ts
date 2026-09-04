// Thin re-export barrel (task 2.5) — moved to `@flower/backend`. See
// `jwt.service.ts` in this directory for why.
export {
  type SessionData,
  type AccessTokenClaims,
  type Realm,
  isStepUpActive,
} from '@flower/backend';
