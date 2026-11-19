#!/usr/bin/env node
// PREFLIGHT REPORT — turns the captured output of PREFLIGHT.sql into a redacted, classified report an operator can hand to the independent reviewer.
//
//   node preflight-report.mjs <captured.tsv> --env staging|production [--script PREFLIGHT.sql] [--out report.md]
//
// OFFLINE AND SAFE BY CONSTRUCTION: it only reads the file you name (and, optionally, your copy of PREFLIGHT.sql to print its SHA-256), and writes only to --out (or stdout). It opens NO network
// connection, starts NO process and reads NO credential. It REFUSES (exit 3, printing the REASON but never the matched text) when the capture contains anything that looks like a credential, a
// connection string, a host address or a tenant identifier. It classifies mechanically and APPROVES NOTHING: the verdicts are the script's own, "UNKNOWN" marks a check that produced no row, and the
// independent reviewer decides what a finding means.
//
// Capture the input with:  psql "<your connection>" -X -q -v ON_ERROR_STOP=1 -A -F "$(printf '\t')" --pset footer=off -f PREFLIGHT.sql > captured.tsv
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADER = ['check_id', 'verdict', 'subject', 'observed', 'expected'];
const VERDICTS = ['FAIL', 'UNKNOWN', 'WARN', 'PASS', 'INFO'];
/** roles whose names are part of the design and are kept verbatim; any other operator role name is replaced by a stable placeholder */
const KNOWN_ROLES = new Set([
  'flower_app',
  'flower_platform',
  'flower_migrate',
  'flower_dispatcher',
  'postgres',
]);

/** what must be present for the picture to be COMPLETE; a missing row is UNKNOWN, never silently PASS */
const REQUIRED = [
  { id: 'P01', note: 'server version', test: (rows) => rows.some((r) => r.check_id === 'P01') },
  { id: 'P02', note: 'operator', test: (rows) => rows.some((r) => r.check_id === 'P02') },
  ...['flower_app', 'flower_platform', 'flower_migrate'].map((role) => ({
    id: 'P10',
    note: `role ${role}`,
    test: (rows) => rows.some((r) => r.check_id === 'P10' && r.subject === role),
  })),
  {
    id: 'P11',
    note: 'application role membership',
    test: (rows) => rows.some((r) => r.check_id === 'P11'),
  },
  ...['_prisma_migrations', 'audit_log', 'login_security_event', 'security_event'].map((t) => ({
    id: 'P20',
    note: `owner of ${t}`,
    test: (rows) => rows.some((r) => r.check_id === 'P20' && r.subject === t),
  })),
  {
    id: 'P21',
    note: 'role of this session',
    test: (rows) => rows.some((r) => r.check_id === 'P21'),
  },
  {
    id: 'P22',
    note: 'ownership across the schema',
    test: (rows) => rows.some((r) => r.check_id === 'P22'),
  },
  {
    id: 'P30',
    note: 'security_event view exposure',
    test: (rows) => rows.some((r) => r.check_id === 'P30' && /^security_event\b/.test(r.subject)),
  },
  ...['flower_app', 'flower_platform', 'PUBLIC'].map((who) => ({
    id: 'P31',
    note: `security_event privileges of ${who}`,
    test: (rows) =>
      rows.some((r) => r.check_id === 'P31' && r.subject === `security_event / ${who}`),
  })),
  ...['flower_app', 'flower_platform', 'PUBLIC'].map((who) => ({
    id: 'P40',
    note: `audit_log privileges of ${who}`,
    test: (rows) => rows.some((r) => r.check_id === 'P40' && r.subject === `audit_log / ${who}`),
  })),
  {
    id: 'P41',
    note: 'audit_log guards (parent)',
    test: (rows) => rows.some((r) => r.check_id === 'P41' && r.subject === 'audit_log'),
  },
  ...['audit_log', 'login_security_event'].map((t) => ({
    id: 'P42',
    note: `row level security of ${t}`,
    test: (rows) => rows.some((r) => r.check_id === 'P42' && r.subject === t),
  })),
  {
    id: 'P43',
    note: 'tenant tables without FORCE RLS',
    test: (rows) => rows.some((r) => r.check_id === 'P43'),
  },
  { id: 'P50', note: 'default privileges', test: (rows) => rows.some((r) => r.check_id === 'P50') },
];

