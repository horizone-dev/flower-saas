import { redirect } from 'next/navigation';
import { ApiError, errorMessage, serverApi } from '@/lib/api';
import { Card, PageHeader } from '@/components/ui';
import { Enrol } from './enrol';

export const dynamic = 'force-dynamic';

/** Account security: set up the authenticator (TOTP) that this account is asked for at sign-in and before sensitive screens. */
export default async function SecurityPage() {
  try {
    await serverApi().me(); // an expired session goes to sign-in, not to a half-rendered page
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    return (
      <>
        <PageHeader title="Security" />
        <p className="error">{errorMessage(err)}</p>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Security" subtitle="Sign-in protection for your account" />
      <Card>
        <p data-testid="mfa-status">
          Set up an authenticator app so that a stolen password is not enough to sign in as you. You
          do this once, right after your first sign-in.
        </p>
      </Card>
      <Enrol />
    </>
  );
}
