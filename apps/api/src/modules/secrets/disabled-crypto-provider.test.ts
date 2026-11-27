import { describe, expect, it } from 'vitest';
import { DisabledCryptoProvider } from './crypto-provider.js';

describe('R-1: the disabled secrets provider fails CLOSED', () => {
  const p = new DisabledCryptoProvider();
  const ctx = { tenantId: '00000000-0000-7000-8000-000000000001' };

  it('refuses to seal any secret (503 SECRETS_DISABLED) and never returns a blob', async () => {
    await expect(p.encrypt('sk_live_123', ctx)).rejects.toMatchObject({
      code: 'SECRETS_DISABLED',
      status: 503,
    });
  });

  it('refuses to open any secret', async () => {
    await expect(
      p.decrypt(
        {
          ciphertext: new Uint8Array(1),
          nonce: new Uint8Array(12),
          dekWrapped: new Uint8Array(40),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'SECRETS_DISABLED', status: 503 });
  });

  it('never echoes the plaintext in the error', async () => {
    const err = await p.encrypt('super-secret-value', ctx).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('super-secret-value');
  });
});
