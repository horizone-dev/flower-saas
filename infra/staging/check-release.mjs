#!/usr/bin/env node
/**
 * Static release checks (no network, no deployment):  node infra/staging/check-release.mjs <env-file>
 *  1. START ORDER — from `docker compose config`: backup -> migrate -> roles -> seed -> api -> (pos, owner-web) -> caddy, each a hard
 *     `service_completed_successfully` / `service_healthy` dependency; only caddy publishes a port; no `latest` image; healthchecks present;
 *     the API runs in production mode without the dev vault; no secret literal in the compose file.
 *  2. WORKFLOWS — every .github/workflows file looks valid; every `pnpm --filter <pkg> <script>` names a real package script; every
 *     `node <file>` and `docker build -f <file>` points at a file that exists. (Full YAML parsing is used when the `yaml` library resolves;
 *     otherwise a dependency-free line scan runs and GitHub validates the syntax itself.)
 * Exits 1 with the list of problems.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PG_PINNED, readPostgresPin } from './postgres-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const problems = [];
const bad = (m) => problems.push(m);

// ── 1. compose ─────────────────────────────────────────────────────────────
const envFile = process.argv[2];
if (!envFile) {
  bad('usage: node infra/staging/check-release.mjs <env-file>');
} else {
  const composeFile = path.join(root, 'infra/staging/docker-compose.staging.yml');
  const cfg = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--profile',
        'bootstrap',
        '-f',
        composeFile,
        '--env-file',
        envFile,
        'config',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  );
  const svc = cfg.services;
  const dep = (a, b, cond) => {
    const d = svc[a]?.depends_on?.[b];
    if (!d) bad(`${a} must depend on ${b}`);
    else if (d.condition !== cond) bad(`${a} -> ${b} must be ${cond} (is ${d.condition})`);
  };
  dep('backup', 'postgres', 'service_healthy');
  dep('migrate', 'backup', 'service_completed_successfully');
  dep('roles', 'migrate', 'service_completed_successfully');
  dep('seed', 'roles', 'service_completed_successfully');
  dep('api', 'seed', 'service_completed_successfully');
  dep('api', 'redis', 'service_healthy');
  dep('pos', 'api', 'service_healthy');
  dep('owner-web', 'api', 'service_healthy');
  dep('caddy', 'pos', 'service_healthy');
  dep('caddy', 'owner-web', 'service_healthy');
  dep('bootstrap-operator', 'seed', 'service_completed_successfully');
  for (const [name, s] of Object.entries(svc)) {
    if (name !== 'caddy' && s.ports?.length) bad(`${name} publishes ports (only caddy may)`);
    if (typeof s.image === 'string' && /:latest$/.test(s.image))
      bad(`${name} uses a :latest image`);
  }
  // The resolved (not just the env-file) images: postgres and backup must be the SAME digest-pinned 17.<minor> image, equal to the reviewed
  // pin — a literal `postgres:17` in the compose file would pass the env preflight and still float.
  const pg = svc.postgres?.image;
  const pgBackup = svc.backup?.image;
  if (typeof pg !== 'string' || !PG_PINNED.test(pg))
    bad(`postgres image must be postgres:17.<minor>@sha256:<64 hex> (got ${JSON.stringify(pg)})`);
  else if (pg !== readPostgresPin())
    bad('postgres image differs from the reviewed pin in infra/staging/postgres-image.pin');
  if (pg !== pgBackup)
    bad(
      `postgres and backup must use the same image (got ${JSON.stringify(pg)} and ${JSON.stringify(pgBackup)})`,
    );
  for (const name of ['postgres', 'redis', 'api', 'pos', 'owner-web']) {
    if (!svc[name]?.healthcheck) bad(`${name} has no healthcheck`);
  }
  if (svc.api.environment?.NODE_ENV !== 'production') bad('api must run with NODE_ENV=production');
  if (svc.api.environment?.SECRETS_PROVIDER === 'dev')
    bad('api must not use the dev secrets provider');
  const text = readFileSync(composeFile, 'utf8').replace(/\$\{[^}]*\}/g, '');
  if (/(PASSWORD|SECRET)\s*:\s*['"]?[A-Za-z0-9]{12,}['"]?\s*$/m.test(text)) {
    bad('a literal secret appears in the compose file');
  }
}

// ── 2. workflows ───────────────────────────────────────────────────────────
let yaml = null;
try {
  yaml = createRequire(path.join(root, 'package.json'))('yaml');
} catch {
  /* dependency-free mode */
}
const pkgs = {};
for (const dir of ['apps', 'packages', 'tooling']) {
  for (const d of readdirSync(path.join(root, dir))) {
    const pj = path.join(root, dir, d, 'package.json');
    if (existsSync(pj)) {
      const j = JSON.parse(readFileSync(pj, 'utf8'));
      pkgs[j.name] = j.scripts ?? {};
    }
  }
}

/** every command line of every `run:` (single-line or block scalar), without a YAML parser */
function runLines(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && !/^[|>][-+]?$/.test(m[2])) {
      out.push(m[2]);
    } else {
      const indent = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() && l.length - l.trimStart().length <= indent) break;
        out.push(l.trim());
      }
    }
  }
  return out;
}

const wfDir = path.join(root, '.github/workflows');
for (const f of readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
  const text = readFileSync(path.join(wfDir, f), 'utf8');
  if (/\t/.test(text)) bad(`${f} contains a tab character (invalid YAML indentation)`);
  if (!/^jobs:/m.test(text)) bad(`${f} has no jobs:`);
  if (yaml) {
    try {
      yaml.parse(text);
    } catch (e) {
      bad(`${f} does not parse: ${e.message}`);
    }
  }
  for (const line of runLines(text)) {
    const m = /pnpm --filter (@[\w/-]+) (exec )?([\w:.-]+)/.exec(line);
    if (m) {
      const [, pkg, exec, script] = m;
      if (!pkgs[pkg]) bad(`${f}: unknown package ${pkg}`);
      else if (!exec && !(script in pkgs[pkg]) && !['add', 'build'].includes(script)) {
        bad(`${f}: ${pkg} has no script "${script}"`);
      }
    }
    for (const n of line.matchAll(/\bnode ((?:infra|tooling|apps)\/[\w./-]+)/g)) {
      if (!existsSync(path.join(root, n[1]))) bad(`${f}: missing file ${n[1]}`);
    }
    for (const n of line.matchAll(/docker build -f ([\w./-]+)/g)) {
      if (!existsSync(path.join(root, n[1]))) bad(`${f}: missing Dockerfile ${n[1]}`);
    }
  }
}

if (problems.length) {
  console.error(
    `release check FAILED (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  'release check ok: start order, published ports, images, healthchecks, workflow files and referenced scripts',
);
