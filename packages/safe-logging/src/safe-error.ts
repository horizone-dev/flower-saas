import { firstLine, templateText } from './template.js';

/**
 * Secure, fail-closed error serialization.
 *
 * An error is NEVER serialized from its own properties. The result is built only from allowlisted, shape-validated
 * fields, so nothing the caller controlled (a rejected value inside `message`, the header line of `stack`, the free-form
 * `meta` of a database error, a `cause` carrying its own message) reaches a log sink unless it passes an explicit check:
 *
 *   type      the error class name (identifier-shaped)
 *   code      a short upper-case code (`P2007`, `ECONNRESET`, `22P02`)
 *   sqlstate  the PostgreSQL SQLSTATE when one is derivable
 *   operation the Prisma invocation (`tx.user.findUnique()`), never its arguments
 *   model     the Prisma model name
 *   target    constraint / column identifiers of a unique violation
 *   message   a SAFE template: a sentence built from the fields above for database errors, or the first line of the
 *             message with quoted spans, tokens, e-mails and digit runs replaced (see `template.ts`) for everything else
 *   frames    stack-frame LOCATIONS only (`Class.method (packages/db/src/x.ts:12:3)`), never the stack header
 *   cause / errors   the same shape, recursively and depth-limited
 *
 * Everything else — arbitrary enumerable properties, `meta` values, response bodies attached by libraries — is dropped.
 */

export interface SafeError {
  readonly type: string;
  readonly code?: string;
  readonly sqlstate?: string;
  readonly operation?: string;
  readonly model?: string;
  readonly target?: readonly string[];
  readonly message: string;
  readonly frames: readonly string[];
  readonly cause?: SafeError;
  readonly errors?: readonly SafeError[];
}

/** objects produced by this module — makes serialization idempotent without trusting any look-alike object */
const PRODUCED = new WeakSet<object>();
export const isSafeError = (v: unknown): v is SafeError =>
  typeof v === 'object' && v !== null && PRODUCED.has(v);

const MAX_DEPTH = 3;
const MAX_FRAMES = 12;
const MAX_AGGREGATE = 5;
const MAX_TARGETS = 5;

