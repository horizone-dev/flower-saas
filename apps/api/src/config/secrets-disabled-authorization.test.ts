import { describe, expect, it } from 'vitest';
import { createRootLogger } from '@flower/backend';
import { EnvValidationError, loadConfig } from './env.js';

/**
 * R-1a: the fail-closed `disabled` secrets vault needs an EXPLICIT, TIME-BOXED "internal alpha only" authorization.
 *   SECRETS_DISABLED_AUTHORIZATION=internal-alpha-only   (exact literal)
 *   SECRETS_DISABLED_UNTIL=YYYY-MM-DD                    (a real calendar date, today (UTC) .. today + 90 days)
 * It is required in EVERY NODE_ENV, and refused when the provider is not `disabled` (no latent authorization).
 * The production path for every other provider is unchanged: `dev` is refused, `kms` needs a real master key.
 */
const NOW = new Date('2026-12-01T12:00:00.000Z');
const LITERAL = 'internal-alpha-only';

const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://x',
  AUTH_JWT_SECRET: 'a-real-production-jwt-secret-value-32+',
  SECRETS_MASTER_KEY: 'a-real-production-master-key-value-32+chars',
  CORS_ORIGINS: 'https://pos.acme.com',
};
const authorized = {
  SECRETS_PROVIDER: 'disabled',
  SECRETS_DISABLED_AUTHORIZATION: LITERAL,
  SECRETS_DISABLED_UNTIL: '2026-12-31',
};

const refusesWith = (env: Record<string, string>, re: RegExp, now: Date = NOW) => {
  let err: unknown;
  try {
    loadConfig(env, now);
  } catch (e) {
    err = e;
  }
  expect(err, 'loadConfig must throw').toBeInstanceOf(EnvValidationError);
  expect((err as Error).message).toMatch(re);
};

