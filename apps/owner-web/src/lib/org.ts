import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, serverApi } from './api';
import { exponentForCurrency } from './catalog-forms';

/** run a server-side API read; an expired or missing session sends the owner back to sign in */
export async function guarded<T>(fn: () => Promise<T>, next = '/products'): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    // a step-up-gated read (e.g. the organisation lists): ask for a fresh authenticator code, then come back
    if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED')
      redirect(`/step-up?next=${encodeURIComponent(next)}`);
    throw err;
  }
}

export interface OwnerOrg {
  companyId: string;
  companyName: string;
  currency: string;
  exponent: number;
  branches: { id: string; name: string; timezone?: string }[];
}

/** the company the owner is working in (a first-party cookie; the API still checks every request against the session's scope) */
const COMPANY_COOKIE = 'ow_company';

export async function setSelectedCompany(companyId: string): Promise<void> {
  (await cookies()).set(COMPANY_COOKIE, companyId, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

/**
 * The owner's company and its branches. A workspace with ONE company uses it; a workspace with several MUST pick one first (`/company`) —
 * Owner Web never guesses, because a price or product written to the wrong company is a real financial mistake.
 */
export async function ownerOrg(next = '/products'): Promise<OwnerOrg> {
  const api = serverApi();
  const [companies, branches] = await guarded(
    () => Promise.all([api.listOrgCompanies(), api.listOrgBranches()]),
    next,
  );
  if (companies.length === 0) throw new Error('This workspace has no company yet.');
  const chosen = (await cookies()).get(COMPANY_COOKIE)?.value;
  const company = companies.length === 1 ? companies[0] : companies.find((c) => c.id === chosen);
  if (!company) redirect(`/company?next=${encodeURIComponent(next)}`);
  const currency = company.defaultCurrency ?? 'AED';
  return {
    companyId: company.id,
    companyName: company.legalNameEn,
    currency,
    exponent: exponentForCurrency(currency),
    branches: branches
      .filter((b) => b.companyId === company.id)
      .map((b) => ({ id: b.id, name: b.name, ...(b.timezone ? { timezone: b.timezone } : {}) })),
  };
}

/** Next implements `redirect()` by throwing; a `catch` block must let that through, never report it as an error */
export function rethrowRedirect(err: unknown): void {
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) throw err;
}
