'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LOCALE_COOKIE, localeOf } from '@/lib/i18n';
import { safeReturnPath } from '@/lib/locale';

/** switch the storefront language: remember it in a first-party cookie and come back to the page the shopper was on */
export async function setLocaleAction(form: FormData): Promise<void> {
  const next = localeOf(String(form.get('locale') ?? ''));
  (await cookies()).set(LOCALE_COOKIE, next, {
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env['NODE_ENV'] === 'production',
  });
  redirect(safeReturnPath((await headers()).get('referer')));
}
