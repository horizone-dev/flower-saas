import { cookies } from 'next/headers';
import type { Locale } from '@flower/i18n';
import { LOCALE_COOKIE, localeOf } from './i18n';

/** the shopper's language, read on the server so the very first paint already has the right language and direction */
export async function getLocale(): Promise<Locale> {
  return localeOf((await cookies()).get(LOCALE_COOKIE)?.value);
}

/** only ever return to a path inside this site (never an absolute or protocol-relative URL) */
export function safeReturnPath(referer: string | null): string {
  if (!referer) return '/';
  try {
    const u = new URL(referer);
    const path = `${u.pathname}${u.search}`;
    return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
  } catch {
    return '/';
  }
}
