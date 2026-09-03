import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing (SECURITY.md). `@node-rs/argon2` defaults to
 * Argon2id; parameters follow the OWASP minimum (m = 19 MiB, t = 2, p = 1) —
 * recorded in an ADR (OI1); tune upward once the CI runner's timing is measured.
 */
@Injectable()
export class PasswordService {
  private readonly opts = {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  hash(plain: string): Promise<string> {
    return hash(plain, this.opts);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain, this.opts);
    } catch {
      return false;
    }
  }
}
