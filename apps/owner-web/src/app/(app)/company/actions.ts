'use server';

import { redirect } from 'next/navigation';
import { setSelectedCompany } from '@/lib/org';

/** only ever return to a path inside this app */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
    ? next
    : '/products';
}

export async function selectCompanyAction(form: FormData): Promise<void> {
  const id = String(form.get('companyId') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect('/company');
  await setSelectedCompany(id);
  redirect(safeNext(String(form.get('next') ?? '/products')));
}
