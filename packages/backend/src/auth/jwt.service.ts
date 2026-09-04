import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { BACKEND_CONFIG, type BackendConfig } from '../config/backend-env.js';
import type { AccessTokenClaims, Realm } from './session.types.js';

export class TokenInvalidError extends Error {
  constructor(detail: string) {
    super(`access token invalid: ${detail}`);
    this.name = 'TokenInvalidError';
  }
}

const ISSUER = 'flower-saas';

/**
 * Short-lived access tokens (HS256). The token carries only `sid` + `aud` (the
 * realm) — the server-side session is the authority and the revocation point.
 * Separate audiences (`tenant` / `platform`) make the two realms non-crossable
 * at the token layer.
 *
 * Moved here (task 2.5, from `apps/api/src/common/auth/jwt.service.ts`) so
 * `apps/realtime` can **verify** the identical token the way `apps/api` does —
 * one issuer, one key-derivation, one claim shape, never duplicated (the whole
 * point of this extraction: token semantics cannot drift between the two
 * processes). `apps/realtime` never signs a token — only `apps/api`'s
 * login/refresh flow does — but `sign` stays here too rather than split across
 * packages, since it shares the same key/issuer/claim-shape state as `verify`
 * and splitting them would itself be a drift risk.
 *
 * `@Inject(BACKEND_CONFIG)` matches `DbService`'s exact pattern — resolvable via
 * Nest DI (`apps/api`) or plain `new JwtService(config)` construction (any
 * non-Nest runtime, e.g. `apps/realtime`; see `DbService`'s worker-integration-test
 * usage for precedent).
 */
@Injectable()
export class JwtService {
  private readonly key: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(@Inject(BACKEND_CONFIG) config: BackendConfig) {
    const secret = config.AUTH_JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('AUTH_JWT_SECRET must be set (>= 32 chars)');
    }
    this.key = new TextEncoder().encode(secret);
    this.ttlSeconds = config.AUTH_ACCESS_TOKEN_TTL_SECONDS;
  }

  async sign(claims: Omit<AccessTokenClaims, 'typ'>): Promise<string> {
    return new SignJWT({ ...claims, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(claims.aud)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string, expectedRealm: Realm): Promise<AccessTokenClaims> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: expectedRealm }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new TokenInvalidError('expired');
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        throw new TokenInvalidError(`claim: ${err.claim}`);
      }
      throw new TokenInvalidError('signature or format');
    }
    if (payload['typ'] !== 'access') throw new TokenInvalidError('not an access token');
    if (typeof payload.sub !== 'string' || typeof payload['sid'] !== 'string') {
      throw new TokenInvalidError('missing sub/sid');
    }
    const claims: AccessTokenClaims = {
      sub: payload.sub,
      sid: payload['sid'],
      aud: expectedRealm,
      typ: 'access',
    };
    if (typeof payload['tid'] === 'string') claims.tid = payload['tid'];
    return claims;
  }
}
