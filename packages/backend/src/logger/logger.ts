import pino, { type Logger } from 'pino';
import { loadBackendConfig } from '../config/backend-env.js';

/**
 * Log-redaction paths. Secrets / PII must never reach a log line; the list grows
 * per phase. The secrets-vault entries (task 1.10) are belt-and-braces — the
 * plaintext credential is never placed on a logged object in the first place.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.secret_blob_ref',
  '*.plaintext',
  '*.secretCiphertext',
  '*.secretNonce',
  '*.dekWrapped',
  '*.masterKey',
  'SECRETS_MASTER_KEY',
];

/**
 * Root pino logger. Structured JSON in production; pretty in development. Shared
 * by every runtime that consumes `@flower/backend`.
 *
 * Pretty-printing spawns pino's `pino-pretty` transport **worker thread**, which
 * resolves the target module relative to *this file's* location — i.e. inside
 * `packages/backend`, not the caller's package. `@flower/backend` deliberately
 * does not depend on `pino-pretty` (a dev-only pretty-printer has no business in
 * a shared framework package's dependency graph); `apps/worker` /
 * `apps/scheduler` use `@flower/service-runtime`'s own `createLogger` instead,
 * which resolves `pino-pretty` from the caller as before. `rootLogger` below
 * stays lazy specifically so that merely *importing* `@flower/backend` (for
 * `DbService` etc.) never constructs a logger — only an actual caller of
 * `rootLogger`/`createRootLogger` (currently: `apps/api`, which does carry
 * `pino-pretty`) pays that cost.
 */
export function createRootLogger(): Logger {
  const cfg = loadBackendConfig();
  const redact = { paths: [...REDACT_PATHS], censor: '[redacted]' };

  if (cfg.NODE_ENV === 'development') {
    return pino({
      level: cfg.LOG_LEVEL,
      redact,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  }
  return pino({ level: cfg.LOG_LEVEL, redact });
}

let lazyInstance: Logger | undefined;
function getRootLogger(): Logger {
  lazyInstance ??= createRootLogger();
  return lazyInstance;
}

/**
 * A drop-in `Logger` that defers construction to first use (see the note on
 * `createRootLogger` above). Every property/method access forwards to the real
 * pino instance, methods bound to it so pino's internal `this` stays correct.
 */
export const rootLogger: Logger = new Proxy({} as Logger, {
  get(_target, prop, _receiver): unknown {
    const instance = getRootLogger();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
