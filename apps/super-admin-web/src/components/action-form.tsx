'use client';

import type { ReactNode } from 'react';
import { useActionState } from 'react';
import { ErrorText } from './ui';

type ActionFn = (prev: string | undefined, formData: FormData) => Promise<string | undefined>;

/** A `<form>` bound to a Server Action that returns an error string (or
 *  undefined on success). Renders the error inline and disables while pending. */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  hidden,
  className = 'stack',
  children,
}: {
  action: ActionFn;
  submitLabel: string;
  pendingLabel?: string;
  hidden?: Record<string, string>;
  className?: string;
  children: ReactNode;
}) {
  const [error, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className}>
      {hidden
        ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)
        : null}
      {children}
      <div className="row gap">
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? (pendingLabel ?? 'Working…') : submitLabel}
        </button>
        <ErrorText message={error} />
      </div>
    </form>
  );
}
