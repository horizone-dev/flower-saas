/**
 * Redis Stream entry ID handling (task 2.6, CURSOR RULES #1/#4/#5). The
 * Stream entry ID is the **only** correctness cursor (ADR-0017 §3) — this
 * module is the single place that parses/compares/validates it, so every
 * caller agrees on what "malformed" and "ahead of tail" mean.
 */

const STREAM_ID_RE = /^(\d+)-(\d+)$/;

/** Parses a Redis Stream entry id ("<ms>-<seq>") into its two integer parts,
 *  or `null` if it is not syntactically a Stream id at all. */
function parseStreamId(id: string): [bigint, bigint] | null {
  const m = STREAM_ID_RE.exec(id);
  if (!m) return null;
  try {
    return [BigInt(m[1]!), BigInt(m[2]!)];
  } catch {
    return null;
  }
}

/** CURSOR RULE #4 — a client-supplied cursor that is not a syntactically
 *  valid Stream id must be rejected outright (a protocol error), never
 *  silently coerced or treated as "no cursor". */
export function isValidStreamId(id: string): boolean {
  return parseStreamId(id) !== null;
}

/** `-1` / `0` / `1`, like a normal comparator. Throws if either argument is
 *  not a valid Stream id — callers must validate with `isValidStreamId`
 *  first; this function never guesses at a malformed value's meaning. */
export function compareStreamIds(a: string, b: string): number {
  const pa = parseStreamId(a);
  const pb = parseStreamId(b);
  if (!pa || !pb) {
    throw new Error(`compareStreamIds: not a valid Stream id (${JSON.stringify({ a, b })})`);
  }
  const [ams, aseq] = pa;
  const [bms, bseq] = pb;
  if (ams !== bms) return ams < bms ? -1 : 1;
  if (aseq !== bseq) return aseq < bseq ? -1 : 1;
  return 0;
}

export const STREAM_ID_ZERO = '0-0';
