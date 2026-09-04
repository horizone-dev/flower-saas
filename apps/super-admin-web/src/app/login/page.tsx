'use client';

import { useActionState } from 'react';
import { login } from './actions';
import { Field, ErrorText } from '@/components/ui';

export default function LoginPage() {
  const [error, formAction, pending] = useActionState(login, undefined);

  return (
    <main className="login-wrap">
      <p className="muted" style={{ letterSpacing: '0.08em' }}>
        FLOWER SAAS · CONTROL PLANE
      </p>
      <h1 style={{ margin: '0.25rem 0 1.25rem' }}>Super Admin</h1>
      <form action={formAction} className="stack">
        <Field label="Email" name="email" type="email" required />
        <Field label="Password" name="password" type="password" required />
        <Field label="Authenticator code (TOTP)" name="code" placeholder="123456" />
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <ErrorText message={error} />
      </form>
    </main>
  );
}
