import type { AccountType, MfaLevel } from '../context/index.js';

/** Which auth realm a token / session belongs to. Never cross-grantable. */
export type Realm = 'tenant' | 'platform';

/**
 * The server-side session record (Redis in prod — Phase 1 task 1.5). The access
 * JWT is short-lived and carries only `sid`; everything authoritative lives here,
 * so revocation is immediate. The resolved access snapshot is computed at login /
 * token-refresh (Phase 1 `PolicyService`) and cached here — a role/scope change
 * bumps the session.
 *
 * Moved here (task 2.5) from `apps/api/src/common/auth/session.types.ts` so
 * `apps/realtime` can resolve the identical session shape without duplicating the
 * definition — see `packages/backend/src/auth/index.ts`'s module doc comment.
 */
export interface SessionData {
  sessionId: string;
  realm: Realm;
  /** the refresh-token family for this session (revoked on logout / reuse) */
  familyId: string;
  tenantId: string | null;
  userId: string | null;
  platformUserId: string | null;
  accountType: AccountType;
  posTerminalId: string | null;
  deviceId: string | null;

  mfaLevel: MfaLevel;
  /** epoch ms until which `mfaLevel === 'STEP_UP'` is honoured */
  stepUpUntil: number | null;

  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokeReason: string | null;

  /** set while an impersonated session is active (OD7 — read-only) */
  impersonatorPlatformUserId: string | null;

  /** resolved access snapshot (tenant realm only) */
  access: {
    effectivePermissions: string[];
    companyScope: 'ALL' | string[];
    branchScope: 'ALL' | string[];
    perBranchOverlay: Record<string, string[]>;
    entitledModules: string[];
    planKey: string | null;
  } | null;
}

/** Claims in the short-lived access JWT. */
export interface AccessTokenClaims {
  sub: string; // userId | platformUserId
  sid: string; // sessionId
  aud: Realm;
  typ: 'access';
  tid?: string; // tenantId (tenant realm)
}

export function isStepUpActive(
  s: Pick<SessionData, 'mfaLevel' | 'stepUpUntil'>,
  now = Date.now(),
): boolean {
  return s.mfaLevel === 'STEP_UP' && s.stepUpUntil !== null && s.stepUpUntil > now;
}
