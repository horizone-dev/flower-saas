import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import { RedisService } from '../../common/redis/redis.module.js';
import { LimitService } from '../platform/limit.service.js';
import { StaffOnboardingRepository } from './staff-onboarding.repository.js';

/**
 * F-7 (PROPOSED, NOT registered in any module, NO route) — create a staff user and issue a one-time invite (the existing set-password flow).
 *
 * Authority is decided by the CALLER (a platform-realm route guarded by the existing `platform:tenant_users:manage`, step-up MFA, no new
 * permission); this service enforces the rules that make the operation safe whatever the caller:
 *  - ONLY allow-listed, non-owner roles can be onboarded ({@link ONBOARDABLE_ROLE_KEYS}); owner/admin/accountant are never created here;
 *  - the scope is EXPLICIT: at least one company and one branch, never "all"; ids are checked against the tenant in the repository;
 *  - one email per workspace (409, and the raw invite token is NEVER returned or cached a second time);
 *  - the plan's `max_users` limit is enforced under a tenant lock;
 *  - the invite token is 256-bit random, only its SHA-256 is stored, it expires in {@link INVITE_TTL_MS} and is single-use (consumed by the
 *    existing `POST /v1/auth/set-password`);
 *  - abuse protection: a per-actor and a per-workspace invite budget in Redis, FAIL-CLOSED when Redis is unavailable.
 */
export const ONBOARDABLE_ROLE_KEYS: readonly string[] = Object.freeze(['cashier', 'sales']);
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const ACTOR_INVITES_PER_HOUR = 20;
export const TENANT_INVITES_PER_DAY = 50;
const MAX_IDS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// deliberately simple: one @, no spaces, a dot in the domain; the invite itself proves the address is reachable
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteStaffCommand {
  tenantId: string;
  email: string;
  roleKey: string;
  companyIds: readonly string[];
  branchIds: readonly string[];
  actorPlatformUserId: string;
}

export interface InviteStaffResult {
  userId: string;
  roleKey: string;
  /** returned ONCE; only its hash is stored */
  setPasswordToken: string;
  expiresAt: string;
}

export function normaliseEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > 254 || !EMAIL_RE.test(e)) {
    throw new DomainError('EMAIL_INVALID', 'enter a valid email address', 422);
  }
  return e;
}

function uniqueIds(ids: readonly string[], field: string): string[] {
  const out = [...new Set(ids.map((i) => i.trim().toLowerCase()))];
  if (out.length === 0) {
    throw new DomainError(
      'SCOPE_REQUIRED',
      `at least one ${field} is required (staff are never given all-access)`,
      422,
    );
  }
  if (out.length > MAX_IDS || out.some((i) => !UUID_RE.test(i))) {
    throw new DomainError('SCOPE_INVALID', `invalid ${field} list`, 422);
  }
  return out;
}

@Injectable()
export class StaffOnboardingService {
  constructor(
    private readonly repo: StaffOnboardingRepository,
    private readonly limits: LimitService,
    private readonly redis: RedisService,
  ) {}

  /** a fixed-window counter; refuses (429) once the budget for the window is used. FAIL-CLOSED without Redis. */
  private async spend(key: string, max: number, windowSec: number): Promise<void> {
    const client = this.redis.require();
    const n = await client.incr(key);
    if (n === 1) await client.expire(key, windowSec);
    if (n > max) {
      throw new DomainError('INVITE_RATE_LIMITED', 'too many staff invitations, try later', 429);
    }
  }

  async inviteStaff(cmd: InviteStaffCommand): Promise<InviteStaffResult> {
    if (!cmd.actorPlatformUserId) {
      throw new DomainError('ACTOR_REQUIRED', 'an authenticated platform actor is required', 401);
    }
    if (!UUID_RE.test(cmd.tenantId)) throw new DomainError('TENANT_INVALID', 'invalid tenant', 422);
    if (!ONBOARDABLE_ROLE_KEYS.includes(cmd.roleKey)) {
      throw new DomainError(
        'ROLE_NOT_ONBOARDABLE',
        `only ${ONBOARDABLE_ROLE_KEYS.join(' / ')} staff can be created here`,
        422,
      );
    }
    const email = normaliseEmail(cmd.email);
    const companyIds = uniqueIds(cmd.companyIds, 'company');
    const branchIds = uniqueIds(cmd.branchIds, 'branch');

    // the budget is spent BEFORE any work, and is not refunded on a later refusal: probing is what it limits
    await this.spend(`staff-invite:actor:${cmd.actorPlatformUserId}`, ACTOR_INVITES_PER_HOUR, 3600);
    await this.spend(`staff-invite:tenant:${cmd.tenantId}`, TENANT_INVITES_PER_DAY, 86_400);

    const maxUsers = await this.limits.valueOf(cmd.tenantId, 'max_users');
    const token = randomBytes(32).toString('base64url');
    const tokenExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const { userId } = await this.repo.createStaffUser({
      tenantId: cmd.tenantId,
      email,
      roleKey: cmd.roleKey,
      companyIds,
      branchIds,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      tokenExpiresAt,
      maxUsers: maxUsers === Number.MAX_SAFE_INTEGER ? null : maxUsers,
      actorPlatformUserId: cmd.actorPlatformUserId,
    });
    return {
      userId,
      roleKey: cmd.roleKey,
      setPasswordToken: token,
      expiresAt: tokenExpiresAt.toISOString(),
    };
  }
}
