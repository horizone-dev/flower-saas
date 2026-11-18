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
        <a href="/products">Products</a>
        <a href="/stock">Branch stock</a>
        <a href="/customers">Customers</a>
        <a href="/receivables">Who owes us</a>
        <a href="/reports">Sales report</a>
        <a href="/company">Company</a>
        <a href="/security">Security</a>
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
