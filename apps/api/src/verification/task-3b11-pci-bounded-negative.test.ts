import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type * as Backend from '@flower/backend';
import { Redis } from 'ioredis';
import { writeFileSync } from 'node:fs';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { PLATFORM_PERMISSIONS } from '@flower/permissions';
import { enumerateRoutes } from '../common/auth/index.js';
import type { SessionData } from '../common/auth/session.types.js';
import {
  CARD_KEY_RE,
  cardKeys,
  makeCanary,
  scanText,
  type Canary,
  type Hit,
} from './pci-canary.js';
import { createSaleWorld, mintTenantToken, rolePerms, type SaleWorld } from './load-sale-world.js';

/**
 * Task 3b.11 — PCI BOUNDED-NEGATIVE verification (P1–P7; P8 is `task-3b11-pci-detector.test.ts`).
 *
 * What this proves: for SYNTHETIC canary card data (a Luhn-valid non-issuable PAN in several disguises, a CVV, an expiry and
 * track-2 data, each tagged with a unique marker) pushed through the surfaces named below, none of those canaries was
 * found on the listed output and storage surfaces. What it does NOT prove: that no card data can ever exist anywhere in
 * the system, anywhere in a backup / provider / third-party / infrastructure log, in an unexercised route, in a disguise the
 * detector does not know, or in an unbounded free-text field (see the characterization block). It is NOT a PCI DSS
 * assessment or certification, and no PCI compliance claim follows from it.
 *
 * Containment: disposable local PostgreSQL + Redis (Testcontainers) and the in-process application only — no provider,
 * network service or shared log ever receives a canary. A hit is reported by surface and masked excerpt, never raw.
 */

// ── log capture: everything the application passes to its logger, plus console / stdout / stderr ──
const captured = vi.hoisted(() => ({ lines: [] as string[], serialized: [] as string[] }));
vi.mock('@flower/backend', async (importOriginal) => {
  const real = await importOriginal<typeof Backend>();
  const ser = (v: unknown, depth = 0): unknown => {
    if (depth > 6) return '[deep]';
    if (v instanceof Error) {
      return {
        name: v.name,
        message: v.message,
        stack: v.stack,
        ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x, depth + 1)])),
      };
    }
    if (Array.isArray(v)) return v.map((x) => ser(x, depth + 1));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ser(x, depth + 1)]),
      );
    }
    return typeof v === 'bigint' ? v.toString() : v;
  };
  // the REAL logger factory with its production options; only the destination is an in-memory sink (S-1 / P6f)
  const realLogger = real.createRootLogger({
    write: (s: string) => void captured.serialized.push(s),
  } as never);
  realLogger.level = 'trace';
  const rec =
    (level: string) =>
    (...args: unknown[]): void => {
      captured.lines.push(`${level} ${JSON.stringify(args.map((a) => ser(a)))}`);
      (realLogger as unknown as Record<string, (...a: unknown[]) => void>)[level]?.(...args);
    };
  const recorder: Record<string, unknown> = {
    level: 'trace',
    trace: rec('trace'),
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    fatal: rec('fatal'),
    silent: rec('silent'),
  };
  recorder['child'] = () => recorder;
  return { ...real, rootLogger: recorder };
});

type Json = Record<string, unknown>;
const PLATFORM_USER = '00000000-0000-7000-8000-0000003b9a02';
const REDACTED_TABLE_MESSAGE = (t: string): string => `table ${t}`;

interface SurfaceHit {
  surface: string;
  hits: Hit[];
  /** safe row context for triage: identifier-shaped values of action/event columns and the NAMES of the columns holding the hit */
  context?: string[];
}

