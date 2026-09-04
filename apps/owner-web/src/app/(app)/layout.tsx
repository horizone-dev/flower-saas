import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAccessToken } from '@/lib/session';
import { logout } from '../login/actions';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await getAccessToken())) redirect('/login');

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">OWNER</div>
        <a href="/access">My access</a>
        <form action={logout}>
          <button className="btn" type="submit">
            Sign out
          </button>
        </form>
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}
