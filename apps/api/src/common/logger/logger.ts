import pino, { type Logger } from 'pino';
import { loadConfig } from '../../config/env.js';

/**
 * Root pino logger. Structured JSON in production; pretty in development.
 * Secrets / PII must never reach a log line (redaction paths grow per phase).
 */
export function createRootLogger(): Logger {
  const cfg = loadConfig();
  const redact = {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.secret',
      '*.token',
      '*.secret_blob_ref',
    ],
    censor: '[redacted]',
  };

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
