/**
 * R-1a — the env preflight refuses an unauthorized or unsafe disabled-secrets configuration BEFORE the stack starts.
 * Run:  node --test infra/staging/preflight-secrets.test.mjs
 *
 * Every refusal is asserted for the RIGHT reason (a named variable in the message) and the supplied value is never echoed.
 * Dates are relative to the current UTC day, so the suite does not rot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPostgresPin } from './postgres-pin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preflight = path.join(here, 'preflight.mjs');
const dir = mkdtempSync(path.join(tmpdir(), 'flower-preflight-'));
const rnd = () => randomBytes(18).toString('hex');
const day = 86_400_000;
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
const AUTH = 'internal-alpha-only';

function baseEnv(over = {}) {
  const e = {
    POS_HOST: 'pos.alpha.flower-saas.dev',
    OWNER_HOST: 'owner.alpha.flower-saas.dev',
    OPS_HOST: 'ops.alpha.flower-saas.dev',
    ADMIN_CIDR: '203.0.113.0/24',
    // well-formed but fake digests: the preflight requires immutable application images outside --local, and these tests are about the secrets rules
    API_IMAGE: `flower/api@sha256:${'a'.repeat(64)}`,
    POS_IMAGE: `flower/pos@sha256:${'b'.repeat(64)}`,
    OWNER_IMAGE: `flower/owner-web@sha256:${'c'.repeat(64)}`,
    MIGRATE_IMAGE: `flower/migrate@sha256:${'d'.repeat(64)}`,
    POSTGRES_IMAGE: readPostgresPin(),
    MIGRATION_MODE: 'check',
    POSTGRES_SUPERUSER_PASSWORD: rnd(),
    APP_DB_PASSWORD: rnd(),
    PLATFORM_DB_PASSWORD: rnd(),
    REDIS_PASSWORD: rnd(),
    MINIO_ROOT_USER: 'flower_minio',
    MINIO_ROOT_PASSWORD: rnd(),
    AUTH_JWT_SECRET: rnd(),
    SECRETS_PROVIDER: 'disabled',
    SECRETS_DISABLED_AUTHORIZATION: AUTH,
    SECRETS_DISABLED_UNTIL: ymd(30),
    ...over,
  };
  // an explicit `undefined` removes the variable
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));
}

let n = 0;
function run(over, args = []) {
  const f = path.join(dir, `env.${n++}`);
  writeFileSync(
    f,
    Object.entries(baseEnv(over))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
  chmodSync(f, 0o600);
  const r = spawnSync(process.execPath, [preflight, f, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function refused(over, reason, label) {
  const r = run(over);
  assert.equal(
    r.code,
    2,
    `${label ?? JSON.stringify(over)} must be refused, got exit ${r.code}: ${r.out}`,
  );
  assert.match(
    r.out,
    reason,
    `${label ?? JSON.stringify(over)} refused for the wrong reason: ${r.out}`,
  );
  return r;
}

test('control: the base environment is accepted (so every refusal below is caused by the one thing changed)', () => {
  const r = run({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /preflight ok/);
});

test('authorized and inside the window: today, +30 and +90 days are accepted', () => {
  for (const d of [ymd(0), ymd(30), ymd(90)]) {
    const r = run({ SECRETS_DISABLED_UNTIL: d });
    assert.equal(r.code, 0, `${d}: ${r.out}`);
  }
});

test('disabled without the authorization (the R-1 hole) is refused, whichever half is missing', () => {
  refused(
    { SECRETS_DISABLED_AUTHORIZATION: undefined, SECRETS_DISABLED_UNTIL: undefined },
    /SECRETS_DISABLED_AUTHORIZATION is missing/,
    'neither',
  );
  refused(
    { SECRETS_DISABLED_AUTHORIZATION: undefined },
    /SECRETS_DISABLED_AUTHORIZATION is missing/,
    'no authorization',
  );
  refused({ SECRETS_DISABLED_UNTIL: undefined }, /SECRETS_DISABLED_UNTIL is missing/, 'no expiry');
  refused(
    { SECRETS_DISABLED_AUTHORIZATION: '' },
    /SECRETS_DISABLED_AUTHORIZATION is missing or empty/,
    'empty authorization',
  );
});

test('the CHANGE_ME placeholders of .env.example are refused', () => {
  refused(
    { SECRETS_DISABLED_AUTHORIZATION: 'CHANGE_ME' },
    /SECRETS_DISABLED_AUTHORIZATION still contains the CHANGE_ME placeholder/,
  );
  refused(
    { SECRETS_DISABLED_UNTIL: 'CHANGE_ME' },
    /SECRETS_DISABLED_UNTIL still contains the CHANGE_ME placeholder/,
  );
});

test('only the exact literal authorizes: truthy words, other cases, other scopes, padding inside', () => {
  for (const v of [
    'true',
    '1',
    'yes',
    'INTERNAL-ALPHA-ONLY',
    'Internal-Alpha-Only',
    'internal_alpha_only',
    'internal-alpha',
    'production',
    'internal-alpha-only-extra',
    'x internal-alpha-only',
  ]) {
    refused(
      { SECRETS_DISABLED_AUTHORIZATION: v },
      /SECRETS_DISABLED_AUTHORIZATION must be exactly/,
      `authorization ${JSON.stringify(v)}`,
    );
  }
});

test('the expiry is a time box: expired, too far ahead and not-a-date are refused', () => {
  for (const v of [ymd(-1), ymd(-365), ymd(91), ymd(365), '2099-12-31']) {
    refused(
      { SECRETS_DISABLED_UNTIL: v },
      /SECRETS_DISABLED_UNTIL must be a real YYYY-MM-DD date/,
      `expiry ${v}`,
    );
  }
  for (const v of [
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-12-1',
    '26-12-01',
    '01/12/2026',
    '2026-12-01T00:00:00Z',
    'tomorrow',
    '0',
    'NaN',
  ]) {
    refused(
      { SECRETS_DISABLED_UNTIL: v },
      /SECRETS_DISABLED_UNTIL must be a real YYYY-MM-DD date|is missing/,
      `expiry ${JSON.stringify(v)}`,
    );
  }
});

test('no latent authorization: with kms (or anything but disabled) either variable is refused', () => {
  refused(
    { SECRETS_PROVIDER: 'kms' },
    /only allowed with SECRETS_PROVIDER=disabled/,
    'kms with both',
  );
  refused(
    { SECRETS_PROVIDER: 'kms', SECRETS_DISABLED_UNTIL: undefined },
    /only allowed with SECRETS_PROVIDER=disabled/,
    'kms with the authorization only',
  );
  refused(
    { SECRETS_PROVIDER: 'kms', SECRETS_DISABLED_AUTHORIZATION: undefined },
    /only allowed with SECRETS_PROVIDER=disabled/,
    'kms with the expiry only',
  );
});

test('the KMS-required production path is unchanged: kms with neither variable is accepted by the preflight; dev is still refused', () => {
  const ok = run({
    SECRETS_PROVIDER: 'kms',
    SECRETS_DISABLED_AUTHORIZATION: undefined,
    SECRETS_DISABLED_UNTIL: undefined,
  });
  assert.equal(ok.code, 0, ok.out);
  refused(
    {
      SECRETS_PROVIDER: 'dev',
      SECRETS_DISABLED_AUTHORIZATION: undefined,
      SECRETS_DISABLED_UNTIL: undefined,
    },
    /SECRETS_PROVIDER must be disabled/,
    'dev',
  );
  refused(
    {
      SECRETS_PROVIDER: undefined,
      SECRETS_DISABLED_AUTHORIZATION: undefined,
      SECRETS_DISABLED_UNTIL: undefined,
    },
    /SECRETS_PROVIDER is missing/,
    'no provider',
  );
});

test('the same rules apply with --local (a rehearsal cannot use an unauthorized disabled vault either)', () => {
  const f = (over) => {
    const file = path.join(dir, `local.${n++}`);
    writeFileSync(
      file,
      Object.entries(baseEnv(over))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );
    chmodSync(file, 0o600);
    return spawnSync(process.execPath, [preflight, file, '--local'], { encoding: 'utf8' });
  };
  assert.equal(f({}).status, 0);
  const bad = f({ SECRETS_DISABLED_AUTHORIZATION: undefined });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /SECRETS_DISABLED_AUTHORIZATION/);
});

test('refusals print variable names, never the supplied value', () => {
  const secretish = 'SENTINEL-VALUE-must-not-be-echoed-7f3a';
  const a = refused(
    { SECRETS_DISABLED_AUTHORIZATION: secretish },
    /SECRETS_DISABLED_AUTHORIZATION must be exactly/,
  );
  assert.ok(!a.out.includes(secretish), 'the supplied authorization value was echoed');
  const b = refused({ SECRETS_DISABLED_UNTIL: secretish }, /SECRETS_DISABLED_UNTIL must be a real/);
  assert.ok(!b.out.includes(secretish), 'the supplied expiry value was echoed');
});

test('"today" is the UTC day, whatever the machine zone is (forced to UTC+14 and UTC-12, so a UTC runner cannot pass vacuously)', () => {
  // a preload that forces the zone inside the preflight process and refuses to continue if the zone did not take effect
  const preload = path.join(dir, 'force-tz.cjs');
  writeFileSync(
    preload,
    [
      'process.env.TZ = process.env.R1A_TZ;',
      "const h = new Date('2026-12-01T23:59:59.999Z').getHours();",
      'if (h !== Number(process.env.R1A_EXPECT_HOUR)) { console.error("could not force TZ " + process.env.R1A_TZ + " (hour " + h + ")"); process.exit(99); }',
    ].join('\n'),
  );
  const runIn = (tz, hour, over) => {
    const f = path.join(dir, `tz.${n++}`);
    writeFileSync(
      f,
      Object.entries(baseEnv(over))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );
    chmodSync(f, 0o600);
    return spawnSync(process.execPath, ['--require', preload, preflight, f], {
      encoding: 'utf8',
      env: { ...process.env, R1A_TZ: tz, R1A_EXPECT_HOUR: String(hour) },
    });
  };
  for (const [tz, hour] of [
    ['Etc/GMT-14', 13],
    ['Etc/GMT+12', 11],
  ]) {
    const ok0 = runIn(tz, hour, { SECRETS_DISABLED_UNTIL: ymd(0) });
    assert.equal(ok0.status, 0, `${tz}: an expiry of today (UTC) must be accepted: ${ok0.stderr}`);
    const ok90 = runIn(tz, hour, { SECRETS_DISABLED_UNTIL: ymd(90) });
    assert.equal(ok90.status, 0, `${tz}: today+90 (UTC) must be accepted: ${ok90.stderr}`);
    const no1 = runIn(tz, hour, { SECRETS_DISABLED_UNTIL: ymd(-1) });
    assert.equal(no1.status, 2, `${tz}: yesterday (UTC) must be refused: ${no1.stderr}`);
    assert.match(no1.stderr, /SECRETS_DISABLED_UNTIL/);
    const no91 = runIn(tz, hour, { SECRETS_DISABLED_UNTIL: ymd(91) });
    assert.equal(no91.status, 2, `${tz}: today+91 (UTC) must be refused: ${no91.stderr}`);
  }
});

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true });
});
