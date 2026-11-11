import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Phase 3B closure — the ONE controlled mechanism by which the frozen "no migration 50 / schema unchanged" structural pins admit the
 * owner-approved RB-1 A2 addition (decision 2026-11-11: anonymous credit note). It does not relax them: every frozen pin still proves,
 * byte for byte, that the 49 frozen migrations and the frozen part of `schema.prisma` are unchanged, and THIS file pins the authorised
 * addition itself by content hash, so it cannot silently grow or change.
 *
 *  - `withoutAuthorizedMigrations(names)`  — drops exactly the authorised migration directories from a listing; every frozen count /
 *    last-migration pin then applies to the remaining 49 unchanged;
 *  - `frozenSchemaText(raw)` / `frozenSchemaShaOfFile(path)` — `schema.prisma` with the single marked authorised block removed, which
 *    must hash to the frozen value the pins already hold.
 *
 * The addition is verified by `phase3b-authorized-additions.structural.test.ts` (content hashes, additive-only SQL, scalar-only models).
 * Phase 4 carries its own, separate mechanism (`frozen-baseline.ts`) on its own branch; the two are reconciled when the branches merge.
 */
export interface AuthorizedMigration {
  readonly name: string;
  /** SHA-256 of the migration.sql content with LF line endings */
  readonly sha256: string;
}

export const PHASE_3B_AUTHORIZED_MIGRATIONS: readonly AuthorizedMigration[] = Object.freeze([
  {
    name: '20261105120000_phase_3b_rb1_anonymous_credit_note',
    // re-pinned 2026-11-12 (twice): the migration (never applied or pushed) gained the F-4 commit-time status ↔ posting guards and a read-only
    // platform grant (52693cf2…ab1c → d12edf2b…b242), then the independent review added a pinned search_path on every guard function (a
    // temporary-table shadowing bypass was demonstrated and closed) and made an outcome ATTRIBUTED (d12edf2b…b242 → this hash).
    sha256: 'c172db11ddc02aeb6c3aa1ac3362c28e45c8872d8f207ef3bcfbc6fbb3e58d00',
  },
]);

export const SCHEMA_BLOCK_BEGIN = '// ═══ PHASE 3B RB-1 A2 — BEGIN';
export const SCHEMA_BLOCK_END = '// ═══ PHASE 3B RB-1 A2 — END ═══';
/** SHA-256 of the authorised schema block text (from the BEGIN marker line to the END marker line inclusive, LF) */
export const AUTHORIZED_SCHEMA_BLOCK_SHA256 =
  'c8ff3ba0649d98c7574e4ffff80e3cf43afa1ef599c22f2c233920988f78b6bf';

const lf = (s: string): string => s.replace(/\r\n/g, '\n');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** a migrations-directory listing without the authorised migration(s) — what every frozen "exactly 49" pin must see */
export function withoutAuthorizedMigrations(names: readonly string[]): string[] {
  const authorised = new Set(PHASE_3B_AUTHORIZED_MIGRATIONS.map((m) => m.name));
  return names.filter((n) => !authorised.has(n));
}

/** the authorised block of `schema.prisma` (BEGIN line … END line), or null when absent */
export function authorizedSchemaBlock(raw: string): string | null {
  const text = lf(raw);
  const b = text.indexOf(SCHEMA_BLOCK_BEGIN);
  if (b < 0) return null;
  const e = text.indexOf(SCHEMA_BLOCK_END, b);
  if (e < 0) return null;
  return text.slice(b, e + SCHEMA_BLOCK_END.length);
}

/**
 * `schema.prisma` with the authorised block (and the one blank line that precedes it) removed — the frozen text. The input is
 * returned unchanged when there is no block, so a pin on the untouched file behaves exactly as before.
 */
export function frozenSchemaText(raw: string): string {
  const text = lf(raw);
  const block = authorizedSchemaBlock(text);
  if (block === null) return raw;
  const b = text.indexOf(block);
  const before = text.slice(0, b).replace(/\n$/, ''); // the blank separator line
  const after = text.slice(b + block.length).replace(/^\n/, '');
  return before + after;
}

/** SHA-256 of the frozen part of a schema file (LF-normalised only when a block was removed; a file without one hashes as its raw bytes) */
export function frozenSchemaShaOfFile(path: string): string {
  const raw = readFileSync(path, 'utf8');
  if (authorizedSchemaBlock(raw) === null) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return sha256(frozenSchemaText(raw));
}

export function sha256OfBlock(block: string): string {
  return sha256(lf(block));
}

export function sha256OfMigrationSql(content: string): string {
  return sha256(lf(content));
}
