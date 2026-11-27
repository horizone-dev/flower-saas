/**
 * The ONE reviewed PostgreSQL image reference for staging (read by preflight.mjs and check-release.mjs; smoke-local.sh reads the same
 * file). The pin lives in `postgres-image.pin` so a version change is a one-line, reviewable diff — never an edit on a server.
 *
 *   PG_PINNED  postgres:17.<minor>@sha256:<64 hex>   the only shape a real staging deployment may use. The digest is required because
 *                                                    even a full patch tag is MUTABLE: Docker rebuilds `postgres:17.11` for base-OS fixes.
 *   PG_TAG     postgres:17.<minor>                   additionally accepted ONLY by `preflight.mjs --local` rehearsals.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PG_PINNED = /^postgres:17\.\d+@sha256:[0-9a-f]{64}$/;
export const PG_TAG = /^postgres:17\.\d+$/;
export const PIN_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'postgres-image.pin',
);

/** First non-empty, non-comment line of the pin file; null when the file is missing or holds no reference. */
export function readPostgresPin() {
  let text;
  try {
    text = readFileSync(PIN_FILE, 'utf8');
  } catch {
    return null;
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  return line ?? null;
}
