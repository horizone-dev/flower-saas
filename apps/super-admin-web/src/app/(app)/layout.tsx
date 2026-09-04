import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAccessToken } from '@/lib/session';
import { logout } from '../login/actions';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await getAccessToken())) redirect('/login');

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">SUPER ADMIN</div>
        <Link href="/tenants">Tenants</Link>
        <Link href="/plans">Plans</Link>
        <Link href="/audit">Audit</Link>
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
