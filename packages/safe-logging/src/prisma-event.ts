import { firstLine, templateText } from './template.js';

/**
 * Prisma's own log events (`log: [{ emit: 'event', level }]` + `$on`), reduced to an allowlisted record.
 *
 * A Prisma `error` event carries the full failure text: the invocation, a source excerpt that includes the query ARGUMENTS,
 * and a final line quoting the rejected value. Printing it (Prisma's default `stdout` logging does exactly that) writes the
 * caller's value to the console. This reduces an event to: level, target, the invocation operation, the source location
 * (file:line:col, no excerpt), the Prisma code, and one templated line. `query` events keep only their duration — the SQL
 * text and its parameters are never emitted.
 */

export interface PrismaLogEventLike {
  readonly message?: unknown;
  readonly target?: unknown;
  readonly duration?: unknown;
}

export interface SafePrismaLog {
  readonly level: 'query' | 'info' | 'warn' | 'error';
  readonly target?: string;
  readonly operation?: string;
  readonly site?: string;
  readonly code?: string;
  readonly durationMs?: number;
  readonly message: string;
}

const TARGET_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const OPERATION_RE = /^[A-Za-z0-9_$.()]{1,100}$/;
const SITE_RE = /^[\w$.@/-]{1,200}:\d{1,6}:\d{1,6}$/;
const CODE_RE = /\b(P\d{4})\b/;

function lastContentLine(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? (lines[lines.length - 1] ?? '') : '';
}

export function summarizePrismaLogEvent(
  level: SafePrismaLog['level'],
  event: PrismaLogEventLike,
): SafePrismaLog {
  try {
    const target =
      typeof event.target === 'string' && TARGET_RE.test(event.target) ? event.target : undefined;
    if (level === 'query') {
      const d =
        typeof event.duration === 'number' && Number.isFinite(event.duration)
          ? Math.round(event.duration)
          : undefined;
      return {
        level,
        ...(target ? { target } : {}),
        ...(d !== undefined ? { durationMs: d } : {}),
        message: 'query',
      };
    }
    const raw = typeof event.message === 'string' ? event.message.slice(0, 20_000) : '';
    const invocation = /Invalid `([^`\n]{1,100})` invocation/.exec(raw);
    const operation =
      invocation?.[1] !== undefined && OPERATION_RE.test(invocation[1]) ? invocation[1] : undefined;
    const siteMatch = /invocation in\s*\r?\n\s*(.+?):(\d{1,6}):(\d{1,6})/.exec(raw);
    let site: string | undefined;
    if (siteMatch?.[1] !== undefined) {
      const path = siteMatch[1]
        .replace(/\\/g, '/')
        .replace(/^.*?\/((?:apps|packages|tooling)\/)/, '$1');
      const candidate = `${path}:${siteMatch[2]}:${siteMatch[3]}`;
      if (SITE_RE.test(candidate)) site = candidate;
    }
    const code = CODE_RE.exec(raw)?.[1];
    // an invocation message ends with the (value-quoting) reason; anything else is one templated line
    const text = operation ? lastContentLine(raw) : firstLine(raw.trim());
    return {
      level,
      ...(target ? { target } : {}),
      ...(operation ? { operation } : {}),
      ...(site ? { site } : {}),
      ...(code ? { code } : {}),
      message: templateText(text, 200),
    };
  } catch {
    return { level, message: '[unreadable prisma log event]' };
  }
}
