import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import {
  BootstrapInputError,
  assertStrongPassword,
  bootstrapPlatformOperator,
  type BootstrapDeps,
} from './platform-operator-bootstrap.js';

const SECRET = authenticator.generateSecret();
const good = () => ({
  email: 'Ops.Lead@Flower.Example',
  name: 'Ops Lead',
  password: 'correct horse battery staple 42',
  totpSecret: SECRET,
  totpCode: authenticator.generate(SECRET),
});

function deps(): { d: BootstrapDeps; created: unknown[] } {
  const created: unknown[] = [];
  return {
    created,
    d: {
      hashPassword: async (p) => `hash(${p.length})`,
      verifyTotp: (c, s) => authenticator.verify({ token: c, secret: s }),
      repo: {
        create: async (i) => {
          created.push(i);
          return { operatorId: 'op-1' };
        },
      },
    },
  };
}

describe('first platform operator — bootstrap policy', () => {
  it('creates the operator with a normalised email, a HASH (never the password) and the already-proven TOTP secret', async () => {
    const { d, created } = deps();
    await expect(bootstrapPlatformOperator(d, good())).resolves.toEqual({ operatorId: 'op-1' });
    const c = created[0] as Record<string, unknown>;
    expect(c['email']).toBe('ops.lead@flower.example');
    expect(c['passwordHash']).toBe('hash(31)');
    expect(JSON.stringify(c)).not.toContain('correct horse');
    expect(c['totpSecret']).toBe(SECRET);
    expect(c['allowAdditional']).toBe(false);
  });

  it('refuses a wrong, missing or malformed authenticator code and writes NOTHING (MFA cannot be skipped)', async () => {
    for (const totpCode of ['000000', '', '12345', 'abcdef', '1234567']) {
      const { d, created } = deps();
      await expect(bootstrapPlatformOperator(d, { ...good(), totpCode })).rejects.toMatchObject({
        code: 'TOTP_NOT_PROVEN',
      });
      expect(created).toHaveLength(0);
    }
  });

  it('a code for a DIFFERENT secret does not prove possession of this one', async () => {
    const { d, created } = deps();
    const other = authenticator.generate(authenticator.generateSecret());
    await expect(
      bootstrapPlatformOperator(d, { ...good(), totpCode: other }),
    ).rejects.toBeInstanceOf(BootstrapInputError);
    expect(created).toHaveLength(0);
  });

  it('refuses weak passwords: short, one repeated character, containing the email name', () => {
    expect(() => assertStrongPassword('short', 'a@b.co')).toThrow(/14/);
    expect(() => assertStrongPassword('aaaaaaaaaaaaaaaaaaaa', 'a@b.co')).toThrow(
      BootstrapInputError,
    );
    expect(() => assertStrongPassword('my-ops.lead-password-9', 'ops.lead@flower.example')).toThrow(
      BootstrapInputError,
    );
    expect(() =>
      assertStrongPassword('correct horse battery staple', 'ops@flower.example'),
    ).not.toThrow();
  });

  it('refuses a bad email or an empty name; nothing is written', async () => {
    for (const patch of [
      { email: 'nope' },
      { email: 'a@b' },
      { name: '  ' },
      { password: 'tiny' },
    ]) {
      const { d, created } = deps();
      await expect(bootstrapPlatformOperator(d, { ...good(), ...patch })).rejects.toBeInstanceOf(
        BootstrapInputError,
      );
      expect(created).toHaveLength(0);
    }
  });

  it('adding a second operator needs the explicit flag', async () => {
    const { d, created } = deps();
    await bootstrapPlatformOperator(d, { ...good(), allowAdditional: true });
    expect((created[0] as Record<string, unknown>)['allowAdditional']).toBe(true);
  });
});
