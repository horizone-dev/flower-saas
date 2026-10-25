import { isSafeError, serializeSafeError } from './safe-error.js';
import { sanitizeLogMessage } from './template.js';

/**
 * pino integration (structural types only — this package has no runtime dependency, pino included).
 *
 * Spread `safePinoOptions()` into the options of EVERY pino logger factory. It closes the three ways an error object
 * reaches a log line:
 *
 *   1. under the `err` key       → `serializers.err`
 *   2. under ANY other key, or nested inside a logged object/array (`{ error }`, `{ cause }`, `{ failures: [e1, e2] }`)
 *                                → `formatters.log`, which runs before the serializers
 *   3. as the FIRST ARGUMENT (`logger.error(err)`) — pino then also copies `err.message` into the `msg` field → `hooks.logMethod`
 *
 * and it templates every string message argument and `%s` interpolation argument (an interpolated application message).
 * Fail-closed: any error value is replaced by the allowlisted `SafeError` shape; nothing raw is passed through.
 */

export interface SafePinoOptions {
  readonly serializers: { readonly err: (value: unknown) => unknown };
  readonly formatters: {
    readonly log: (object: Record<string, unknown>) => Record<string, unknown>;
  };
  readonly hooks: {
    readonly logMethod: (
      this: unknown,
      args: unknown[],
      method: { apply(thisArg: unknown, args: unknown[]): unknown },
    ) => void;
  };
}

const MAX_DEPTH = 5;
const MAX_KEYS = 64;
const MAX_ITEMS = 64;

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** copy of `value` in which every Error (at any depth, under any key) is replaced by its safe serialization */
function scrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Error || isSafeError(value)) return serializeSafeError(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return value instanceof Error ? serializeSafeError(value) : '[max depth]';
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.slice(0, MAX_ITEMS).map((v) => scrub(v, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value; // Buffer, Date, class instances that are not errors: left to pino
  seen.add(value);
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (n++ >= MAX_KEYS) break;
    out[key] = scrub((value as Record<string, unknown>)[key], depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

export function safePinoOptions(): SafePinoOptions {
  return {
    serializers: { err: (value) => serializeSafeError(value) },
    formatters: {
      log: (object) => scrub(object, 0, new WeakSet()) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const out = [...args];
        let first = 0;
        if (out[0] instanceof Error) {
          const safe = serializeSafeError(out[0]);
          out[0] = { err: safe };
          // pino would otherwise copy the RAW err.message into `msg`
          if (typeof out[1] !== 'string') out.splice(1, 0, safe.message);
          first = 1;
        } else if (typeof out[0] === 'object' && out[0] !== null) {
          first = 1;
        }
        for (let i = first; i < out.length; i++) {
          const arg = out[i];
          if (typeof arg === 'string') out[i] = sanitizeLogMessage(arg);
          else if (arg instanceof Error) out[i] = serializeSafeError(arg).message; // an Error used as a %s argument
        }
        method.apply(this, out);
      },
    },
  };
}
