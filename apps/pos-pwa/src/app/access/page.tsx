'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeAccess } from '@flower/api-client';
import { posApi, getToken, clearTokens, errorMessage, ApiError } from '@/lib/auth';

function scopeText(scope: 'ALL' | string[]): string {
  return scope === 'ALL' ? 'ALL' : scope.length ? scope.join(', ') : 'none';
}

export default function MyAccessPage() {
  const router = useRouter();
  const [access, setAccess] = useState<MeAccess | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    posApi()
      .meAccess()
      .then(setAccess)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          clearTokens();
          router.replace('/login');
          return;
        }
        setError(errorMessage(err));
      });
  }, [router]);

  function signOut() {
    posApi()
      .logout()
      .catch(() => undefined)
      .finally(() => {
        clearTokens();
        router.replace('/login');
      });
  }

  return (
    <main className="content" style={{ maxWidth: '38rem', margin: '0 auto' }}>
      <header className="page-header">
        <h1>My access</h1>
        <button className="btn" onClick={signOut}>
          Sign out
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {!access && !error ? <p className="muted">Loading…</p> : null}

      {access ? (
        <>
          <section className="card">
            <h2>Scope</h2>
            <p>
              Role type: <strong>{access.accountType ?? '—'}</strong>
            </p>
            <p>Plan: {access.planKey ?? '—'}</p>
            <p>Company scope: {scopeText(access.companyScope)}</p>
            <p>Branch scope: {scopeText(access.branchScope)}</p>
            <p>Entitled modules: {access.entitledModules.join(', ') || 'none'}</p>
          </section>

          <section className="card">
            <h2>Permissions ({access.permissions.length})</h2>
            <div className="tag-list">
              {access.permissions.length ? (
                [...access.permissions].sort().map((k) => (
                  <span key={k} className="badge badge--neutral">
                    {k}
                  </span>
                ))
              ) : (
                <span className="muted">none</span>
              )}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
