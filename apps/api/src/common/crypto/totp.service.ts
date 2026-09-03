import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';

/** TOTP (RFC 6238) — the only MFA factor in Phase 1 (OD2). WebAuthn is a later,
 *  separate factor plugged into the same model. */
@Injectable()
export class TotpService {
  generateSecret(): string {
    return authenticator.generateSecret();
  }

  /** otpauth:// URI for a QR code. */
  keyUri(accountName: string, secret: string): string {
    return authenticator.keyuri(accountName, 'Flower SaaS', secret);
  }

  verify(token: string, secret: string): boolean {
    try {
      return authenticator.verify({ token, secret });
    } catch {
      return false;
    }
  }
}
