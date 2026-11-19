/**
 * Production bootstrap of the FIRST platform operator — the pure policy core (the CLI and the tests call this).
 *
 * Why a CLI and not a route: before any operator exists there is no one to authorise a route, and an unauthenticated "create the first
 * admin" endpoint is exactly the bootstrap token we must not expose. The CLI runs on the operator's own terminal with database access
 * (PLATFORM_DATABASE_URL) and bypasses nothing: login still needs the password AND the TOTP code (`AuthService.platformLogin`).
 *
 * Rules enforced here, before anything is written:
 *  - a real email, a name, a strong operator-chosen password (never generated, never an argument/env value — the CLI reads it from a TTY);
 *  - possession of the authenticator is PROVEN: the operator must enter a current code for the generated secret; only then is the factor
 *    stored, already CONFIRMED (so there is no unconfirmed-factor state to attack).
 */
import {
  OperatorBootstrapRefused,
  type NewOperator,
} from './platform-operator-bootstrap.repository.js';

export interface BootstrapDeps {
  hashPassword(plain: string): Promise<string>;
  verifyTotp(code: string, secret: string): boolean;
  repo: { create(input: NewOperator): Promise<{ operatorId: string }> };
}

export class BootstrapInputError extends Error {
  constructor(
    readonly code: 'EMAIL_INVALID' | 'NAME_REQUIRED' | 'PASSWORD_WEAK' | 'TOTP_NOT_PROVEN',
    message: string,
  ) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** operator password policy: ≥ 14 characters, not a single repeated character, not containing the email's local part */
export function assertStrongPassword(password: string, email: string): void {
  const local = email.split('@')[0]!.toLowerCase();
  if (
    password.length < 14 ||
    password.length > 200 ||
    /^(.)\1+$/.test(password) ||
    (local.length >= 4 && password.toLowerCase().includes(local))
  ) {
    throw new BootstrapInputError(
      'PASSWORD_WEAK',
      'the password must be 14–200 characters, not one repeated character, and must not contain your email name',
    );
  }
}

export async function bootstrapPlatformOperator(
  deps: BootstrapDeps,
  input: {
    email: string;
    name: string;
    password: string;
    totpSecret: string;
    /** the 6-digit code the operator read from their authenticator for `totpSecret` */
    totpCode: string;
    allowAdditional?: boolean;
  },
): Promise<{ operatorId: string }> {
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new BootstrapInputError('EMAIL_INVALID', 'enter a valid email address');
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new BootstrapInputError('NAME_REQUIRED', 'enter the operator name');
  }
  assertStrongPassword(input.password, email);
  if (
    !/^\d{6}$/.test(input.totpCode.trim()) ||
    !deps.verifyTotp(input.totpCode.trim(), input.totpSecret)
  ) {
    throw new BootstrapInputError(
      'TOTP_NOT_PROVEN',
      'the authenticator code is wrong: add the secret to your authenticator app and enter the CURRENT 6-digit code',
    );
  }
  const passwordHash = await deps.hashPassword(input.password);
  return deps.repo.create({
    email,
    name,
    passwordHash,
    totpSecret: input.totpSecret,
    allowAdditional: input.allowAdditional === true,
  });
}

export { OperatorBootstrapRefused };
