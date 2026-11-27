#!/usr/bin/env node
/**
 * Image immutability record:  node infra/staging/release-images.mjs <env-file> [--out release-images.json]
 * A tag can be re-pointed; an image ID (content digest) cannot. This resolves the four images named in the env file to their immutable IDs,
 * prints them, and writes a release record to keep with the deployment — the exact artefacts to redeploy for a ROLLBACK. Optionally pin by ID:
 * `API_IMAGE=<id>` works in compose. Refuses an image that is not present locally (build or pull it first). Reads names only; no secret.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [envFile, ...rest] = process.argv.slice(2).filter((a) => a !== '--out');
if (!envFile) {
  console.error('usage: node infra/staging/release-images.mjs <env-file> [--out <file>]');
  process.exit(2);
}
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
void rest;
const record = { createdAt: new Date().toISOString(), images: {} };
let failed = false;
for (const key of ['API_IMAGE', 'POS_IMAGE', 'OWNER_IMAGE', 'MIGRATE_IMAGE']) {
  const ref = env[key];
  if (!ref) {
    console.error(`${key} is not set`);
    failed = true;
    continue;
  }
  try {
    const id = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], {
      encoding: 'utf8',
    }).trim();
    record.images[key] = { ref, id };
    console.log(`${key.padEnd(14)} ${ref.padEnd(34)} ${id}`);
  } catch {
    console.error(`${key}: image ${ref} is not present locally`);
    failed = true;
  }
}
if (out && !failed) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
process.exit(failed ? 1 : 0);
