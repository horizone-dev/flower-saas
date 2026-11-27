'use client';

import { Suspense, useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { login } from './actions';
import { Field, ErrorText } from '@/components/ui';

/** shown after the authenticator was confirmed (the Security screen redirects here with ?mfa=enabled) */
function EnabledNotice() {
  if (useSearchParams().get('mfa') !== 'enabled') return null;
  return (
    <p className="banner" role="status" data-testid="mfa-enabled-notice">
      Authenticator confirmed. Sign in with your password and the 6-digit code from the app.
    </p>
  );
}

export default function LoginPage() {
  const [error, formAction, pending] = useActionState(login, undefined);

  return (
    <main className="login-wrap">
      <p className="muted" style={{ letterSpacing: '0.08em' }}>
        FLOWER SAAS
      </p>
      <h1 style={{ margin: '0.25rem 0 1.25rem' }}>Owner sign in</h1>
      <Suspense fallback={null}>
        <EnabledNotice />
      </Suspense>
      <form action={formAction} className="stack">
        <Field label="Workspace" name="workspaceSlug" placeholder="acme-florist" required />
        <Field label="Email" name="email" type="email" required />
        <Field label="Password" name="password" type="password" required />
        <Field label="Authenticator code (if enabled)" name="code" placeholder="123456" />
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <ErrorText message={error} />
      </form>
    </main>
  );
}
