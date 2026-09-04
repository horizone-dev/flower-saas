'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeAccess } from '@flower/api-client';
import {
  posApi,
  getAccessToken,
  bootstrapSession,
  signOut as endSession,
  errorMessage,
  ApiError,
} from '@/lib/auth';

function scopeText(scope: 'ALL' | string[]): string {
  return scope === 'ALL' ? 'ALL' : scope.length ? scope.join(', ') : 'none';
}

export default function MyAccessPage() {
  const router = useRouter();
  const [access, setAccess] = useState<MeAccess | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      // a tab reload drops the in-memory access token — re-bootstrap it from
      // the HttpOnly refresh cookie before giving up.
      if (!getAccessToken() && !(await bootstrapSession())) {
        if (!cancelled) router.replace('/login');
        return;
      }
      try {
        const data = await posApi().meAccess();
        if (!cancelled) setAccess(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // access token expired mid-session — one refresh + retry
          if (await bootstrapSession()) {
            try {
              const data = await posApi().meAccess();
              if (!cancelled) setAccess(data);
              return;
            } catch {
              /* fall through to sign-out */
            }
          }
          await endSession();
          if (!cancelled) router.replace('/login');
          return;
        }
        if (!cancelled) setError(errorMessage(err));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function signOut(): void {
    void endSession().finally(() => router.replace('/login'));
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
