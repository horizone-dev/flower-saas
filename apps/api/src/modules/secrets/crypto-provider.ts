import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';

/** A sealed secret — three opaque byte blobs, stored as-is in `provider_credential`. */
export interface SealedSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  /** the per-tenant data-encryption key, wrapped by the master key */
  dekWrapped: Uint8Array;
}

export interface CryptoContext {
  tenantId: string;
}

/**
 * Envelope encryption for external credentials (CLAUDE.md §27). The concrete
 * provider is swappable: `dev` (this file, env master key — OD4) or a managed
 * KMS. The interface never exposes a key; callers hand it plaintext + a tenant
 * context and get back / recover opaque blobs.
 */
export abstract class CryptoProvider {
  abstract encrypt(plaintext: string, ctx: CryptoContext): Promise<SealedSecret>;
  abstract decrypt(sealed: SealedSecret, ctx: CryptoContext): Promise<string>;
}

export const CRYPTO_PROVIDER = Symbol('CRYPTO_PROVIDER');

const ALG = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

/**
 * Dev / CI provider: AES-256-GCM with a fresh per-secret DEK, itself wrapped by a
 * 32-byte key derived (SHA-256) from `SECRETS_MASTER_KEY`. The `tenantId` is the
 * GCM additional-authenticated-data on both layers, so a blob cannot be replayed
 * under another tenant. **Never used in production** — `loadConfig` refuses
 * `SECRETS_PROVIDER=dev` there (G16).
 */
@Injectable()
export class DevCryptoProvider extends CryptoProvider {
  private readonly masterKey: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.masterKey = createHash('sha256').update(config.SECRETS_MASTER_KEY, 'utf8').digest();
  }

  async encrypt(plaintext: string, ctx: CryptoContext): Promise<SealedSecret> {
    const dek = randomBytes(DEK_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const ciphertext = seal(dek, nonce, Buffer.from(plaintext, 'utf8'), ctx.tenantId);

    const dekNonce = randomBytes(NONCE_BYTES);
    const dekWrapped = Buffer.concat([dekNonce, seal(this.masterKey, dekNonce, dek, ctx.tenantId)]);
    return { ciphertext, nonce, dekWrapped };
  }

  async decrypt(sealed: SealedSecret, ctx: CryptoContext): Promise<string> {
    const wrapped = Buffer.from(sealed.dekWrapped);
    const dekNonce = wrapped.subarray(0, NONCE_BYTES);
    const dek = open(this.masterKey, dekNonce, wrapped.subarray(NONCE_BYTES), ctx.tenantId);
    const plaintext = open(
      dek,
      Buffer.from(sealed.nonce),
      Buffer.from(sealed.ciphertext),
      ctx.tenantId,
    );
    return plaintext.toString('utf8');
  }
}

/** GCM encrypt → `authTag || ciphertext`. */
function seal(key: Buffer, nonce: Buffer, data: Buffer, aad: string): Buffer {
  const cipher = createCipheriv(ALG, key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), body]);
}

/** inverse of {@link seal}. */
function open(key: Buffer, nonce: Buffer, blob: Buffer, aad: string): Buffer {
  const tag = blob.subarray(0, TAG_BYTES);
  const body = blob.subarray(TAG_BYTES);
  const decipher = createDecipheriv(ALG, key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
