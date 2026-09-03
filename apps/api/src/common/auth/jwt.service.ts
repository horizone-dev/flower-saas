import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
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
 */
@Injectable()
export class JwtService {
  private readonly key: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
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
