'use client';

import type { ReactNode } from 'react';
import { useActionState } from 'react';
import { provisionTenant } from './actions';
import { ErrorText } from '@/components/ui';

export function ProvisionForm({
  children,
}: {
  versionOptions: { value: string; label: string }[];
  children: ReactNode;
}) {
  const [error, action, pending] = useActionState(provisionTenant, undefined);
  return (
    <form action={action} className="stack">
      <div className="grid-forms">{children}</div>
      <div className="row gap">
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? 'Provisioning…' : 'Provision'}
        </button>
        <ErrorText message={error} />
      </div>
    </form>
  );
}
