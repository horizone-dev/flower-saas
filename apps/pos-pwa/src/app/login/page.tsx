'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { anonApi, setTokens, errorMessage } from '@/lib/auth';

export default function PosLoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    const f = new FormData(e.currentTarget);
    try {
      const api = anonApi();
      const res = await api.tenantLogin({
        workspaceSlug: String(f.get('workspaceSlug') ?? '').trim(),
        email: String(f.get('email') ?? '').trim(),
        password: String(f.get('password') ?? ''),
      });
      let accessToken = res.accessToken;
      let refreshToken = res.refreshToken;
      if (res.status === 'mfa_required') {
        const code = String(f.get('code') ?? '').trim();
        if (!code) {
          setError('Multi-factor code required.');
          setPending(false);
          return;
        }
        const v = await api.verifyMfa({ mfaChallenge: res.mfaChallenge ?? '', code });
        accessToken = v.accessToken;
        refreshToken = v.refreshToken;
      }
      if (!accessToken) {
        setError('Login failed.');
        setPending(false);
        return;
      }
      setTokens(accessToken, refreshToken);
      router.replace('/access');
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <main className="login-wrap">
      <p className="muted" style={{ letterSpacing: '0.08em' }}>
        FLOWER SAAS · POS
      </p>
      <h1 style={{ margin: '0.25rem 0 1.25rem' }}>Sign in</h1>
      <form onSubmit={onSubmit} className="stack">
        <label className="field">
          <span>Workspace</span>
          <input name="workspaceSlug" placeholder="acme-florist" required />
        </label>
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" required />
        </label>
        <label className="field">
          <span>Authenticator code (if enabled)</span>
          <input name="code" placeholder="123456" inputMode="numeric" />
        </label>
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </main>
  );
}