/** content that must NEVER travel in a report. Returns the REASONS only — the matched text is deliberately never returned. */
export function refusals(raw) {
  const out = [];
  const rules = [
    ['a connection string', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/]*@?[^\s]*/i],
    [
      'a password / secret / token / key assignment',
      /\b(password|passwd|pwd|secret|token|api[_-]?key|PGPASSWORD|sslkey)\b\s*[:=]/i,
    ],
    ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['an IPv4 address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
    [
      'a UUID (a tenant or row identifier)',
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    ],
    ['a JWT-like token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
    [
      'a long opaque string of 64 or more characters (possible key or hash)',
      /\b[A-Za-z0-9+/_=-]{64,}\b/,
    ],
    [
      'a host name with a domain',
      /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|cloud|internal|local|ae|sa|qa|kw|bh|om)\b/i,
    ],
  ];
  for (const [reason, re] of rules) if (re.test(raw)) out.push(reason);
  return out;
}

const pseudonyms = (names) =>
  new Map([...new Set(names)].sort().map((n, i) => [n, `<ROLE_${i + 1}>`]));

/** Parse + redact + classify. Never throws on content; returns `{ ok:false, refused }` / `{ ok:false, unparseable }` or the report. */
export function analyse(raw, { env = 'unspecified', scriptSha = null } = {}) {
  const text = raw.replace(/\r\n/g, '\n');
  const refused = refusals(text);
  if (refused.length > 0) return { ok: false, refused };
  const lines = text
    .split('\n')
    .filter((l) => l.trim() !== '' && !/^(BEGIN|ROLLBACK|COMMIT)$/.test(l.trim()));
  if (lines.length === 0) return { ok: false, unparseable: ['the capture is empty'] };
  const head = lines[0].split('\t');
  if (head.join('|') !== HEADER.join('|'))
    return {
      ok: false,
      unparseable: [
        'the first line is not the PREFLIGHT.sql header (check_id, verdict, subject, observed, expected) — capture with the documented psql flags',
      ],
    };
  const rows = [];
  const bad = [];
  for (const [i, l] of lines.slice(1).entries()) {
    const c = l.split('\t');
    if (
      c.length !== 5 ||
      !/^P\d{2}$/.test(c[0]) ||
      !['PASS', 'FAIL', 'WARN', 'INFO'].includes(c[1])
    )
      bad.push(`line ${i + 2}`);
    else
      rows.push({ check_id: c[0], verdict: c[1], subject: c[2], observed: c[3], expected: c[4] });
  }
  if (bad.length > 0)
    return {
      ok: false,
      unparseable: [`rows that are not PREFLIGHT.sql rows: ${bad.slice(0, 5).join(', ')}`],
    };

  // REDACT the operator's identity (P02 / P21): keep the attributes the reviewer needs (superuser, bypassrls, membership), replace role names that are not part of the design
  const operatorRoles = [];
  for (const r of rows.filter((x) => x.check_id === 'P02' || x.check_id === 'P21'))
    for (const m of r.observed.matchAll(/\b(?:current_user|session_user)=(\S+)/g))
      if (!KNOWN_ROLES.has(m[1])) operatorRoles.push(m[1]);
  const map = pseudonyms(operatorRoles);
  const redacted = rows.map((r) =>
    r.check_id === 'P02' || r.check_id === 'P21'
      ? {
          ...r,
          observed: r.observed.replace(
            /\b((?:current_user|session_user)=)(\S+)/g,
            (_, k, v) => `${k}${KNOWN_ROLES.has(v) ? v : map.get(v)}`,
          ),
        }
      : r,
  );

  // UNKNOWN = a check the reviewer needs that produced no row (the object may not exist, or the check could not run). Also a P40 relation with no P41 row.
  const unknown = REQUIRED.filter((q) => !q.test(redacted)).map((q) => ({
    check_id: q.id,
    verdict: 'UNKNOWN',
    subject: q.note,
    observed: 'no row was produced',
    expected: 'a row for this check',
  }));
  const p40 = new Set(
    redacted
      .filter((r) => r.check_id === 'P40' && / \/ /.test(r.subject))
      .map((r) => r.subject.split(' / ')[0]),
  );
  for (const rel of p40)
    if (!redacted.some((r) => r.check_id === 'P41' && r.subject === rel))
      unknown.push({
        check_id: 'P41',
        verdict: 'UNKNOWN',
        subject: rel,
        observed: 'no guard row for this audit_log relation',
        expected: 'a P41 row per relation',
      });

  const all = [...redacted, ...unknown];
  const tally = Object.fromEntries(
    VERDICTS.map((v) => [v, all.filter((r) => r.verdict === v).length]),
  );
  const sorted = (v) =>
    all
      .filter((r) => r.verdict === v)
      .sort((a, b) => (a.check_id + a.subject).localeCompare(b.check_id + b.subject));
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const table = (rs) =>
    rs.length === 0
      ? '_none_\n'
      : `| check | subject | observed | expected |\n|---|---|---|---|\n${rs.map((r) => `| ${r.check_id} | ${cell(r.subject)} | ${cell(r.observed)} | ${cell(r.expected)} |`).join('\n')}\n`;
  const markdown =
    `# Security preflight report — ${env}\n\n` +
    `PREFLIGHT.sql sha256: ${scriptSha ?? '(not supplied)'}\n\n` +
    `**This classification is mechanical. It approves nothing and is not a security verdict: the independent reviewer decides what each finding means.**\n` +
    `Operator identity is redacted; no credential, host, tenant identifier or table row is present (the script refuses a capture that contains one).\n\n` +
    `| FAIL | UNKNOWN | WARN | PASS | INFO |\n|---|---|---|---|---|\n| ${tally.FAIL} | ${tally.UNKNOWN} | ${tally.WARN} | ${tally.PASS} | ${tally.INFO} |\n\n` +
    `## FAIL — release-blocker candidates\n${table(sorted('FAIL'))}\n` +
    `## UNKNOWN — a check produced no row (could not be evaluated)\n${table(sorted('UNKNOWN'))}\n` +
    `## WARN — fragile or a defence-in-depth gap\n${table(sorted('WARN'))}\n` +
    `## PASS and INFO\n${table([...sorted('PASS'), ...sorted('INFO')])}`;
  return { ok: true, rows: redacted, unknown, tally, markdown };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const input = args.find(
    (a) => !a.startsWith('--') && a !== opt('--env') && a !== opt('--script') && a !== opt('--out'),
  );
  const env = opt('--env');
  if (!input || !['staging', 'production'].includes(env ?? '')) {
    console.error(
      'usage: node preflight-report.mjs <captured.tsv> --env staging|production [--script PREFLIGHT.sql] [--out report.md]',
    );
    process.exit(2);
  }
  const scriptSha = opt('--script')
    ? createHash('sha256')
        .update(readFileSync(opt('--script'), 'utf8').replace(/\r\n/g, '\n'))
        .digest('hex')
    : null;
  const result = analyse(readFileSync(input, 'utf8'), { env, scriptSha });
  if (!result.ok) {
    if (result.refused) {
      console.error('REFUSED — the capture contains content that must not leave the environment:');
      for (const r of result.refused) console.error(`  - ${r}`);
      console.error(
        'Nothing was written. Review and remove it at the source (do not edit the capture by hand and forward it).',
      );
      process.exit(3);
    }
    console.error(`UNPARSEABLE — ${result.unparseable.join('; ')}`);
    process.exit(2);
  }
  if (opt('--out')) writeFileSync(opt('--out'), result.markdown);
  else process.stdout.write(result.markdown);
  process.exit(0);
}
