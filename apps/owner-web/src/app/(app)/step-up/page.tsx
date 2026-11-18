'use client';

import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { stepUpAction } from './actions';
import { ErrorText, Field, PageHeader } from '@/components/ui';

/** a fresh authenticator code, required before the organisation settings and other sensitive screens open */
export default function StepUpPage() {
  const next = useSearchParams().get('next') ?? '/products';
  const [error, formAction, pending] = useActionState(stepUpAction, undefined);
  return (
    <>
      <PageHeader
        title="Confirm it is you"
        subtitle="This screen needs a fresh code from your authenticator app."
      />
      <form action={formAction} className="stack" style={{ maxWidth: '22rem' }}>
        <input type="hidden" name="next" value={next} />
        <Field label="Authenticator code" name="code" placeholder="123456" required />
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Confirm'}
        </button>
        <ErrorText message={error} />
      </form>
    </>
  );
}
