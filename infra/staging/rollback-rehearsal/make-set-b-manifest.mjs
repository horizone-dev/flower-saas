// Builds the approved-migrations manifest of the throw-away "set B" migrate image: the manifest of set A plus exactly ONE extra entry, the
// local rollback-rehearsal TEST migration. Never touches the repository's manifest.
//   node make-set-b-manifest.mjs <approved-A.json> <test-migration.sql> <test-migration-name> <out.json>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [aPath, sqlPath, name, outPath] = process.argv.slice(2);
if (!aPath || !sqlPath || !name || !outPath)
  throw new Error('usage: make-set-b-manifest.mjs <A.json> <sql> <name> <out>');
if (/draft/i.test(name)) throw new Error('the runner refuses any folder name containing "draft"');
const a = JSON.parse(readFileSync(aPath, 'utf8'));
if (!a.migrations || typeof a.migrations !== 'object')
  throw new Error('set A manifest is malformed');
if (name in a.migrations) throw new Error(`${name} is already approved in set A`);
const names = Object.keys(a.migrations).sort();
if (!(name > names[names.length - 1]))
  throw new Error(
    'the test migration must sort AFTER every approved migration (Prisma applies by name)',
  );
const sha = createHash('sha256')
  .update(readFileSync(sqlPath, 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex');
const migrations = { ...a.migrations, [name]: sha };
const sorted = Object.fromEntries(
  Object.keys(migrations)
    .sort()
    .map((k) => [k, migrations[k]]),
);
writeFileSync(
  outPath,
  `${JSON.stringify({ source: 'LOCAL ROLLBACK REHEARSAL (set A + 1 test migration) — NOT APPROVED', count: Object.keys(sorted).length, migrations: sorted }, null, 2)}\n`,
);
console.log(
  `set B manifest: ${a.count} approved + 1 test migration = ${Object.keys(sorted).length}; test sha256 ${sha}`,
);