describe('R-1a: SECRETS_PROVIDER=disabled needs an explicit internal-alpha-only authorization', () => {
  it('production: authorized and in the window -> boots, and the authorization is carried in the config', () => {
    const cfg = loadConfig({ ...prod, ...authorized }, NOW);
    expect(cfg.SECRETS_PROVIDER).toBe('disabled');
    expect(cfg.SECRETS_DISABLED_AUTHORIZATION).toBe(LITERAL);
    expect(cfg.SECRETS_DISABLED_UNTIL).toBe('2026-12-31');
  });

  it('production: disabled WITHOUT the authorization is refused (the R-1 hole: it used to boot)', () => {
    refusesWith(
      { ...prod, SECRETS_PROVIDER: 'disabled', SECRETS_DISABLED_UNTIL: '2026-12-31' },
      /SECRETS_DISABLED_AUTHORIZATION/,
    );
    refusesWith({ ...prod, SECRETS_PROVIDER: 'disabled' }, /SECRETS_DISABLED_AUTHORIZATION/);
  });

  it('production: disabled with the authorization but WITHOUT a date is refused', () => {
    refusesWith(
      { ...prod, SECRETS_PROVIDER: 'disabled', SECRETS_DISABLED_AUTHORIZATION: LITERAL },
      /SECRETS_DISABLED_UNTIL/,
    );
  });

  it('every NODE_ENV needs it: development and test refuse an unauthorized disabled vault too', () => {
    for (const NODE_ENV of ['development', 'test']) {
      refusesWith({ NODE_ENV, SECRETS_PROVIDER: 'disabled' }, /SECRETS_DISABLED_AUTHORIZATION/);
      expect(() => loadConfig({ NODE_ENV, ...authorized }, NOW)).not.toThrow();
    }
    // NODE_ENV unset defaults to development: same rule
    refusesWith({ SECRETS_PROVIDER: 'disabled' }, /SECRETS_DISABLED_AUTHORIZATION/);
  });

  it('only the exact literal authorizes: wrong case, padding, truthy words, other scopes are all refused', () => {
    for (const bad of [
      'INTERNAL-ALPHA-ONLY',
      'Internal-Alpha-Only',
      ' internal-alpha-only',
      'internal-alpha-only ',
      'internal-alpha-only\n',
      'internal_alpha_only',
      'internal-alpha',
      'internal-alpha-only,public',
      'true',
      '1',
      'yes',
      'production',
      'pilot',
      ' ',
    ]) {
      refusesWith(
        { ...prod, ...authorized, SECRETS_DISABLED_AUTHORIZATION: bad },
        /SECRETS_DISABLED_AUTHORIZATION/,
      );
    }
  });

  it('the authorization is a time box: today (UTC) is the last valid day for an expiry of today, +90 days the furthest', () => {
    const ok = (d: string) =>
      expect(() =>
        loadConfig({ ...prod, ...authorized, SECRETS_DISABLED_UNTIL: d }, NOW),
      ).not.toThrow();
    const no = (d: string) =>
      refusesWith({ ...prod, ...authorized, SECRETS_DISABLED_UNTIL: d }, /SECRETS_DISABLED_UNTIL/);
    ok('2026-12-01'); // expires at the end of today
    ok('2027-03-01'); // today + 90 days
    no('2026-11-30'); // yesterday: expired
    no('2027-03-02'); // today + 91 days: too long an authorization
    no('2099-12-31'); // "forever"
    no('2020-01-01');
  });

  it('the expiry is judged in UTC, not in local time (forced in the two extreme zones, so a UTC runner cannot pass vacuously)', () => {
    const until = { ...prod, ...authorized, SECRETS_DISABLED_UNTIL: '2026-12-01' };
    const savedTz = process.env['TZ'];
    try {
      // UTC+14 (a local clock a day AHEAD of UTC) and UTC-12 (a day BEHIND): a local-time implementation is wrong in one of them
      // at the boundary instants below, whatever zone the machine running the suite is in.
      for (const [tz, hourAtEndOfUtcDay] of [
        ['Etc/GMT-14', 13],
        ['Etc/GMT+12', 11],
      ] as const) {
        process.env['TZ'] = tz;
        // guard: the zone must really have taken effect in this worker, otherwise the assertions below would prove nothing
        expect(
          new Date('2026-12-01T23:59:59.999Z').getHours(),
          `could not force TZ=${tz} in this test worker`,
        ).toBe(hourAtEndOfUtcDay);
        expect(() => loadConfig(until, new Date('2026-12-01T23:59:59.999Z'))).not.toThrow();
        refusesWith(until, /SECRETS_DISABLED_UNTIL/, new Date('2026-12-02T00:00:00.000Z'));
        // 2026-12-02 00:30 in UTC+3 is still 2026-12-01 21:30Z
        expect(() => loadConfig(until, new Date('2026-12-02T00:30:00+03:00'))).not.toThrow();
        // and the far end: today + 90 days is the last accepted expiry, judged on the UTC day
        const far = { ...prod, ...authorized, SECRETS_DISABLED_UNTIL: '2027-03-01' };
        expect(() => loadConfig(far, new Date('2026-12-01T00:00:00.000Z'))).not.toThrow();
        expect(() => loadConfig(far, new Date('2026-12-01T23:59:59.999Z'))).not.toThrow();
        refusesWith(far, /SECRETS_DISABLED_UNTIL/, new Date('2026-11-30T23:59:59.999Z'));
      }
    } finally {
      if (savedTz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = savedTz;
    }
  });

  it('only a real YYYY-MM-DD calendar date counts (never truncated, never reinterpreted)', () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-12-00',
      '2026-12-32',
      '2026-12-1',
      '2026-1-10',
      '26-12-10',
      '20261210',
      '2026/12/10',
      '12-10-2026',
      '2026-12-10T00:00:00Z',
      '2026-12-10 ',
      ' 2026-12-10',
      'tomorrow',
      'never',
      '0000-01-01',
      '+2026-12-10',
      '2026-12-10\n',
    ]) {
      refusesWith(
        { ...prod, ...authorized, SECRETS_DISABLED_UNTIL: bad },
        /SECRETS_DISABLED_UNTIL/,
      );
    }
    // leap day: 2028-02-29 exists, 2027-02-29 does not
    const leap = { ...prod, ...authorized, SECRETS_DISABLED_UNTIL: '2028-02-29' };
    expect(() => loadConfig(leap, new Date('2028-02-01T00:00:00Z'))).not.toThrow();
    refusesWith(
      { ...leap, SECRETS_DISABLED_UNTIL: '2027-02-29' },
      /SECRETS_DISABLED_UNTIL/,
      new Date('2027-02-01T00:00:00Z'),
    );
  });

  it('an unusable clock fails closed', () => {
    refusesWith({ ...prod, ...authorized }, /SECRETS_DISABLED_UNTIL/, new Date(Number.NaN));
  });

  it('no latent authorization: it is refused with any provider other than disabled', () => {
    for (const SECRETS_PROVIDER of ['kms', 'dev']) {
      const env = {
        ...prod,
        SECRETS_PROVIDER,
        SECRETS_DISABLED_AUTHORIZATION: LITERAL,
      };
      refusesWith(env, /SECRETS_DISABLED_AUTHORIZATION/);
      refusesWith(
        { ...env, SECRETS_DISABLED_AUTHORIZATION: '', SECRETS_DISABLED_UNTIL: '2026-12-31' },
        /SECRETS_DISABLED_UNTIL/,
      );
    }
    // development with the (default) dev provider as well
    refusesWith({ SECRETS_DISABLED_AUTHORIZATION: LITERAL }, /SECRETS_DISABLED_AUTHORIZATION/);
    // an EMPTY value is "not set" (compose passes `${VAR:-}`), so a kms deployment is unaffected
    expect(() =>
      loadConfig(
        {
          ...prod,
          SECRETS_PROVIDER: 'kms',
          SECRETS_DISABLED_AUTHORIZATION: '',
          SECRETS_DISABLED_UNTIL: '',
        },
        NOW,
      ),
    ).not.toThrow();
  });

  it('the KMS-required production path is unchanged', () => {
    // unset provider defaults to dev, which production refuses
    refusesWith(prod, /SECRETS_PROVIDER/);
    refusesWith({ ...prod, SECRETS_PROVIDER: 'dev' }, /SECRETS_PROVIDER/);
    // dev stays unusable even with a valid authorization attached
    refusesWith({ ...prod, ...authorized, SECRETS_PROVIDER: 'dev' }, /SECRETS_(PROVIDER|DISABLED)/);
    // kms still demands a real master key and still passes the environment check with one
    expect(() => loadConfig({ ...prod, SECRETS_PROVIDER: 'kms' }, NOW)).not.toThrow();
    refusesWith(
      {
        ...prod,
        SECRETS_PROVIDER: 'kms',
        SECRETS_MASTER_KEY: 'dev-only-insecure-secrets-master-key-change-me-000',
      },
      /SECRETS_MASTER_KEY/,
    );
    // the other production guards still apply to an authorized disabled vault
    refusesWith({ ...prod, ...authorized, CORS_ORIGINS: '*' }, /CORS_ORIGINS/);
    refusesWith(
      { ...prod, ...authorized, AUTH_JWT_SECRET: 'dev-only-insecure-jwt-secret-change-me-000' },
      /AUTH_JWT_SECRET/,
    );
    refusesWith({ ...prod, ...authorized, DATABASE_URL: '' }, /DATABASE_URL/);
  });

  it('the refusal is explained in the REAL log line (the logger keeps one templated line, so the reason must live in the first line)', () => {
    // `createRootLogger(destination)` is the shared production logger with its safe serializers; the destination lets a test read what an
    // operator would see in `docker logs`. Without a summary in the first line the log said only "Invalid environment:".
    const lines: string[] = [];
    const log = createRootLogger({ write: (s: string) => void lines.push(s) } as never);
    log.level = 'trace'; // the vitest environment sets LOG_LEVEL=silent
    const cases: Array<[Record<string, string>, RegExp]> = [
      [
        { ...prod, SECRETS_PROVIDER: 'disabled' },
        /secrets vault disabled without a valid internal-alpha-only authorization/,
      ],
      [
        { ...prod, ...authorized, SECRETS_DISABLED_UNTIL: '2026-11-30' },
        /secrets vault disabled without a valid internal-alpha-only authorization/,
      ],
      [
        { ...prod, SECRETS_PROVIDER: 'kms', SECRETS_DISABLED_AUTHORIZATION: LITERAL },
        /secrets authorization variables set without the disabled vault/,
      ],
    ];
    for (const [env, phrase] of cases) {
      let err: unknown;
      try {
        loadConfig(env, NOW);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EnvValidationError);
      log.fatal({ err }, 'failed to start api');
      const logged = JSON.parse(lines.at(-1) ?? '{}') as { err?: { message?: string } };
      expect(logged.err?.message ?? '', JSON.stringify(logged)).toMatch(phrase);
    }
  });

  it('refusals never echo the supplied value', () => {
    for (const env of [
      { ...prod, ...authorized, SECRETS_DISABLED_AUTHORIZATION: 'hunter2-should-not-leak' },
      { ...prod, ...authorized, SECRETS_DISABLED_UNTIL: 'hunter2-should-not-leak' },
    ]) {
      let msg = '';
      try {
        loadConfig(env, NOW);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe('');
      expect(msg).not.toContain('hunter2-should-not-leak');
    }
  });

  /**
   * Exhaustive environment matrix against an INDEPENDENT oracle: the set of acceptable dates is enumerated day by day
   * (so the implementation's regex / arithmetic is never re-used), everything else is plain table logic.
   */
  it('exhaustive matrix: NODE_ENV x provider x authorization x expiry, accepted exactly when the policy says so', () => {
    const day = 86_400_000;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    const t0 = Date.UTC(2026, 11, 1);
    const window = new Set<string>();
    for (let i = 0; i <= 90; i++) window.add(iso(t0 + i * day));
    expect(window.size).toBe(91);

    const envs = ['development', 'test', 'production'] as const;
    const providers = [undefined, 'dev', 'kms', 'disabled'] as const;
    const auths = [
      undefined,
      '',
      LITERAL,
      'INTERNAL-ALPHA-ONLY',
      ' internal-alpha-only',
      'true',
    ] as const;
    const untils = [
      undefined,
      '',
      '2026-12-01',
      '2027-03-01',
      '2027-03-02',
      '2026-11-30',
      '2026-02-30',
      '2026-12-1',
      '2026-12-10T00:00:00Z',
      'tomorrow',
      '2099-12-31',
    ] as const;

    let accepted = 0;
    let rejected = 0;
    for (const NODE_ENV of envs)
      for (const provider of providers)
        for (const auth of auths)
          for (const until of untils) {
            const env: Record<string, string> =
              NODE_ENV === 'production' ? { ...prod, NODE_ENV } : { NODE_ENV };
            if (provider !== undefined) env['SECRETS_PROVIDER'] = provider;
            if (auth !== undefined) env['SECRETS_DISABLED_AUTHORIZATION'] = auth;
            if (until !== undefined) env['SECRETS_DISABLED_UNTIL'] = until;

            const effective = provider ?? 'dev';
            const authSet = auth !== undefined && auth !== '';
            const untilSet = until !== undefined && until !== '';
            let want: boolean;
            if (effective === 'disabled') {
              want = auth === LITERAL && untilSet && window.has(until);
            } else {
              want = !authSet && !untilSet && !(NODE_ENV === 'production' && effective === 'dev');
            }

            let threw = false;
            try {
              loadConfig(env, NOW);
            } catch (e) {
              expect(e).toBeInstanceOf(EnvValidationError);
              threw = true;
            }
            expect(
              !threw,
              `NODE_ENV=${NODE_ENV} provider=${provider} auth=${JSON.stringify(auth)} until=${JSON.stringify(until)}`,
            ).toBe(want);
            if (want) accepted++;
            else rejected++;
          }
    // the matrix must exercise both outcomes in volume, or the oracle proves nothing
    expect(accepted).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(500);
  });
});
