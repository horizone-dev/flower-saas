// Rewrites KEY=VALUE lines of an env file in place (adds a key that is missing). Used to switch image sets and POSTGRES_DB between phases.
//   node env-set.mjs <env-file> KEY=VALUE [KEY=VALUE ...]
//   node env-set.mjs <env-file> --from-release <release.json>     (API_IMAGE/POS_IMAGE/OWNER_IMAGE/MIGRATE_IMAGE := the recorded immutable image IDs)
import { readFileSync, writeFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file || rest.length === 0)
  throw new Error('usage: env-set.mjs <env-file> KEY=VALUE... | --from-release <file>');
const pairs = {};
if (rest[0] === '--from-release') {
  const rec = JSON.parse(readFileSync(rest[1], 'utf8'));
  for (const k of ['API_IMAGE', 'POS_IMAGE', 'OWNER_IMAGE', 'MIGRATE_IMAGE']) {
    const id = rec.images?.[k]?.id;
    if (!/^sha256:[0-9a-f]{64}$/.test(id ?? ''))
      throw new Error(`${k} has no recorded immutable id in ${rest[1]}`);
    pairs[k] = id;
  }
} else {
  for (const kv of rest) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`bad pair: ${kv}`);
    pairs[kv.slice(0, i)] = kv.slice(i + 1);
  }
}
const lines = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l !== '');
const seen = new Set();
const out = lines.map((l) => {
  const m = /^([A-Z0-9_]+)=/.exec(l);
  if (m && m[1] in pairs) {
    seen.add(m[1]);
    return `${m[1]}=${pairs[m[1]]}`;
  }
  return l;
});
for (const k of Object.keys(pairs)) if (!seen.has(k)) out.push(`${k}=${pairs[k]}`);
writeFileSync(file, `${out.join('\n')}\n`);
console.log(`env updated: ${Object.keys(pairs).join(', ')}`);