const IDENT_RE = /^[A-Za-z_$][\w$.-]{0,79}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9_.-]{0,39}$/;
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const PRISMA_CODE_RE = /^P\d{4}$/;
const OPERATION_RE = /^[A-Za-z0-9_$.()]{1,100}$/;
const INVOCATION_RE = /Invalid `([^`\n]{1,100})` invocation/;
const FRAME_RE = /^[\w$.<>\s:/\-@()[\]+#,]*$/;

const get = (obj: unknown, key: string): unknown => {
  try {
    return typeof obj === 'object' && obj !== null
      ? (obj as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined; // a throwing getter must not break logging
  }
};

const pick = (value: unknown, re: RegExp): string | undefined =>
  typeof value === 'string' && re.test(value) ? value : undefined;

function errorLike(value: unknown): boolean {
  return (
    value instanceof Error ||
    (typeof value === 'object' && value !== null && typeof get(value, 'message') === 'string')
  );
}

function typeOf(value: unknown): string {
  const name = pick(get(value, 'name'), IDENT_RE);
  if (name) return name;
  const ctor = pick(get(get(value, 'constructor'), 'name'), IDENT_RE);
  return ctor ?? 'Error';
}

function codeOf(value: unknown): string | undefined {
  const code = get(value, 'code');
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 99999)
    return String(code);
  return pick(code, CODE_RE);
}

function sqlstateOf(value: unknown): string | undefined {
  const meta = get(value, 'meta');
  const viaAdapter = get(get(get(meta, 'driverAdapterError'), 'cause'), 'originalCode');
  const candidates = [viaAdapter, get(meta, 'code'), get(value, 'code')];
  for (const c of candidates) {
    const s = pick(c, SQLSTATE_RE);
    if (s && !PRISMA_CODE_RE.test(s)) return s;
  }
  return undefined;
}

function isPrismaError(value: unknown, type: string, code: string | undefined): boolean {
  return (
    type.startsWith('PrismaClient') ||
    (code !== undefined && PRISMA_CODE_RE.test(code) && get(value, 'clientVersion') !== undefined)
  );
}

function operationOf(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const m = INVOCATION_RE.exec(message.slice(0, 400));
  return m?.[1] !== undefined ? pick(m[1], OPERATION_RE) : undefined;
}

function targetsOf(meta: unknown): string[] | undefined {
  const t = get(meta, 'target');
  const list = Array.isArray(t) ? t : t === undefined ? [] : [t];
  const out = list.slice(0, MAX_TARGETS).flatMap((x) => {
    const s = pick(x, /^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
    return s ? [s] : [];
  });
  return out.length > 0 ? out : undefined;
}

/** stack-frame LOCATIONS: the `at …` lines only, repo-relative, charset-checked, capped */
export function framesOf(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  const frames: string[] = [];
  let started = false;
  for (const line of stack.split('\n')) {
    const m = /^\s+at\s+(.*)$/.exec(line);
    if (!m) {
      if (started) break; // frames are one contiguous block after the header
      continue;
    }
    started = true;
    let frame = (m[1] ?? '').replace(/\\/g, '/').replace(/file:\/\/\/?/g, '');
    // an absolute location (a drive, a home directory, a checkout path that may contain spaces) → repo-relative
    frame = frame.replace(
      /(^|\()(?:[A-Za-z]:)?[^()]*?\/((?:apps|packages|node_modules|tooling)\/)/g,
      '$1$2',
    );
    frame = frame.length > 160 ? `${frame.slice(0, 160)}…` : frame;
    if (FRAME_RE.test(frame)) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function build(value: unknown, depth: number): SafeError {
  if (isSafeError(value)) return value;
  if (!errorLike(value)) {
    const base =
      typeof value === 'string'
        ? { type: 'string', message: templateText(firstLine(value.slice(0, 1000))) }
        : typeof value === 'object' && value !== null
          ? { type: 'object', message: '[non-error object]' }
          : { type: typeof value, message: '[non-error value]' };
    return { ...base, frames: [] };
  }
  const type = typeOf(value);
  const code = codeOf(value);
  const rawMessage = get(value, 'message');
  const meta = get(value, 'meta');
  const prisma = isPrismaError(value, type, code);
  const operation = prisma ? operationOf(rawMessage) : undefined;
  const sqlstate = sqlstateOf(value);
  const model = prisma ? pick(get(meta, 'modelName'), IDENT_RE) : undefined;
  const target = prisma ? targetsOf(meta) : undefined;
  // database errors: the message is BUILT from allowlisted fields (their text embeds the rejected value and a source excerpt)
  const message = prisma
    ? `Prisma ${code ?? 'error'}${operation ? ` on ${operation}` : ''}`
    : typeof rawMessage === 'string'
      ? templateText(firstLine(rawMessage.slice(0, 2000)))
      : '';
  const out: {
    -readonly [K in keyof SafeError]: SafeError[K];
  } = { type, message, frames: framesOf(get(value, 'stack')) };
  if (code) out.code = code;
  if (sqlstate) out.sqlstate = sqlstate;
  if (operation) out.operation = operation;
  if (model) out.model = model;
  if (target) out.target = target;
  if (depth < MAX_DEPTH) {
    const cause = get(value, 'cause');
    if (cause !== undefined && cause !== null) out.cause = build(cause, depth + 1);
    const errors = get(value, 'errors');
    if (Array.isArray(errors) && errors.length > 0) {
      out.errors = errors.slice(0, MAX_AGGREGATE).map((e) => build(e, depth + 1));
    }
  }
  return out;
}

/** Serialize ANY value that was logged as an error. Total: it never throws and never returns a raw error property. */
export function serializeSafeError(value: unknown): SafeError {
  try {
    const result = build(value, 0);
    PRODUCED.add(result);
    return result;
  } catch {
    const fallback: SafeError = { type: 'Error', message: '[unserializable error]', frames: [] };
    PRODUCED.add(fallback);
    return fallback;
  }
}
