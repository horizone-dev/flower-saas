import { describe, expect, it } from 'vitest';
import { resolvePostgresImage } from './containers.js';

const PINNED_17_11 =
  'postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f';
const PINNED_17_12 =
  'postgres:17.12@sha256:97fb53376be3e4fb1a8a61421daa69dcc3bf2fa39bda3259f5245f9a455af1a9';

describe('resolvePostgresImage (pure)', () => {
  it('defaults to the digest-pinned 17.11 CI test image', () => {
    expect(resolvePostgresImage({})).toBe(PINNED_17_11);
    expect(resolvePostgresImage({ FLOWER_TEST_POSTGRES_IMAGE: '' })).toBe(PINNED_17_11);
  });

  it('accepts a digest-pinned postgres:17.x override', () => {
    expect(resolvePostgresImage({ FLOWER_TEST_POSTGRES_IMAGE: PINNED_17_12 })).toBe(PINNED_17_12);
  });

  it.each([
    'postgres:17',
    'postgres:17.12',
    'postgres:latest',
    'postgres@sha256:97fb53376be3e4fb1a8a61421daa69dcc3bf2fa39bda3259f5245f9a455af1a9',
    'postgres:18.1@sha256:97fb53376be3e4fb1a8a61421daa69dcc3bf2fa39bda3259f5245f9a455af1a9',
    'postgres:17.12@sha256:97FB53376BE3E4FB1A8A61421DAA69DCC3BF2FA39BDA3259F5245F9A455AF1A9',
    'postgres:17.12@sha256:97fb5337',
    'evil.example/postgres:17.12@sha256:97fb53376be3e4fb1a8a61421daa69dcc3bf2fa39bda3259f5245f9a455af1a9',
    ' postgres:17.12@sha256:97fb53376be3e4fb1a8a61421daa69dcc3bf2fa39bda3259f5245f9a455af1a9',
    'postgres:17.12@sha256:97fb53376be3e4fb1a8a61421daa69dcc3bf2fa39bda3259f5245f9a455af1a9\n',
  ])('rejects a floating or foreign override %j', (value) => {
    expect(() => resolvePostgresImage({ FLOWER_TEST_POSTGRES_IMAGE: value })).toThrow(
      /digest-pinned postgres:17\.x/,
    );
  });
});
