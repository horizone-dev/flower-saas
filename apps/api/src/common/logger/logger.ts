import pino, { type Logger } from 'pino';
import { loadConfig } from '../../config/env.js';

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
 * Root pino logger. Structured JSON in production; pretty in development.
 */
export function createRootLogger(): Logger {
  const cfg = loadConfig();
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

export const rootLogger = createRootLogger();