describe('PCI bounded-negative verification — canaries on every output and storage surface (task 3b.11, P1–P7)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let admin: pg.Pool;
  let redis: Redis;
  const stdio: string[] = [];
  const restore: (() => void)[] = [];
  const report: Record<string, unknown> = {};

  let platformSeq = 0;
  /** a fresh platform-realm session per call, so a route that revokes its own session cannot starve the rest */
  async function mintPlatform(): Promise<string> {
    const s: SessionData = {
      sessionId: `00000000-0000-7000-8000-${String(++platformSeq).padStart(12, '0')}`,
      realm: 'platform',
      familyId: 'f',
      tenantId: null,
      userId: null,
      platformUserId: PLATFORM_USER,
      accountType: 'PLATFORM',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'STEP_UP',
      stepUpUntil: Date.now() + 5 * 3_600_000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 6 * 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: {
        effectivePermissions: [...PLATFORM_PERMISSIONS],
        companyScope: 'ALL',
        branchScope: 'ALL',
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    };
    await w.h.store.set(s);
    return w.h.jwt.sign({ sub: PLATFORM_USER, sid: s.sessionId, aud: 'platform' });
  }

  /** where, inside a captured log line, a canary appears: level + argument paths only, never the value */
  function locate(line: string, canary: Canary): string[] {
    const sp = line.indexOf(' ');
    const level = line.slice(0, sp);
    const walk = (v: unknown, path: string, out: string[]): void => {
      if (typeof v === 'string') {
        if (scanText(v, canary).length > 0) out.push(`${level} ${path}`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v as Record<string, unknown>))
          walk(x, `${path}.${k}`, out);
      }
    };
    const out: string[] = [];
    walk(JSON.parse(line.slice(sp + 1)) as unknown, '$', out);
    return out;
  }

  const kinds = (hs: Hit[]): string => [...new Set(hs.map((h) => h.kind))].sort().join(',');

  async function sweepDb(canary: Canary): Promise<SurfaceHit[]> {
    const tables = (
      await admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);
    const out: SurfaceHit[] = [];
    for (const t of tables) {
      const rows = (
        await admin.query<{ r: string }>(`SELECT row_to_json(x)::text AS r FROM "${t}" x`)
      ).rows;
      const hits: Hit[] = [];
      const context = new Set<string>();
      for (const { r } of rows) {
        const rowHits = scanText(r, canary);
        hits.push(...rowHits);
        if (rowHits.length > 0) {
          const obj = JSON.parse(r) as Record<string, unknown>;
          for (const [col, v] of Object.entries(obj)) {
            const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
            if (scanText(s, canary).length > 0) context.add(`hit-in-column:${col}`);
            if (
              ['action', 'eventType', 'event', 'kind', 'type'].includes(col) &&
              typeof v === 'string' &&
              /^[\w.:-]{1,60}$/.test(v)
            )
              context.add(`${col}=${v}`);
          }
        }
        // the JSON property names of the row (columns and any jsonb keys inside)
        hits.push(
          ...cardKeys(JSON.parse(r) as unknown).map((k) => ({
            kind: 'card-key' as const,
            masked: k,
          })),
        );
      }
      if (hits.length > 0)
        out.push({ surface: REDACTED_TABLE_MESSAGE(t), hits, context: [...context].sort() });
    }
    return out;
  }

  async function dumpRedis(): Promise<{ key: string; text: string }[]> {
    const out: { key: string; text: string }[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        const type = await redis.type(key);
        let text = '';
        if (type === 'string') text = (await redis.get(key)) ?? '';
        else if (type === 'hash') text = JSON.stringify(await redis.hgetall(key));
        else if (type === 'list') text = JSON.stringify(await redis.lrange(key, 0, -1));
        else if (type === 'set') text = JSON.stringify(await redis.smembers(key));
        else if (type === 'zset')
          text = JSON.stringify(await redis.zrange(key, '0', '-1', 'WITHSCORES'));
        else if (type === 'stream') text = JSON.stringify(await redis.xrange(key, '-', '+'));
        out.push({ key: `${key.split(':').slice(0, 2).join(':')}…`, text: `${key} ${text}` });
      }
    } while (cursor !== '0');
    return out;
  }

  async function sweepRedis(canary: Canary): Promise<SurfaceHit[]> {
    const dump = await dumpRedis();
    const out: SurfaceHit[] = [];
    for (const { key, text } of dump) {
      const hits = scanText(text, canary);
      if (hits.length > 0) out.push({ surface: `redis ${key}`, hits });
    }
    return out;
  }

  const rowCount = async (t: string): Promise<number> =>
    Number((await admin.query<{ n: string }>(`SELECT count(*)::text n FROM "${t}"`)).rows[0]!.n);

  beforeAll(async () => {
    // capture console + stdout/stderr for the whole run (Nest's own logger and any stray console output)
    for (const stream of ['stdout', 'stderr'] as const) {
      const orig = process[stream].write.bind(process[stream]);
      process[stream].write = ((chunk: unknown, ...rest: unknown[]): boolean => {
        stdio.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
        );
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;
      restore.push(() => {
        process[stream].write = orig as typeof process.stdout.write;
      });
    }
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    admin = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    redis = new Redis(stack.redis.url);
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 3);
    // ordinary business activity, so audit / outbox / idempotency / journal surfaces hold real rows
    for (const b of w.a.branches) {
      const sale = await w.sale({ co: w.a, branch: b, token: w.ownerToken });
      if (!sale.ok) throw new Error(`fixture sale failed ${JSON.stringify(sale)}`);
    }
    const credit = await w.sale({
      co: w.a,
      branch: w.a.branches[0]!,
      token: w.ownerToken,
      customerId: w.customers[0]!,
      credit: true,
    });
    if (!credit.ok) throw new Error('fixture credit sale failed');
    const rc = await w.receipt({
      co: w.a,
      branch: w.a.branches[0]!,
      token: w.ownerToken,
      customerId: w.customers[0]!,
      amountMinor: 500n,
    });
    if (rc.status !== 201) throw new Error('fixture receipt failed');
  }, 600_000);

  afterAll(async () => {
    for (const r of restore) r();
    if (process.env['PCI_REPORT'])
      writeFileSync(process.env['PCI_REPORT'], JSON.stringify(report, null, 1));
    await redis?.quit();
    await admin?.end();
    await w?.pool.end();
    await w?.h.close();
    await stack?.stop();
  }, 120_000);

  // ───────────────────────────── P1 schema ─────────────────────────────
  it('P1 schema: no column anywhere is shaped like card data, and no webhook / provider table has a raw-payload column', async () => {
    const cols = (
      await admin.query<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
      )
    ).rows;
    expect(cols.length).toBeGreaterThan(500); // a meaningful inventory, not an empty schema
    const cardShaped = cols.filter((c) => CARD_KEY_RE.test(c.column_name));
    expect(cardShaped.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([]);
    const rawPayload = cols.filter(
      (c) =>
        /webhook|inbox|provider|payment_attempt|refund_attempt/i.test(c.table_name) &&
        /(^|_)(raw|payload|body)($|_)|rawBody|rawPayload/i.test(c.column_name),
    );
    expect(rawPayload.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([]);
    const json = cols.filter((c) => c.data_type === 'jsonb' || c.data_type === 'json');
    report['p1'] = {
      columns: cols.length,
      tables: new Set(cols.map((c) => c.table_name)).size,
      jsonColumns: json.map((c) => `${c.table_name}.${c.column_name}`),
    };
    // every free-form JSON column is named so it can be reviewed; the list is reported, not silently ignored
    expect(json.length).toBeGreaterThan(0);
  });

  // ───────────────────────────── P5 / P6 / P7 generic reach ─────────────────────────────
  describe('stage A — canaries on EVERY body-accepting route (body) and EVERY GET route (query string)', () => {
    const cv = makeCanary(); // card data carried as property VALUES (and in a header)
    const pathParamCanary = makeCanary(); // P6f / P6h: a card number in every path parameter and query value
    const ck = makeCanary(); // a different card number carried as a property NAME, so key echo and value echo are told apart
    const exercised = new Set<string>();
    const statuses = new Map<number, number>();
    const fiveXX: string[] = [];
    const echoes: { route: string; value: string; key: string }[] = [];
    const businessTables = [
      'invoice',
      'payment',
      'payment_attempt',
      'order',
      'customer',
      'refund',
      'credit_note',
    ];
    let beforeCounts: Record<string, number> = {};
    let bodyPhaseLogs: string[] = [];
    let queryPhaseLogs: string[] = [];

    /** hits of one canary, without the generic Luhn scan (so a hit names a specific planted value) */
    const specific = (text: string, c: Canary): string =>
      kinds(scanText(text, c).filter((h) => h.kind !== 'generic-luhn'));

    it('P7 route coverage: every body-accepting and every GET route in the application is exercised, none skipped or excluded', async () => {
      beforeCounts = Object.fromEntries(
        await Promise.all(businessTables.map(async (t) => [t, await rowCount(t)] as const)),
      );
      const routes = enumerateRoutes(w.h.app);
      const bodyRoutes = routes.filter((r) => ['POST', 'PUT', 'PATCH'].includes(r.httpMethod));
      const getRoutes = routes.filter((r) => r.httpMethod === 'GET');
      expect(bodyRoutes.length).toBeGreaterThanOrEqual(80);
      const ids: Record<string, string> = {
        companyId: w.a.companyId,
        branchId: w.a.branches[0]!,
        customerId: w.customers[0]!,
        productId: w.productId,
        variantId: w.variantId,
        tenantId: w.a.tenantId,
      };
      const fill = (p: string): string =>
        p
          .replace(/^\/v1/, '')
          .replace(
            /:([A-Za-z]+)/g,
            (_m, name: string) => ids[name] ?? '00000000-0000-7000-8000-00000000c0de',
          );
      const body: Json = {
        cardNumber: cv.pan,
        pan: cv.tagged.pan,
        cvv: cv.tagged.cvv,
        expiry: cv.tagged.expiry,
        track2: cv.tagged.track2,
        note: cv.tagged.pan,
        nested: { cardholder: cv.tagged.track2, list: [cv.panForms['spaced']] },
        [ck.pan]: ck.tagged.expiry,
      };
      const owner = rolePerms('owner');
      const run = async (r: (typeof routes)[number], phase: 'body' | 'query'): Promise<void> => {
        const isBody = phase === 'body';
        const token = r.isPublic
          ? null
          : r.realm === 'platform'
            ? await mintPlatform()
            : await mintTenantToken(w.h, w.a.tenantId, owner, { stepUp: true });
        const base = fill(r.path);
        const url = isBody
          ? base
          : `${base}?q=${encodeURIComponent(cv.tagged.pan)}&cardNumber=${cv.pan}&${ck.pan}=1`;
        const hdrs = {
          'idempotency-key': `pci-${exercised.size}`,
          'if-match': '"1"',
          'x-card-header': cv.tagged.pan,
        };
        const outside = /^\/v1\/(healthz|readyz)$/.test(r.path); // the app excludes these two from the /v1 prefix
        const res = outside
          ? await (async () => {
              const raw = await w.h.app.inject({ method: 'GET', url });
              let b: unknown = raw.payload;
              try {
                b = raw.json();
              } catch {
                /* plain text */
              }
              return { status: raw.statusCode, ms: 0, body: b };
            })()
          : await w.req(
              r.httpMethod as 'GET' | 'POST' | 'PUT',
              url,
              token,
              isBody ? body : undefined,
              hdrs,
            );
        exercised.add(`${phase} ${r.httpMethod} ${r.path}`);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (res.status >= 500) fiveXX.push(`${r.httpMethod} ${r.path} → ${res.status}`);
        const text = JSON.stringify(res.body ?? '');
        const value = specific(text, cv);
        const key = specific(text, ck);
        if (value || key) echoes.push({ route: `${phase} ${r.httpMethod} ${r.path}`, value, key });
      };
      const start = captured.lines.length;
      for (const r of bodyRoutes) await run(r, 'body');
      bodyPhaseLogs = captured.lines.slice(start);
      const mid = captured.lines.length;
      for (const r of getRoutes) await run(r, 'query');
      queryPhaseLogs = captured.lines.slice(mid);
      report['p7'] = {
        bodyRoutes: bodyRoutes.length,
        getRoutes: getRoutes.length,
        exercised: exercised.size,
        statuses: Object.fromEntries([...statuses.entries()].sort((a, b) => a[0] - b[0])),
        reachedValidation400or422: (statuses.get(400) ?? 0) + (statuses.get(422) ?? 0),
        fiveXX,
      };
      expect(exercised.size).toBe(bodyRoutes.length + getRoutes.length);
      // most requests must get past the guards to validation, otherwise the exercise proves little
      expect((statuses.get(400) ?? 0) + (statuses.get(422) ?? 0)).toBeGreaterThan(80);
    }, 600_000);

    it('P5a responses never echo a card value, a tagged CVV / expiry / track value, or a card-bearing header', () => {
      const valueEchoes = echoes.filter((e) => e.value).map((e) => `${e.route}: ${e.value}`);
      report['p5a'] = { valueEchoes };
      expect(valueEchoes).toEqual([]);
    });

    it('P5b responses never echo a card number supplied as a property NAME (validation errors such as "unrecognized key")', () => {
      const keyEchoes = echoes.filter((e) => e.key).map((e) => `${e.route}: ${e.key}`);
      report['p5b'] = { count: keyEchoes.length, routes: keyEchoes };
      expect(keyEchoes).toEqual([]);
    });

    it('P5c no canary-carrying request created or changed any business record', async () => {
      const after = Object.fromEntries(
        await Promise.all(businessTables.map(async (t) => [t, await rowCount(t)] as const)),
      );
      expect(after).toEqual(beforeCounts);
    });

    it('P6a the logger, console and stdout/stderr never receive a card value or card-shaped property name from a REQUEST BODY', () => {
      const hitLines = bodyPhaseLogs.filter(
        (l) => scanText(l, cv).length + scanText(l, ck).length > 0,
      );
      report['p6a'] = {
        bodyPhaseLogLines: bodyPhaseLogs.length,
        locations: [...new Set(hitLines.flatMap((l) => [...locate(l, cv), ...locate(l, ck)]))],
        stdioHits: kinds(stdio.flatMap((l) => scanText(l, cv).concat(scanText(l, ck)))),
      };
      expect(bodyPhaseLogs.length).toBeGreaterThan(0); // the capture is live
      expect(hitLines).toEqual([]);
      expect(kinds(stdio.flatMap((l) => scanText(l, cv).concat(scanText(l, ck))))).toBe('');
    });

    it('P6b the logger never receives a card value carried in a URL QUERY STRING', () => {
      const hitLines = queryPhaseLogs.filter(
        (l) => scanText(l, cv).length + scanText(l, ck).length > 0,
      );
      const locations = [...new Set(hitLines.flatMap((l) => [...locate(l, cv), ...locate(l, ck)]))];
      report['p6b'] = {
        queryPhaseLogLines: queryPhaseLogs.length,
        hitLines: hitLines.length,
        locations,
      };
      expect(queryPhaseLogs.length).toBeGreaterThan(0);
      expect(locations).toEqual([]);
    });

    // the same requests feed P6c (the logged path and route FIELDS) and P6d (the whole log line, message included)
    let pathPhaseLines: string[] = [];
    const pathCanary = makeCanary();
    const pathEchoes: string[] = [];
    const parseLine = (l: string): { fields: Json; message: unknown } => {
      const args = JSON.parse(l.slice(l.indexOf(' ') + 1)) as unknown[];
      return { fields: (args[0] ?? {}) as Json, message: args[1] };
    };
    const lookAlike = new RegExp('[\\uff10-\\uff19\\u0660-\\u0669\\u200b]');

    it('P6c drives card numbers through URL path segments (unmatched routes, malformed ids) and the failures are still logged', async () => {
      const c6 = pathCanary;
      const fullWidth = [...c6.pan].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
      const segs: Record<string, string> = {
        plain: c6.pan,
        dashed: c6.panForms['dashed']!,
        spacedEncoded: encodeURIComponent(c6.panForms['spaced']!),
        percentDigits: [...c6.pan].map((d) => `%3${d}`).join(''),
        fullWidth: encodeURIComponent(fullWidth),
        zeroWidthSplit: encodeURIComponent([...c6.pan].join('​')),
        tagged: encodeURIComponent(c6.tagged.pan),
      };
      const urls = Object.values(segs).flatMap((s) => [
        `/${s}`, // an unmatched route
        `/catalog/products/${s}/variants`, // a matched pattern with a malformed id
        `/companies/${s}/customers`, // a card number where a company id belongs
      ]);
      const start = captured.lines.length;
      for (const u of urls) {
        const res = await w.req('GET', u, w.ownerToken);
        const specific = scanText(JSON.stringify(res.body ?? ''), c6).filter(
          (h) => h.kind !== 'marker',
        );
        if (specific.length > 0) pathEchoes.push(`${res.status}: ${kinds(specific)}`);
      }
      pathPhaseLines = captured.lines.slice(start);
      report['p6cd'] = { requests: urls.length, logLines: pathPhaseLines.length };
      expect(pathPhaseLines.length).toBe(urls.length); // one failure line per request: the failures stay visible
      expect(
        pathPhaseLines.every((l) => {
          const { fields } = parseLine(l);
          return typeof fields['path'] === 'string' && typeof fields['status'] === 'number';
        }),
      ).toBe(true); // … with their path and status
    }, 120_000);

    it('P6c the logged `path` and `route` fields carry no card number (nor a query string) for any path-segment form', () => {
      const c6 = pathCanary;
      const bad: string[] = [];
      for (const l of pathPhaseLines) {
        const { fields } = parseLine(l);
        for (const k of ['path', 'route'] as const) {
          const v = fields[k];
          if (typeof v !== 'string') continue;
          if (
            scanText(v, c6).some((h) => h.kind !== 'marker') ||
            lookAlike.test(v) ||
            v.includes('?')
          ) {
            bad.push(`${k}: ${v.replace(/\d{4,}/g, '####')}`);
          }
        }
      }
      report['p6c'] = {
        checkedLines: pathPhaseLines.length,
        badFieldLines: bad.length,
        bad: bad.slice(0, 4),
      };
      expect(bad).toEqual([]);
    });

    it('P6d the logged exception MESSAGE carries no card number (an unmatched route’s "Cannot GET <url>" message)', () => {
      const c6 = pathCanary;
      const leaking = pathPhaseLines.filter((l) => {
        const { message } = parseLine(l);
        return (
          typeof message === 'string' && scanText(message, c6).some((h) => h.kind !== 'marker')
        );
      });
      report['p6d'] = {
        linesWithCardInMessage: leaking.length,
        samples: leaking.slice(0, 3).map((l) =>
          String(parseLine(l).message)
            .replace(/\d{4,}/g, '####')
            .slice(0, 120),
        ),
        responseBodiesEchoingThePath: pathEchoes.length,
        responseEchoSample: pathEchoes.slice(0, 3),
      };
      expect(leaking.map((l) => String(parseLine(l).message).replace(/\d{4,}/g, '####'))).toEqual(
        [],
      );
    });

    it('P6e the HTTP response bodies of those requests (404 for unmatched routes, 4xx for malformed ids) never echo a card number from the path', () => {
      report['p6e'] = { echoingResponses: pathEchoes.length, sample: pathEchoes.slice(0, 3) };
      expect(pathEchoes).toEqual([]);
    });

    it('P2/P3/P4 every table (audit_log, security events, outbox, idempotency, journals …) and every Redis key: zero stage-A canaries', async () => {
      const dbHits = [...(await sweepDb(cv)), ...(await sweepDb(ck))];
      const redisHits = [...(await sweepRedis(cv)), ...(await sweepRedis(ck))];
      report['p2'] = {
        tables: (
          await admin.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)
        ).rows[0],
        auditRows: await rowCount('audit_log'),
        outboxRows: await rowCount('outbox'),
        redisKeys: (await dumpRedis()).length,
        dbHits: dbHits.map((h) => `${h.surface}: ${kinds(h.hits)}`),
        dbHitContext: dbHits.map((h) => `${h.surface}: ${(h.context ?? []).join(', ')}`),
        redisHits: redisHits.map((h) => `${h.surface}: ${kinds(h.hits)}`),
      };
      // the sweep is only meaningful if the surfaces under it are populated
      expect(await rowCount('audit_log')).toBeGreaterThan(0);
      expect(await rowCount('outbox')).toBeGreaterThan(0);
      expect((await dumpRedis()).length).toBeGreaterThan(0);
      expect(dbHits.map((h) => `${h.surface}: ${kinds(h.hits)}`)).toEqual([]);
      expect(redisHits.map((h) => `${h.surface}: ${kinds(h.hits)}`)).toEqual([]);
    }, 300_000);

    it('P6f the REAL serialized log output (production logger options) carries no card value when a card number is sent through every path parameter and query value of every route', async () => {
      const c = pathParamCanary;
      const owner = rolePerms('owner');
      const routes = enumerateRoutes(w.h.app).filter(
        (r) => !/^\/v1\/(healthz|readyz)$/.test(r.path),
      );
      // a REAL owner user: the session must name an existing user, or routes that load it (MFA enrolment) fail a foreign key and
      // answer 500 for a reason unrelated to the canary
      const ownerRow = await w.pool.query(
        `SELECT id FROM "user" WHERE "tenantId" = $1 AND "accountType" = 'OWNER' ORDER BY "createdAt" LIMIT 1`,
        [w.a.tenantId],
      );
      const realOwnerId = ownerRow.rows[0]?.id as string;
      expect(realOwnerId).toBeTruthy();
      const start = captured.serialized.length;
      let reached500 = 0;
      const answered500: string[] = [];
      for (const r of routes) {
        const token = r.isPublic
          ? null
          : r.realm === 'platform'
            ? await mintPlatform()
            : await mintTenantToken(w.h, w.a.tenantId, owner, {
                stepUp: true,
                userId: realOwnerId,
              });
        const url = r.path.replace(/^\/v1/, '').replace(/:[A-Za-z]+/g, c.pan);
        const query =
          r.httpMethod === 'GET'
            ? `?q=${c.pan}&cursor=${c.pan}&status=${c.pan}&slug=${c.pan}&sku=${c.pan}&uomCode=${c.pan}&date=${c.pan}&customerId=${c.pan}`
            : '';
        const res = await w.req(
          r.httpMethod as 'GET' | 'POST' | 'PUT',
          url + query,
          token,
          r.httpMethod === 'GET' ? undefined : {},
          {
            'if-match': '"1"',
            'idempotency-key': `p6f-${reached500}-${Math.random().toString(36).slice(2)}`,
          },
        );
        if (res.status >= 500) {
          reached500++;
          answered500.push(`${r.httpMethod} ${r.path}`);
        }
      }
      const out = captured.serialized.slice(start);
      const records = out.map((l) => JSON.parse(l) as Json);
      const hits = out.filter((l) => scanText(l, c).some((h) => h.kind !== 'marker'));
      const withSafeErr = records.filter((r) => typeof r['err'] === 'object' && r['err'] !== null);
      const classified = withSafeErr.filter((r) => (r['err'] as Json)['code'] === 'P2007');
      report['p6f'] = {
        routes: routes.length,
        requestsAnswered500: reached500,
        serializedLines: out.length,
        linesWithCardValue: hits.length,
        errorRecords: withSafeErr.length,
        p2007Records: classified.length,
        sampleErrKeys: withSafeErr[0] ? Object.keys(withSafeErr[0]['err'] as Json).sort() : [],
        sampleMasked: withSafeErr[0]
          ? JSON.stringify(withSafeErr[0]['err'])
              .replace(/\d{4,}/g, '####')
              .slice(0, 300)
          : '',
      };
      // Closure change (Task 3b.11 V-1 / V-2): a malformed id used to reach PostgreSQL and answer 500, and this sweep used those 500s
      // to force sanitised `err` records into the log. A malformed id is now a 404, so the sweep must (a) still reach the database
      // layer (its 404 translation is logged and scanned below) and (b) answer no 5xx at all. The
      // sanitised-`err` serialisation (code P2007, sqlstate 22P02, frames, no value) is proven by `packages/safe-logging`
      // (`pino.test.ts`, `safe-error.test.ts`); if an `err` record does appear here its diagnostics must still be intact.
      // the malformed canary ids really did reach the database cast and were translated (the interceptor's warning is the proof)
      const translated = records.filter(
        (r) => r['msg'] === 'resource not found' && r['status'] === 404,
      );
      expect(translated.length).toBeGreaterThan(10);
      // NO 5xx at all: a card-number canary in any path parameter or query value must never be a server fault
      expect(answered500).toEqual([]);
      for (const r of classified) {
        const e = r['err'] as Json;
        expect(typeof e['operation']).toBe('string');
        expect(e['sqlstate']).toBe('22P02');
        expect(Array.isArray(e['frames'])).toBe(true);
        expect(typeof r['path']).toBe('string');
      }
      // … and no card value anywhere in what a sink would receive
      expect(hits).toEqual([]);
    }, 600_000);

    it("P6g Prisma's own console / stdout / stderr channels no longer print the rejected value (the confirmed direct-console leak), yet sanitized Prisma diagnostics still appear", async () => {
      const c = makeCanary();
      const seen: string[] = [];
      const undo: (() => void)[] = [];
      const wrap = (obj: Record<string, unknown>, key: string, label: string): void => {
        const orig = obj[key] as (...a: unknown[]) => unknown;
        obj[key] = (...a: unknown[]): unknown => {
          seen.push(
            `${label}: ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`,
          );
          return orig.apply(obj, a);
        };
        undo.push(() => {
          obj[key] = orig;
        });
      };
      for (const k of ['log', 'info', 'warn', 'error', 'debug'])
        wrap(console as unknown as Record<string, unknown>, k, `console.${k}`);
      wrap(process.stdout as unknown as Record<string, unknown>, 'write', 'stdout');
      wrap(process.stderr as unknown as Record<string, unknown>, 'write', 'stderr');
      const tok = await mintTenantToken(w.h, w.a.tenantId, rolePerms('owner'), { stepUp: true });
      const statuses: number[] = [];
      try {
        for (const u of [
          `/access/users/${c.pan}`,
          `/org/branches/${c.pan}/settings`,
          `/localization/companies/${c.pan}`,
          `/customers?cursor=${c.pan}`,
        ]) {
          statuses.push((await w.req('GET', u, tok)).status);
        }
      } finally {
        for (const u of undo) u();
      }
      const prismaLines = seen.filter(
        (s) => s.startsWith('stderr: {') && s.includes('"name":"prisma"'),
      );
      const unsafe = seen.filter((s) => scanText(s, c).some((h) => h.kind !== 'marker'));
      report['p6g'] = {
        statuses,
        capturedChunks: seen.length,
        chunksWithCardValue: unsafe.length,
        channels: [...new Set(seen.map((s) => s.split(':')[0]))],
        sanitizedPrismaLines: prismaLines.length,
        sample: prismaLines[0] ? prismaLines[0].replace(/\d{4,}/g, '####').slice(0, 300) : '',
      };
      expect(statuses.every((s) => s >= 400)).toBe(true);
      expect(unsafe).toEqual([]); // no channel printed the value
      expect(seen.some((s) => s.includes('prisma:error'))).toBe(false); // Prisma's default console format is gone
      expect(seen.some((s) => s.startsWith('console.log: prisma'))).toBe(false);
      expect(prismaLines.length).toBeGreaterThanOrEqual(3); // diagnostics are still emitted — sanitized, on stderr
      for (const l of prismaLines) {
        const rec = JSON.parse(l.slice('stderr: '.length)) as { level: number; prisma: Json };
        expect(rec.level).toBe(50);
        expect(typeof rec.prisma['operation']).toBe('string');
      }
    }, 120_000);

    it('P6h a card number sent as a PATH PARAMETER to every route is not persisted by any route (audit_log, security events, outbox, idempotency, every table, Redis)', async () => {
      const dbHits = await sweepDb(pathParamCanary);
      const redisHits = await sweepRedis(pathParamCanary);
      report['p6h'] = {
        dbHits: dbHits.map((h) => `${h.surface}: ${kinds(h.hits)}`),
        dbHitContext: dbHits.map((h) => `${h.surface}: ${(h.context ?? []).join(', ')}`),
        redisHits: redisHits.map((h) => `${h.surface}: ${kinds(h.hits)}`),
      };
      expect(
        dbHits.map((h) => `${h.surface}: ${kinds(h.hits)} [${(h.context ?? []).join(', ')}]`),
      ).toEqual([]);
      expect(redisHits.map((h) => `${h.surface}: ${kinds(h.hits)}`)).toEqual([]);
    }, 300_000);
  });

  // ───────────────────────────── P8 positive controls ─────────────────────────────
  it('P8 positive control: a planted canary IS found in a table, in Redis and in a captured log line, then removed', async () => {
    const control = makeCanary();
    await admin.query(`CREATE TABLE pci_probe_control (id serial PRIMARY KEY, note text)`);
    await admin.query(`INSERT INTO pci_probe_control (note) VALUES ($1)`, [
      control.panForms['base64Plain'],
    ]);
    await redis.set('pci:control', JSON.stringify({ x: control.tagged.cvv }));
    captured.lines.push(`warn ${JSON.stringify(['planted', control.pan])}`);
    try {
      const db = await sweepDb(control);
      expect(db.map((h) => h.surface)).toContain('table pci_probe_control');
      expect(kinds(db.find((h) => h.surface === 'table pci_probe_control')!.hits)).toContain(
        'form:base64Plain',
      );
      expect((await sweepRedis(control)).some((h) => h.surface.startsWith('redis pci:'))).toBe(
        true,
      );
      expect(captured.lines.flatMap((l) => scanText(l, control)).length).toBeGreaterThan(0);
    } finally {
      captured.lines.pop();
      await redis.del('pci:control');
      await admin.query(`DROP TABLE pci_probe_control`);
    }
    expect((await sweepDb(control)).map((h) => h.surface)).not.toContain('table pci_probe_control');
  });

  // ───────────────────────────── characterization of free text ─────────────────────────────
  describe('stage B — characterization: where an arbitrary free-text field carries a card-shaped value', () => {
    const cb = makeCanary();

    it('records which free-text fields accept and persist a card-shaped value, and where it spreads (audit, outbox, idempotency)', async () => {
      const key = (): string => `pciB-${Math.random().toString(36).slice(2)}`;
      const post = (
        url: string,
        b: Json,
        headers: Record<string, string> = {},
      ): ReturnType<SaleWorld['req']> =>
        w.req('POST', url, w.ownerToken, b, { 'idempotency-key': key(), ...headers });
      const co = w.a.companyId;
      const br = w.a.branches[0]!;
      const results: Record<string, number> = {};
      const logStart = captured.lines.length;
      results['customer.displayName'] = (
        await post(`/companies/${co}/customers`, { displayName: cb.tagged.pan })
      ).status;
      results['customer.phone'] = (
        await post(`/companies/${co}/customers`, { displayName: 'PCI B phone', phone: cb.pan })
      ).status;
      const cat = await post('/catalog/categories', {
        slug: `pcib-${cb.marker.toLowerCase()}`,
        nameEn: cb.tagged.expiry,
      });
      results['category.nameEn'] = cat.status;
      const catId = (cat.body as { id?: string }).id;
      if (catId) {
        results['product.description'] = (
          await post('/catalog/products', {
            categoryId: catId,
            nameEn: 'PCI B product',
            slug: `pcib-prod-${cb.marker.toLowerCase()}`,
            fulfilmentStrategy: 'STOCKED',
            description: cb.tagged.pan,
          })
        ).status;
      }
      const o = await post(`/companies/${co}/branches/${br}/orders`, {
        lines: [
          {
            productId: w.productId,
            variantId: w.variantId,
            selectedUomCode: 'piece',
            quantity: '1',
          },
        ],
      });
      const order = (o.body as { order?: { id: string; version: number } }).order;
      if (order) {
        results['order.cancel.reason'] = (
          await post(
            `/companies/${co}/branches/${br}/orders/${order.id}/cancel`,
            { reason: cb.tagged.pan },
            { 'if-match': String(order.version) },
          )
        ).status;
      }
      const dbHits = await sweepDb(cb);
      const redisHits = await sweepRedis(cb);
      const specificLogHits = captured.lines
        .slice(logStart)
        .flatMap((l) => scanText(l, cb))
        .filter((h) => h.kind !== 'generic-luhn');
      const tables = dbHits.map((h) => h.surface.replace('table ', ''));
      report['stageB'] = {
        note: 'characterization of arbitrary free-text acceptance; NOT an assertion that these are acceptable',
        requestStatuses: results,
        persistedInTables: dbHits.map((h) => `${h.surface}: ${kinds(h.hits)}`),
        redis: redisHits.map((h) => `${h.surface}: ${kinds(h.hits)}`),
        logs: kinds(specificLogHits),
        spreadsToAuditOrOutbox: tables.filter((t) =>
          ['audit_log', 'outbox', 'login_security_event'].includes(t),
        ),
      };
      // the characterization must have exercised several fields
      expect(Object.keys(results).length).toBeGreaterThanOrEqual(4);
    }, 300_000);
  });
});
